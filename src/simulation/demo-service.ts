import { generateEReportingDocuments } from "../e-reporting-ingest";
import type { StoredResponse } from "../types";
import { b2cEReportingFixture, crossBorderEReportingFixture, invalidCanonicalFixture, maticDemoFixture } from "./fixtures";
import { executeLifecycleEvent, LifecycleServiceError } from "./lifecycle-service";
import { executePpfSubmission } from "./ppf-service";
import { executePhaseTwoScenario, type ScenarioStore } from "./service";

export const DEMO_SCENARIOS = [
  { id: "DEMO-FR-001", title: "France domestic complete path", expected: "LIFECYCLE_APPROVED", payment212: "SIMULATION_BOUNDARY" },
  { id: "DEMO-FR-002", title: "Canonical invoice validation error", expected: "CANONICAL_VALIDATION_FAILED" },
  { id: "DEMO-FR-003", title: "Directory entry not found", expected: "DIRECTORY_NOT_FOUND" },
  { id: "DEMO-FR-004", title: "Lifecycle through APPROVED", expected: "LIFECYCLE_APPROVED" },
  { id: "DEMO-FR-005", title: "France to foreign with Flux 10.1", expected: "D2F_PPF_ACCEPTED" },
  { id: "DEMO-FR-006", title: "France B2C with Flux 10.3", expected: "D2F_PPF_ACCEPTED" },
  { id: "DEMO-FR-007", title: "PPF reject, correction and idempotent replay", expected: "REJECTED_THEN_ACCEPTED" },
  { id: "DEMO-FR-008", title: "Temporary PAR failure and resume", expected: "RESUMED" },
  { id: "DEMO-FR-009", title: "Invalid lifecycle transition", expected: "LIFECYCLE_TRANSITION_UNAVAILABLE" },
  { id: "DEMO-FR-010", title: "Payment and status 212 boundary", expected: "SIMULATION_BOUNDARY" },
  { id: "MATIC-DEMO", title: "Synthetic Matic Consulting integration journey", expected: "D2F_PPF_ACCEPTED" },
] as const;

export type DemoScenarioId = typeof DEMO_SCENARIOS[number]["id"];

export function isDemoScenarioId(value: string): value is DemoScenarioId {
  return DEMO_SCENARIOS.some((scenario) => scenario.id === value);
}

