import { sha256Hex } from "../crypto";
import { PA_INTEGRATION_REQUESTS, type SimulationStep } from "./contracts";
import { collectLifecycleEvents } from "./lifecycle-simulator";
import { collectPpfSubmissions } from "./ppf-service";
import type { ScenarioStore, ScenarioTrace } from "./service";
import { uuidFromHex } from "./service";

export async function buildUnifiedTrace(input: {
  env: Env;
  store: ScenarioStore;
  transactionId: string;
  connectionId: string;
}): Promise<Record<string, unknown> | null> {
  const trace = await input.store.getTrace(input.transactionId, input.connectionId);
  if (!trace) return null;
  const technicalEvents = await enrichSteps(trace);
  const lifecycle = collectLifecycleEvents(trace.messages);
  const ppfSubmissions = collectPpfSubmissions(trace);
  const derived = await derivedInputEvents(trace);
  const events = [...derived, ...technicalEvents].sort((left, right) => left.order - right.order);
  const latestRun = trace.runs.at(-1) ?? null;

  return {
    overview: {
      transactionId: trace.transaction.transactionId,
      correlationId: trace.transaction.correlationId,
      scenarioId: trace.transaction.scenarioId,
      environment: "SIMULATION",
      status: latestRun?.status ?? "UNKNOWN",
      outcome: latestRun?.outcome ?? null,
      createdAt: trace.transaction.createdAt,
      technicalEvidenceOnly: true,
    },
    documentMetadata: {
      source: "SYNTHETIC_SANDBOX_FIXTURE",
      initiatingTenantId: trace.transaction.initiatingTenantId,
      paeTenantId: trace.transaction.paeTenantId,
      parTenantId: trace.transaction.parTenantId,
      rawPayloadExposed: false,
    },
    versions: {
      application: input.env.APP_VERSION,
      cbm: input.env.CBM_VERSION,
      dgfipBaseline: input.env.DGFiP_BASELINE,
      integrationHubReferenceCommit: "696249b7f53dc7b1f77f0c0ae297e332ae863c88",
    },
    controls: trace.runs.map((run) => ({ executionRunId: run.executionRunId, ...run.validation })),
    routing: events.filter((event) => ["DIRECTORY", "ROUTING", "PAR", "BUYER"].includes(event.stage)),
    lifecycle: {
      currentState: lifecycle.at(-1)?.nextState ?? (trace.messages.some((step) => step.event === "BUYER_DELIVERED") ? "DELIVERED" : null),
      events: events.filter((event) => event.stage === "LIFECYCLE"),
    },
    eReporting: ppfSubmissions.map((submission) => ({
      submissionId: submission.submissionId,
      flow: submission.flow,
      sourceMode: submission.sourceMode,
      payloadSha256: submission.payloadSha256,
      validation: submission.validation,
      validationCategory: submission.validationCategory,
    })),
    ppf: {
      role: "REGULATORY_DATA_COLLECTOR",
      invoiceRoutingRole: false,
      submissions: ppfSubmissions,
      interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY",
      externalNetworkCalled: false,
    },
    evidence: events.map((event) => ({
      messageId: event.messageId,
      executionRunId: event.executionRunId,
      stage: event.stage,
      payloadHash: event.payloadHash,
      evidenceReference: event.evidenceReference,
      timestamp: event.timestamp,
    })),
    technicalEvents: events,
    integrationRequests: {
      ...Object.fromEntries(PA_INTEGRATION_REQUESTS.map((request) => [request, "OPEN"])),
      PA_INTEGRATION_REQUEST_UI_ACCESS: "OPEN",
    },
    notices: [
      "SIMULATION ENVIRONMENT",
      "NOT AN AIFE/PPF INTEROPERABILITY TEST",
      "REAL REGULATORY VALIDATION WHEN IDENTIFIED",
      "SIMULATED EXTERNAL INTEROPERABILITY",
    ],
  };
}

export async function buildEvidenceReport(input: {
  env: Env;
  store: ScenarioStore;
  transactionId: string;
  connectionId: string;
}): Promise<Record<string, unknown> | null> {
  const trace = await buildUnifiedTrace(input);
  if (!trace) return null;
  const overview = trace.overview as Record<string, unknown>;
  return {
    reportType: "D2F_PA_SANDBOX_REGULATORY_EVIDENCE_REPORT",
    title: "D2F Regulatory Simulation — Technical Evidence Report",
    generatedAt: new Date().toISOString(),
    transactionId: overview.transactionId,
    scenarioId: overview.scenarioId,
    environment: "SIMULATION ENVIRONMENT",
    declarations: [
      "NOT AN AIFE/PPF INTEROPERABILITY TEST",
      "REAL REGULATORY VALIDATION WHEN IDENTIFIED",
      "SIMULATED EXTERNAL INTEROPERABILITY",
      "TECHNICAL SANDBOX EVIDENCE — NOT LEGAL PROOF",
    ],
    versions: trace.versions,
    controls: trace.controls,
    routing: trace.routing,
    lifecycle: trace.lifecycle,
    reporting: trace.eReporting,
    ppf: trace.ppf,
    evidenceHashes: trace.evidence,
    simulationStatus: overview.status,
    blockedDependencies: trace.integrationRequests,
  };
}

