import { sha256Hex } from "../crypto";
import { validateEReporting, type EReportingFlow, type EReportingValidation } from "../e-reporting";
import { generateEReportingDocuments } from "../e-reporting-ingest";
import type { StoredResponse } from "../types";
import { SimulatedPpfReportingAdapter } from "./adapters";
import {
  SIMULATION_NODES,
  SIMULATION_SCENARIO_ID,
  simulationFlags,
  type PpfSubmissionOutcome,
  type SimulationExecution,
  type SimulationPpfSubmission,
  type SimulationStep,
} from "./contracts";
import type { ScenarioStore, ScenarioTrace } from "./service";
import { uuidFromHex } from "./service";

export type PpfSubmissionRequest = {
  mode?: "GENERATE" | "PROVIDED_PAYLOAD";
  flow?: EReportingFlow;
  canonicalBatch?: Record<string, unknown>;
  payload?: string;
  simulatedTransportOutcome?: "RECEIVED" | "TEMPORARY_ERROR";
  interruptAfter?: "BEFORE_SUBMISSION" | "AFTER_SUBMISSION" | "AFTER_RECEIPT";
  resumeFromExecutionRunId?: string;
};

export class PpfServiceError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_CONFLICT"
      | "PPF_FEATURE_DISABLED"
      | "PPF_INVALID_REQUEST"
      | "PPF_GENERATION_FAILED"
      | "SIMULATION_BOUNDARY"
      | "SIMULATION_RUN_NOT_FOUND"
      | "SIMULATION_RUN_NOT_REPLAYABLE"
      | "SIMULATION_TRANSACTION_NOT_FOUND",
    message: string,
    readonly blockedBy?: "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME" | "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
  ) {
    super(message);
  }
}

