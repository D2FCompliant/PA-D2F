import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { route, validateCanonical } from "../src/index";
import { DEMO_SCENARIOS, executeDemoScenario, type DemoScenarioId } from "../src/simulation/demo-service";
import type { SimulationExecution } from "../src/simulation/contracts";
import {
  type ScenarioStore,
  type ScenarioTrace,
  type ScenarioTransactionRecord,
} from "../src/simulation/service";
import { buildEvidenceReport, buildUnifiedTrace } from "../src/simulation/trace-service";
import type { StoredResponse } from "../src/types";

const env = {
  DB: {} as D1Database,
  APP_VERSION: "1.0.0",
  ENVIRONMENT: "sandbox",
  EXTERNAL_NETWORK_DISABLED: "true",
  API_KEY_HEADER: "x-api-key",
  DGFiP_BASELINE: "3.2",
  CBM_VERSION: "2.1.0",
  PA_DUAL_NODE_SIMULATION: "true",
  DIRECTORY_SIMULATOR: "true",
  PPF_SIMULATOR: "true",
  LIFECYCLE_SIMULATION: "true",
} satisfies Env;

class MemoryScenarioStore implements ScenarioStore {
  readonly idempotency = new Map<string, { fingerprint: string; response: StoredResponse }>();
  readonly transactions = new Map<string, ScenarioTransactionRecord>();
  readonly runs: SimulationExecution[] = [];

  async findIdempotency(connectionId: string, operation: string, key: string) { return this.idempotency.get(`${connectionId}:${operation}:${key}`) ?? null; }
  async saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse) { this.idempotency.set(`${connectionId}:${operation}:${key}`, { fingerprint, response }); }
  async getTransaction(transactionId: string, connectionId: string) { const value = this.transactions.get(transactionId); return value?.connectionId === connectionId ? value : null; }
  async createTransactionIfAbsent(transaction: ScenarioTransactionRecord) { const value = this.transactions.get(transaction.transactionId) ?? transaction; this.transactions.set(value.transactionId, value); return value; }
  async getExecutionRun(executionRunId: string, connectionId: string) { const run = this.runs.find((value) => value.executionRunId === executionRunId); return run && this.transactions.get(run.transactionId)?.connectionId === connectionId ? run : null; }
  async createRun(execution: SimulationExecution) { if (!this.runs.some((value) => value.executionRunId === execution.executionRunId)) this.runs.push(execution); }
  async getTrace(transactionId: string, connectionId: string): Promise<ScenarioTrace | null> {
    const transaction = await this.getTransaction(transactionId, connectionId);
    if (!transaction) return null;
    const { canonicalTransaction: _canonicalTransaction, ...safeTransaction } = transaction;
    const runs = this.runs.filter((value) => value.transactionId === transactionId);
    return { transaction: safeTransaction, runs, messages: runs.flatMap((value) => value.steps) };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
});

afterEach(() => vi.useRealTimers());

async function run(scenarioId: DemoScenarioId) {
  const store = new MemoryScenarioStore();
  const response = await executeDemoScenario({
    env,
    store,
    connectionId: "final-connection",
    initiatingTenantId: "REAL-BUSINESS-TENANT-MUST-NOT-BE-USED",
    idempotencyKey: `final-${scenarioId.toLowerCase()}-0001`,
    scenarioId,
    validateCanonical,
  });
  return { store, response, transactionId: String(response.body.transactionId) };
}