type EnrichedEvent = {
  order: number;
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  messageId: string;
  actor: string;
  eventType: string;
  stage: string;
  provenance: string;
  timestamp: string;
  payloadHash: string;
  evidenceReference: string;
  result: string;
  resultCategory: "REAL_REGULATORY_VALIDATION" | "SIMULATED_EXTERNAL_INTEROPERABILITY" | "TECHNICAL_RESULT";
  evidence: Record<string, unknown>;
};

async function enrichSteps(trace: ScenarioTrace): Promise<EnrichedEvent[]> {
  const output: EnrichedEvent[] = [];
  for (const [index, step] of trace.messages.entries()) {
    const payloadHash = await sha256Hex(JSON.stringify(step.evidence));
    const idHash = await sha256Hex(`${step.transactionId}:${step.executionRunId}:${step.sequence}:${step.event}`);
    output.push({
      order: index + 2,
      transactionId: step.transactionId,
      correlationId: step.correlationId,
      executionRunId: step.executionRunId,
      messageId: uuidFromHex(idHash),
      actor: step.actor,
      eventType: step.event,
      stage: stageFor(step),
      provenance: step.provenance,
      timestamp: step.timestamp,
      payloadHash,
      evidenceReference: `sha256:${payloadHash}`,
      result: step.result,
      resultCategory: resultCategory(step),
      evidence: step.evidence,
    });
  }
  return output;
}

async function derivedInputEvents(trace: ScenarioTrace): Promise<EnrichedEvent[]> {
  const createdAt = trace.transaction.createdAt;
  const derived = [
    { actor: "INPUT", eventType: "INPUT_ACCEPTED", stage: "INPUT", provenance: "USER_INPUT" },
    { actor: "CBM", eventType: "CBM_CANONICALIZED", stage: "CBM", provenance: "CBM_DERIVED" },
  ];
  const output: EnrichedEvent[] = [];
  for (const [index, item] of derived.entries()) {
    const evidence = { scenarioId: trace.transaction.scenarioId, synthetic: true, rawPayloadExposed: false };
    const payloadHash = await sha256Hex(JSON.stringify(evidence));
    const idHash = await sha256Hex(`${trace.transaction.transactionId}:${item.eventType}`);
    output.push({
      order: index,
      transactionId: trace.transaction.transactionId,
      correlationId: trace.transaction.correlationId,
      executionRunId: "DERIVED_TRACE",
      messageId: uuidFromHex(idHash),
      actor: item.actor,
      eventType: item.eventType,
      stage: item.stage,
      provenance: item.provenance,
      timestamp: createdAt,
      payloadHash,
      evidenceReference: `sha256:${payloadHash}`,
      result: "PASS",
      resultCategory: "TECHNICAL_RESULT",
      evidence,
    });
  }
  return output;
}

function stageFor(step: SimulationStep): string {
  if (step.event === "PAE_RECEIVED") return "PAE";
  if (step.event === "PAE_VALIDATED") return "VALIDATION";
  if (step.event.startsWith("DIRECTORY_")) return "DIRECTORY";
  if (step.event === "PAE_ROUTED") return "ROUTING";
  if (step.event.startsWith("PAR_")) return "PAR";
  if (step.event.startsWith("BUYER_")) return "BUYER";
  if (step.event.startsWith("LIFECYCLE_")) return "LIFECYCLE";
  if (step.event === "PPF_SUBMISSION_CREATED") return "E_REPORTING";
  if (step.event.startsWith("PPF_")) return "PPF";
  return "TECHNICAL";
}

function resultCategory(step: SimulationStep): EnrichedEvent["resultCategory"] {
  const category = String(step.evidence.category ?? "");
  if (category === "REAL_REGULATORY_VALIDATION") return "REAL_REGULATORY_VALIDATION";
  if (category.startsWith("SIMULATED_")) return "SIMULATED_EXTERNAL_INTEROPERABILITY";
  return "TECHNICAL_RESULT";
}