export async function executePpfSubmission(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  transactionId: string;
  idempotencyKey: string;
  request: PpfSubmissionRequest;
  now?: () => Date;
}): Promise<StoredResponse> {
  if (!simulationFlags(input.env).ppfSimulator) {
    throw new PpfServiceError("PPF_FEATURE_DISABLED", "PPF simulation is disabled for this environment.");
  }
  const operation = `sandbox.ppf.${input.transactionId}.submit`;
  const fingerprint = await sha256Hex(JSON.stringify(input.request));
  const replay = await input.store.findIdempotency(input.connectionId, operation, input.idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new PpfServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another PPF submission request.");
    return { status: 200, body: { ...replay.response.body, idempotentReplay: true } };
  }

  const transaction = await input.store.getTransaction(input.transactionId, input.connectionId);
  if (!transaction) throw new PpfServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The simulation transaction does not exist in this connection scope.");
  const trace = await input.store.getTrace(input.transactionId, input.connectionId);
  if (!trace) throw new PpfServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The simulation trace does not exist in this connection scope.");

  const executionRunId = uuidFromHex(await sha256Hex(`${input.connectionId}:${operation}:${input.idempotencyKey}:run`));
  const clock = input.now ?? (() => new Date());
  const resumed = input.request.resumeFromExecutionRunId
    ? await resumeInput(input.store, input.connectionId, input.transactionId, input.request.resumeFromExecutionRunId)
    : null;
  const prepared = resumed?.prepared ?? await prepareSubmission(input.request, clock());
  const submissionId = resumed?.submission.submissionId
    ?? uuidFromHex(await sha256Hex(`${input.transactionId}:${prepared.payloadSha256}:ppf-submission`));

  if (!resumed) {
    const duplicate = collectPpfSubmissions(trace).find((item) => item.payloadSha256 === prepared.payloadSha256 && item.flow === prepared.validation.flow);
    if (duplicate) {
      const duplicateExecution = duplicateAttemptExecution({
        transactionId: input.transactionId,
        correlationId: transaction.correlationId,
        executionRunId,
        sequence: maxSequence(trace) + 1,
        duplicate,
        timestamp: clock().toISOString(),
      });
      await input.store.createRun(duplicateExecution);
      const duplicateResponse: StoredResponse = {
        status: 200,
        body: {
          ok: false,
          transactionId: input.transactionId,
          correlationId: transaction.correlationId,
          executionRunId,
          outcome: { code: "D2F_PPF_DUPLICATE_SUBMISSION", status: "DUPLICATE_SUBMISSION", retryable: false },
          duplicateOfSubmissionId: duplicate.submissionId,
          technicalEvidenceOnly: true,
        },
      };
      await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, duplicateResponse);
      return duplicateResponse;
    }
  }

  const initialSubmission = resumed?.submission ?? await createSubmission({
    transactionId: input.transactionId,
    correlationId: transaction.correlationId,
    executionRunId,
    submissionId,
    prepared,
    timestamp: clock().toISOString(),
  });
  const previousSequence = maxSequence(trace);
  const cursor = resumed?.cursor ?? "START";
  const steps: SimulationStep[] = [];
  const add = (actor: SimulationStep["actor"], event: SimulationStep["event"], result: SimulationStep["result"], evidence: Record<string, unknown>) => {
    steps.push({
      transactionId: input.transactionId,
      correlationId: transaction.correlationId,
      executionRunId,
      sequence: previousSequence + steps.length + 1,
      actor,
      event,
      provenance: "PPF_SIMULATED",
      result,
      evidence: {
        category: "SIMULATED_EXTERNAL_INTEROPERABILITY",
        ppfRole: "REGULATORY_DATA_COLLECTOR",
        technicalEvidenceOnly: true,
        ...evidence,
      },
      timestamp: clock().toISOString(),
    });
  };

  let submission = { ...initialSubmission, executionRunId };
  if (cursor === "START") {
    add("PAE", "PPF_SUBMISSION_CREATED", "PASS", { submission: publicSubmission(submission), generation: prepared.sourceMode });
    if (input.request.interruptAfter === "BEFORE_SUBMISSION") {
      return persistExecution(input, operation, fingerprint, ppfExecution({
        submission,
        steps,
        status: "INTERRUPTED",
        outcomeCode: "PPF_INTERRUPTED_BEFORE_SUBMISSION",
        retryable: true,
        resumedFromExecutionRunId: input.request.resumeFromExecutionRunId,
      }));
    }
  }

  if (cursor === "START" || cursor === "AFTER_CREATED" || cursor === "RETRY_AFTER_TEMPORARY_ERROR") {
    submission = { ...submission, state: "SENT" };
    add("PAE", "PPF_SUBMISSION_SENT", "PASS", { submission: publicSubmission(submission), target: submission.target });
    if (input.request.interruptAfter === "AFTER_SUBMISSION") {
      return persistExecution(input, operation, fingerprint, ppfExecution({
        submission,
        steps,
        status: "INTERRUPTED",
        outcomeCode: "PPF_INTERRUPTED_AFTER_SUBMISSION",
        retryable: true,
        resumedFromExecutionRunId: input.request.resumeFromExecutionRunId,
      }));
    }
  }

  const adapter = new SimulatedPpfReportingAdapter(
    input.env.EXTERNAL_NETWORK_DISABLED === "true",
    input.request.simulatedTransportOutcome ?? "RECEIVED",
  );
  const outcome = validationOutcome(prepared.validation);
  if (cursor !== "AFTER_RECEIVED") {
    const transport = await adapter.submit({
      transactionId: input.transactionId,
      correlationId: transaction.correlationId,
      executionRunId,
      endpoint: "sim://ppf-reporting",
      payloadSha256: prepared.payloadSha256,
      validationOutcome: outcome,
    });
    if (transport.status === "TEMPORARY_ERROR") {
      submission = { ...submission, state: "SENT", outcome: "TEMPORARY_ERROR", retryable: true };
      add("PPF", "PPF_SUBMISSION_TEMPORARY_ERROR", "BLOCKED", {
        submission: publicSubmission(submission),
        error: { code: "D2F_PPF_TEMPORARY_ERROR", retryable: true },
      });
      return persistExecution(input, operation, fingerprint, ppfExecution({
        submission,
        steps,
        status: "RETRYABLE",
        outcomeCode: "D2F_PPF_TEMPORARY_ERROR",
        retryable: true,
        resumedFromExecutionRunId: input.request.resumeFromExecutionRunId,
      }));
    }
  }

  if (cursor !== "AFTER_RECEIVED") {
    submission = { ...submission, state: "RECEIVED" };
    add("PPF", "PPF_SUBMISSION_RECEIVED", "PASS", { submission: publicSubmission(submission) });
    if (input.request.interruptAfter === "AFTER_RECEIPT") {
      return persistExecution(input, operation, fingerprint, ppfExecution({
        submission,
        steps,
        status: "INTERRUPTED",
        outcomeCode: "PPF_INTERRUPTED_AFTER_RECEIPT",
        retryable: true,
        resumedFromExecutionRunId: input.request.resumeFromExecutionRunId,
      }));
    }
  }

  add("PPF", "PPF_VALIDATION_COMPLETED", outcome === "ACCEPTED" ? "PASS" : "BLOCKED", {
    validationCategory: "REAL_REGULATORY_VALIDATION",
    regulatoryBaseline: "DGFiP external specifications v3.2 (2026-04-30)",
    flow: prepared.validation.flow,
    stages: prepared.validation.stages,
    issues: prepared.validation.issues,
  });
  submission = { ...submission, state: "COMPLETED", outcome, retryable: false };
  add("PPF", outcome === "ACCEPTED" ? "PPF_SUBMISSION_ACCEPTED" : "PPF_SUBMISSION_REJECTED", outcome === "ACCEPTED" ? "PASS" : "BLOCKED", {
    submission: publicSubmission(submission),
    response: { namespace: "D2F_SANDBOX_PPF", status: outcome },
  });
  return persistExecution(input, operation, fingerprint, ppfExecution({
    submission,
    steps,
    status: outcome === "ACCEPTED" ? "COMPLETED" : "REJECTED",
    outcomeCode: `D2F_PPF_${outcome}`,
    retryable: false,
    resumedFromExecutionRunId: input.request.resumeFromExecutionRunId,
  }));
}