describe("Final D2F Regulatory Simulation scenarios", () => {
  it("exposes the final OpenAPI contract and protects all new routes with authentication", async () => {
    const openApi = await route(new Request("https://sandbox.example/openapi.yaml"), env);
    expect(openApi.status).toBe(200);
    const contract = await openApi.text();
    expect(contract).toContain("version: 1.0.0");
    expect(contract).toContain("/sandbox/v1/scenarios/{scenarioId}/executions:");
    expect(contract).toContain("/sandbox/v1/transactions/{transactionId}/trace:");
    expect(contract).toContain("/sandbox/v1/transactions/{transactionId}/evidence-report:");

    for (const path of [
      "/sandbox/v1/scenarios",
      "/sandbox/v1/scenarios/DEMO-FR-001/executions",
      "/sandbox/v1/transactions/00000000-0000-4000-8000-000000000000/trace",
      "/sandbox/v1/transactions/00000000-0000-4000-8000-000000000000/evidence-report",
    ]) {
      const response = await route(new Request(`https://sandbox.example${path}`, { method: path.endsWith("executions") ? "POST" : "GET" }), env);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_AUTH" } });
    }
  });

  it("publishes the ten deterministic demos plus the isolated Matic fixture", () => {
    expect(DEMO_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "DEMO-FR-001", "DEMO-FR-002", "DEMO-FR-003", "DEMO-FR-004", "DEMO-FR-005",
      "DEMO-FR-006", "DEMO-FR-007", "DEMO-FR-008", "DEMO-FR-009", "DEMO-FR-010", "MATIC-DEMO",
    ]);
  });

  it.each([
    ["DEMO-FR-001", "LIFECYCLE_APPROVED"],
    ["DEMO-FR-002", "CANONICAL_VALIDATION_FAILED"],
    ["DEMO-FR-003", "DIRECTORY_NOT_FOUND"],
    ["DEMO-FR-004", "LIFECYCLE_APPROVED"],
  ] as const)("executes %s with expected pipeline outcome %s", async (scenarioId, expected) => {
    const { response } = await run(scenarioId);
    expect(response.body).toMatchObject({ ok: true, scenarioId, status: "DEMO_COMPLETED" });
    expect(JSON.stringify(response.body.actions)).toContain(expected);
  });

  it.each([
    ["DEMO-FR-005", "E_REPORTING_10_1"],
    ["DEMO-FR-006", "E_REPORTING_10_3"],
    ["MATIC-DEMO", "E_REPORTING_10_1"],
  ] as const)("executes %s through accepted PPF reporting", async (scenarioId, stage) => {
    const { response } = await run(scenarioId);
    expect(response.body).toMatchObject({ ok: true, scenarioId });
    expect(response.body.actions).toContainEqual(expect.objectContaining({ stage, outcome: expect.objectContaining({ code: "D2F_PPF_ACCEPTED" }) }));
  });

  it("runs deterministic PPF rejection, correction and idempotent replay", async () => {
    const { response } = await run("DEMO-FR-007");
    expect(response.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "PPF_REJECT", outcome: expect.objectContaining({ code: "D2F_PPF_REJECTED_XSD" }) }),
      expect.objectContaining({ stage: "PPF_CORRECTION", outcome: expect.objectContaining({ code: "D2F_PPF_ACCEPTED" }) }),
      expect.objectContaining({ stage: "PPF_REPLAY", idempotentReplay: true }),
    ]));
  });

  it("resumes the same transaction after a temporary PAR failure", async () => {
    const { response } = await run("DEMO-FR-008");
    expect(response.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "PIPELINE", outcome: expect.objectContaining({ code: "REMOTE_PA_TEMPORARY_FAILURE" }) }),
      expect.objectContaining({ stage: "PAR_RETRY", outcome: expect.objectContaining({ code: "LIFECYCLE_APPROVED" }) }),
    ]));
  });

  it("keeps invalid lifecycle and payment 212 as explicit, non-persisted failures", async () => {
    const invalid = await run("DEMO-FR-009");
    expect(invalid.response.body.actions).toContainEqual(expect.objectContaining({ stage: "LIFECYCLE_NEGATIVE", status: "LIFECYCLE_TRANSITION_UNAVAILABLE" }));

    const payment = await run("DEMO-FR-010");
    expect(payment.response.body.actions).toContainEqual(expect.objectContaining({
      stage: "PAYMENT_212",
      status: "SIMULATION_BOUNDARY",
      blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    }));
    expect(payment.store.runs.flatMap((run) => run.steps).some((step) => JSON.stringify(step).includes("212"))).toBe(false);
  });

  it("builds one sanitized auditable trace and regulatory evidence report", async () => {
    const { store, transactionId } = await run("DEMO-FR-005");
    const trace = await buildUnifiedTrace({ env, store, transactionId, connectionId: "final-connection" });
    expect(trace).toMatchObject({
      overview: { transactionId, scenarioId: "DEMO-FR-005", environment: "SIMULATION", technicalEvidenceOnly: true },
      documentMetadata: { source: "SYNTHETIC_SANDBOX_FIXTURE", rawPayloadExposed: false },
      ppf: { role: "REGULATORY_DATA_COLLECTOR", invoiceRoutingRole: false, externalNetworkCalled: false },
    });
    const events = trace!.technicalEvents as Array<Record<string, unknown>>;
    expect(events.map((event) => event.stage)).toEqual(expect.arrayContaining(["INPUT", "CBM", "PAE", "VALIDATION", "DIRECTORY", "ROUTING", "PAR", "BUYER", "LIFECYCLE", "E_REPORTING", "PPF"]));
    expect((trace!.lifecycle as { events: Array<Record<string, unknown>> }).events.every((event) => event.stage === "LIFECYCLE")).toBe(true);
    for (const event of events) {
      expect(event).toMatchObject({ transactionId, correlationId: expect.any(String), executionRunId: expect.any(String), messageId: expect.any(String), actor: expect.any(String), provenance: expect.any(String), timestamp: expect.any(String), payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/), evidenceReference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    }
    expect(JSON.stringify(trace)).not.toContain("ENTERPRISE_BEARER_TOKEN");
    expect(JSON.stringify(trace)).not.toContain("<?xml");

    const report = await buildEvidenceReport({ env, store, transactionId, connectionId: "final-connection" });
    expect(report).toMatchObject({ reportType: "D2F_PA_SANDBOX_REGULATORY_EVIDENCE_REPORT", environment: "SIMULATION ENVIRONMENT" });
    expect(report!.declarations).toEqual(expect.arrayContaining([
      "NOT AN AIFE/PPF INTEROPERABILITY TEST",
      "REAL REGULATORY VALIDATION WHEN IDENTIFIED",
      "SIMULATED EXTERNAL INTEROPERABILITY",
    ]));
  });
});