export async function executeDemoScenario(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  initiatingTenantId: string;
  idempotencyKey: string;
  scenarioId: DemoScenarioId;
  correlationId?: string;
  validateCanonical: (value: Record<string, unknown>) => unknown[];
}): Promise<StoredResponse> {
  const key = (suffix: string) => `${input.idempotencyKey}:${suffix}`;
  const pipelineEnv = ["DEMO-FR-009", "DEMO-FR-010"].includes(input.scenarioId)
    ? ({ ...input.env, LIFECYCLE_SIMULATION: "false" } as Env)
    : input.env;
  const canonicalFixture = input.scenarioId === "DEMO-FR-002"
    ? invalidCanonicalFixture()
    : input.scenarioId === "MATIC-DEMO" ? maticDemoFixture() : undefined;
  const firstOptions = input.scenarioId === "DEMO-FR-003"
    ? { directoryIdentifier: "TEST-FR-NOT-FOUND" }
    : input.scenarioId === "DEMO-FR-008" ? { remotePaOutcome: "TEMPORARY_FAILURE" as const } : undefined;

  let pipeline = await executePhaseTwoScenario({
    env: pipelineEnv,
    store: input.store,
    connectionId: input.connectionId,
    initiatingTenantId: input.initiatingTenantId,
    idempotencyKey: key("pipeline"),
    validateCanonical: input.validateCanonical,
    scenarioId: input.scenarioId,
    correlationId: input.correlationId,
    canonicalFixture,
    options: firstOptions,
  });
  const transactionId = String(pipeline.body.transactionId);
  const actions: Array<Record<string, unknown>> = [{ stage: "PIPELINE", status: pipeline.body.status, outcome: pipeline.body.outcome }];

  if (input.scenarioId === "DEMO-FR-008") {
    pipeline = await executePhaseTwoScenario({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      initiatingTenantId: input.initiatingTenantId,
      idempotencyKey: key("pipeline-retry"),
      validateCanonical: input.validateCanonical,
      scenarioId: input.scenarioId,
      transactionId,
      options: { resumeFromExecutionRunId: String(pipeline.body.executionRunId) },
    });
    actions.push({ stage: "PAR_RETRY", status: pipeline.body.status, outcome: pipeline.body.outcome, resumedFromExecutionRunId: pipeline.body.resumedFromExecutionRunId });
  }

  if (["DEMO-FR-005", "MATIC-DEMO"].includes(input.scenarioId)) {
    const ppf = await executePpfSubmission({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      transactionId,
      idempotencyKey: key("ppf-101"),
      request: { mode: "GENERATE", flow: "10.1", canonicalBatch: crossBorderEReportingFixture() },
    });
    actions.push({ stage: "E_REPORTING_10_1", status: ppf.body.status, outcome: ppf.body.outcome });
  }

  if (input.scenarioId === "DEMO-FR-006") {
    const ppf = await executePpfSubmission({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      transactionId,
      idempotencyKey: key("ppf-103"),
      request: { mode: "GENERATE", flow: "10.3", canonicalBatch: b2cEReportingFixture() },
    });
    actions.push({ stage: "E_REPORTING_10_3", status: ppf.body.status, outcome: ppf.body.outcome });
  }

  if (input.scenarioId === "DEMO-FR-007") {
    const valid = generateEReportingDocuments(crossBorderEReportingFixture())[0]!.xml;
    const invalid = valid.replace("<CurrencyCode>EUR</CurrencyCode>", "");
    const rejected = await executePpfSubmission({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      transactionId,
      idempotencyKey: key("ppf-rejected"),
      request: { mode: "PROVIDED_PAYLOAD", flow: "10.1", payload: invalid },
    });
    const corrected = await executePpfSubmission({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      transactionId,
      idempotencyKey: key("ppf-corrected"),
      request: { mode: "PROVIDED_PAYLOAD", flow: "10.1", payload: valid },
    });
    const replay = await executePpfSubmission({
      env: input.env,
      store: input.store,
      connectionId: input.connectionId,
      transactionId,
      idempotencyKey: key("ppf-corrected"),
      request: { mode: "PROVIDED_PAYLOAD", flow: "10.1", payload: valid },
    });
    actions.push(
      { stage: "PPF_REJECT", outcome: rejected.body.outcome },
      { stage: "PPF_CORRECTION", outcome: corrected.body.outcome },
      { stage: "PPF_REPLAY", idempotentReplay: replay.body.idempotentReplay === true },
    );
  }

  if (input.scenarioId === "DEMO-FR-009") {
    actions.push(await captureLifecycleBoundary(input, transactionId, key("invalid-lifecycle"), {
      actor: "PAE", previousState: "DELIVERED", nextState: "APPROVED", payload: { synthetic: true },
    }));
  }

  if (input.scenarioId === "DEMO-FR-010") {
    actions.push(await captureLifecycleBoundary(input, transactionId, key("payment-212"), {
      actor: "BUYER", previousState: "DELIVERED", nextState: "PAID", payload: { synthetic: true },
    }));
  }

  if (["DEMO-FR-001", "DEMO-FR-004"].includes(input.scenarioId)) {
    actions.push({
      stage: "DOMESTIC_REGULATORY_REPORTING",
      status: "SIMULATION_BOUNDARY",
      blockedBy: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT",
      note: "No public domestic reporting result contract is exposed; no payload is invented.",
    });
  }

  return {
    status: 202,
    body: {
      ok: true,
      scenarioId: input.scenarioId,
      transactionId,
      correlationId: pipeline.body.correlationId,
      executionRunId: pipeline.body.executionRunId,
      status: "DEMO_COMPLETED",
      actions,
      traceUrl: `/sandbox/v1/transactions/${transactionId}/trace`,
      evidenceReportUrl: `/sandbox/v1/transactions/${transactionId}/evidence-report`,
      technicalEvidenceOnly: true,
    },
  };
}

async function captureLifecycleBoundary(
  input: Parameters<typeof executeDemoScenario>[0],
  transactionId: string,
  idempotencyKey: string,
  request: { actor: string; previousState: string; nextState: string; payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  try {
    const response = await executeLifecycleEvent({ ...input, transactionId, idempotencyKey, request });
    return { stage: "LIFECYCLE_NEGATIVE", unexpectedSuccess: true, outcome: response.body.outcome };
  } catch (error) {
    if (error instanceof LifecycleServiceError) {
      return { stage: request.nextState === "PAID" ? "PAYMENT_212" : "LIFECYCLE_NEGATIVE", status: error.code, blockedBy: error.blockedBy ?? null };
    }
    throw error;
  }
}