export async function getPpfSubmissionView(
  store: ScenarioStore,
  transactionId: string,
  connectionId: string,
): Promise<Record<string, unknown> | null> {
  const trace = await store.getTrace(transactionId, connectionId);
  if (!trace) return null;
  const submissions = collectPpfSubmissions(trace).map(publicSubmission);
  return {
    transactionId,
    correlationId: trace.transaction.correlationId,
    submissions,
    count: submissions.length,
    ppfRole: "REGULATORY_DATA_COLLECTOR",
    invoiceRoutingRole: false,
    interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY",
    externalNetworkCalled: false,
    technicalEvidenceOnly: true,
  };
}

export function collectPpfSubmissions(trace: ScenarioTrace): SimulationPpfSubmission[] {
  const submissions = new Map<string, SimulationPpfSubmission>();
  for (const run of trace.runs) {
    for (const submission of run.ppf?.submissions ?? []) submissions.set(submission.submissionId, submission);
  }
  return [...submissions.values()];
}

type PreparedSubmission = {
  sourceMode: SimulationPpfSubmission["sourceMode"];
  payloadSha256: string;
  validation: EReportingValidation;
  recordIds: string[];
};

async function prepareSubmission(request: PpfSubmissionRequest, now: Date): Promise<PreparedSubmission> {
  const mode = request.mode ?? (request.payload ? "PROVIDED_PAYLOAD" : "GENERATE");
  if (mode === "GENERATE") {
    const requestedFlow = request.flow ?? "UNKNOWN";
    if (requestedFlow === "10.2" || requestedFlow === "10.4") {
      throw new PpfServiceError(
        "SIMULATION_BOUNDARY",
        `Generation of Flux ${requestedFlow} requires the shared Payment Contract.`,
        "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      );
    }
    if (requestedFlow !== "10.1" && requestedFlow !== "10.3") {
      throw new PpfServiceError("PPF_INVALID_REQUEST", "Generated submissions require an explicitly classified Flux 10.1 or 10.3 scenario.");
    }
    if (!request.canonicalBatch) throw new PpfServiceError("PPF_INVALID_REQUEST", "canonicalBatch is required in GENERATE mode.");
    try {
      const documents = generateEReportingDocuments(request.canonicalBatch);
      const document = documents.find((item) => item.flow === requestedFlow);
      if (!document) throw new Error(`D2F_PPF_GENERATED_FLOW_NOT_FOUND:${requestedFlow}`);
      return {
        sourceMode: "GENERATED",
        payloadSha256: await sha256Hex(document.xml),
        validation: await validateEReporting(document.xml, now),
        recordIds: document.recordIds,
      };
    } catch (error) {
      throw new PpfServiceError("PPF_GENERATION_FAILED", error instanceof Error ? error.message : "The e-reporting document could not be generated.");
    }
  }
  const payload = request.payload?.trim() ?? "";
  if (!payload) throw new PpfServiceError("PPF_INVALID_REQUEST", "payload is required in PROVIDED_PAYLOAD mode.");
  const validation = await validateEReporting(payload, now);
  if (request.flow && request.flow !== "UNKNOWN" && validation.flow !== request.flow) {
    throw new PpfServiceError("PPF_INVALID_REQUEST", `The supplied payload is ${validation.flow}, not ${request.flow}.`);
  }
  return {
    sourceMode: "PROVIDED_PAYLOAD",
    payloadSha256: await sha256Hex(payload),
    validation,
    recordIds: [],
  };
}

function validationOutcome(validation: EReportingValidation): Exclude<PpfSubmissionOutcome, "DUPLICATE_SUBMISSION" | "TEMPORARY_ERROR"> {
  if (validation.flow === "UNKNOWN" || validation.issues.some((issue) => issue.code === "F10-XML-MALFORMED" || issue.code === "F10-ROOT-INVALID")) return "INVALID_PAYLOAD";
  if (validation.stages.some((stage) => stage.id === "xsd" && stage.status === "FAIL")) return "REJECTED_XSD";
  if (validation.stages.some((stage) => stage.id === "business-rules" && stage.status === "FAIL")) return "REJECTED_BUSINESS_RULE";
  return "ACCEPTED";
}

async function createSubmission(input: {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  submissionId: string;
  prepared: PreparedSubmission;
  timestamp: string;
}): Promise<SimulationPpfSubmission> {
  const evidenceReference = `sha256:${await sha256Hex(JSON.stringify({
    transactionId: input.transactionId,
    correlationId: input.correlationId,
    submissionId: input.submissionId,
    flow: input.prepared.validation.flow,
    payloadSha256: input.prepared.payloadSha256,
    timestamp: input.timestamp,
  }))}`;
  return {
    transactionId: input.transactionId,
    correlationId: input.correlationId,
    executionRunId: input.executionRunId,
    submissionId: input.submissionId,
    flow: input.prepared.validation.flow,
    sourceMode: input.prepared.sourceMode,
    payloadSha256: input.prepared.payloadSha256,
    recordIds: input.prepared.recordIds,
    state: "CREATED",
    outcome: null,
    retryable: false,
    validation: input.prepared.validation,
    provenance: "PPF_SIMULATED",
    interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY",
    validationCategory: "REAL_REGULATORY_VALIDATION",
    role: "REGULATORY_DATA_COLLECTOR",
    target: "sim://ppf-reporting",
    externalNetworkCalled: false,
    technicalEvidenceOnly: true,
    timestamp: input.timestamp,
    evidenceReference,
  };
}

function publicSubmission(submission: SimulationPpfSubmission): Omit<SimulationPpfSubmission, "validation"> & { validation: EReportingValidation | null } {
  return { ...submission };
}

function ppfExecution(input: {
  submission: SimulationPpfSubmission;
  steps: SimulationStep[];
  status: SimulationExecution["status"];
  outcomeCode: string;
  retryable: boolean;
  resumedFromExecutionRunId?: string;
}): SimulationExecution {
  const validationFailed = input.submission.validation?.issues.some((issue) => issue.severity === "error") ?? false;
  return {
    scenarioId: SIMULATION_SCENARIO_ID,
    transactionId: input.submission.transactionId,
    correlationId: input.submission.correlationId,
    executionRunId: input.submission.executionRunId,
    resumedFromExecutionRunId: input.resumedFromExecutionRunId ?? null,
    environment: "SIMULATION",
    status: input.status,
    outcome: { code: input.outcomeCode, retryable: input.retryable },
    validation: {
      category: "REAL_REGULATORY_VALIDATION",
      boundary: "SIMULATION_BOUNDARY",
      status: validationFailed ? "FAILED" : "PASSED",
      blockedContract: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT",
    },
    interoperability: {
      category: "SIMULATED_EXTERNAL_INTEROPERABILITY",
      externalPpfConnected: false,
      externalDirectoryConnected: false,
      externalPaConnected: false,
      notice: "NOT AN AIFE/PPF INTEROPERABILITY TEST",
    },
    nodes: SIMULATION_NODES,
    steps: input.steps,
    ppf: {
      submissions: [input.submission],
      paymentBoundary: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      countryRuntimeBoundary: "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME",
    },
  };
}

function duplicateAttemptExecution(input: {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  sequence: number;
  duplicate: SimulationPpfSubmission;
  timestamp: string;
}): SimulationExecution {
  const step: SimulationStep = {
    transactionId: input.transactionId,
    correlationId: input.correlationId,
    executionRunId: input.executionRunId,
    sequence: input.sequence,
    actor: "PPF",
    event: "PPF_SUBMISSION_REJECTED",
    provenance: "PPF_SIMULATED",
    result: "BLOCKED",
    evidence: {
      category: "SIMULATED_EXTERNAL_INTEROPERABILITY",
      ppfRole: "REGULATORY_DATA_COLLECTOR",
      technicalEvidenceOnly: true,
      response: { namespace: "D2F_SANDBOX_PPF", status: "DUPLICATE_SUBMISSION" },
      duplicateOfSubmissionId: input.duplicate.submissionId,
      payloadSha256: input.duplicate.payloadSha256,
    },
    timestamp: input.timestamp,
  };
  const placeholder = { ...input.duplicate, executionRunId: input.executionRunId, outcome: "DUPLICATE_SUBMISSION" as const };
  const execution = ppfExecution({
    submission: placeholder,
    steps: [step],
    status: "REJECTED",
    outcomeCode: "D2F_PPF_DUPLICATE_SUBMISSION",
    retryable: false,
  });
  return { ...execution, ppf: { ...execution.ppf!, submissions: [] } };
}

async function persistExecution(
  input: {
    env: Env;
    store: ScenarioStore;
    connectionId: string;
    transactionId: string;
    idempotencyKey: string;
  },
  operation: string,
  fingerprint: string,
  execution: SimulationExecution,
): Promise<StoredResponse> {
  await input.store.createRun(execution);
  const submission = execution.ppf?.submissions[0] ?? null;
  const response: StoredResponse = {
    status: 202,
    body: {
      ok: execution.status === "COMPLETED",
      transactionId: execution.transactionId,
      correlationId: execution.correlationId,
      executionRunId: execution.executionRunId,
      resumedFromExecutionRunId: execution.resumedFromExecutionRunId,
      status: execution.status,
      outcome: execution.outcome,
      submission: submission ? publicSubmission(submission) : null,
      messages: execution.steps,
      ppfRole: "REGULATORY_DATA_COLLECTOR",
      invoiceRoutingRole: false,
      technicalEvidenceOnly: true,
      versions: { application: input.env.APP_VERSION, dgfip: input.env.DGFiP_BASELINE, scenario: "4.0.0" },
    },
  };
  await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, response);
  return response;
}

async function resumeInput(
  store: ScenarioStore,
  connectionId: string,
  transactionId: string,
  executionRunId: string,
): Promise<{
  submission: SimulationPpfSubmission;
  prepared: PreparedSubmission;
  cursor: "AFTER_CREATED" | "AFTER_SENT" | "AFTER_RECEIVED" | "RETRY_AFTER_TEMPORARY_ERROR";
}> {
  const prior = await store.getExecutionRun(executionRunId, connectionId);
  if (!prior || prior.transactionId !== transactionId) throw new PpfServiceError("SIMULATION_RUN_NOT_FOUND", "The PPF execution run does not exist in this connection scope.");
  if (!prior.outcome.retryable) throw new PpfServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The PPF execution run is not replayable.");
  const submission = prior.ppf?.submissions[0];
  if (!submission?.validation) throw new PpfServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The PPF execution run has no replayable submission.");
  const cursor = prior.outcome.code === "PPF_INTERRUPTED_BEFORE_SUBMISSION" ? "AFTER_CREATED"
    : prior.outcome.code === "PPF_INTERRUPTED_AFTER_SUBMISSION" ? "AFTER_SENT"
      : prior.outcome.code === "PPF_INTERRUPTED_AFTER_RECEIPT" ? "AFTER_RECEIVED"
        : prior.outcome.code === "D2F_PPF_TEMPORARY_ERROR" ? "RETRY_AFTER_TEMPORARY_ERROR"
          : null;
  if (!cursor) throw new PpfServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The PPF execution run has no supported resume cursor.");
  return {
    submission,
    prepared: {
      sourceMode: submission.sourceMode,
      payloadSha256: submission.payloadSha256,
      validation: submission.validation,
      recordIds: submission.recordIds,
    },
    cursor,
  };
}

function maxSequence(trace: ScenarioTrace): number {
  return trace.messages.reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
}
