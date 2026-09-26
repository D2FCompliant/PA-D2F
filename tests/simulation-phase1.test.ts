import { describe, expect, it, vi } from "vitest";
import { route, validateCanonical } from "../src/index";
import { SimulatedRemotePaAdapter, SimulationNetworkError } from "../src/simulation/adapters";
import { isolatedSimulationTenant, PA_INTEGRATION_REQUESTS, SIMULATION_TENANTS, simulationFlags, type SimulationExecution } from "../src/simulation/contracts";
import { assertSyntheticFixture, canonicalHappyPathFixture } from "../src/simulation/fixtures";
import { executePhaseOneScenario, type ScenarioStore, type ScenarioTransactionRecord } from "../src/simulation/service";
import type { StoredResponse } from "../src/types";

const enabledEnv = {
  APP_VERSION: "0.7.0",
  ENVIRONMENT: "development",
  EXTERNAL_NETWORK_DISABLED: "true",
  API_KEY_HEADER: "x-api-key",
  DGFiP_BASELINE: "3.2",
  CBM_VERSION: "2.1.0",
  PA_DUAL_NODE_SIMULATION: "true",
  DIRECTORY_SIMULATOR: "true",
  PPF_SIMULATOR: "false",
  LIFECYCLE_SIMULATION: "false",
} as unknown as Env;

class MemoryScenarioStore implements ScenarioStore {
  readonly idempotency = new Map<string, { fingerprint: string; response: StoredResponse }>();
  readonly transactions = new Map<string, ScenarioTransactionRecord>();
  readonly runs: SimulationExecution[] = [];

  async findIdempotency(connectionId: string, operation: string, key: string) {
    return this.idempotency.get(`${connectionId}:${operation}:${key}`) ?? null;
  }

  async saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse) {
    this.idempotency.set(`${connectionId}:${operation}:${key}`, { fingerprint, response });
  }

  async getTransaction(transactionId: string, connectionId: string) {
    const transaction = this.transactions.get(transactionId);
    return transaction?.connectionId === connectionId ? transaction : null;
  }

  async createTransactionIfAbsent(transaction: ScenarioTransactionRecord) {
    const stored = this.transactions.get(transaction.transactionId) ?? transaction;
    this.transactions.set(transaction.transactionId, stored);
    return stored;
  }

  async createRun(execution: SimulationExecution) {
    if (!this.runs.some((item) => item.executionRunId === execution.executionRunId)) this.runs.push(execution);
  }

  async getExecutionRun(executionRunId: string, connectionId: string) {
    const execution = this.runs.find((item) => item.executionRunId === executionRunId);
    const transaction = execution ? this.transactions.get(execution.transactionId) : undefined;
    return transaction?.connectionId === connectionId ? execution ?? null : null;
  }

  async getTrace(transactionId: string, connectionId: string) {
    const transaction = await this.getTransaction(transactionId, connectionId);
    if (!transaction) return null;
    const { canonicalTransaction: _canonicalTransaction, ...safeTransaction } = transaction;
    const runs = this.runs.filter((item) => item.transactionId === transactionId);
    return { transaction: safeTransaction, runs, messages: runs.flatMap((item) => item.steps) };
  }
}

function text(value: unknown): string {
  return JSON.stringify(value);
}

describe("Phase 1 simulation foundation", () => {
  it("keeps every new feature flag off by default and preserves the 0.6.0 health behavior", async () => {
    const flagsOff = { ...enabledEnv, PA_DUAL_NODE_SIMULATION: "false", DIRECTORY_SIMULATOR: "false" } as unknown as Env;
    expect(simulationFlags(flagsOff)).toEqual({
      dualNodeSimulation: false,
      directorySimulator: false,
      ppfSimulator: false,
      lifecycleSimulation: false,
    });

    const disabled = await route(new Request("https://sandbox.invalid/sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions", {
      method: "POST",
      headers: { authorization: "Bearer enterprise-test", "x-d2f-connection-id": "test-connection", "idempotency-key": "phase-1-disabled-key" },
    }), { ...flagsOff, ENTERPRISE_BEARER_TOKEN: "enterprise-test" } as unknown as Env);
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ error: { code: "PA_SIMULATION_FEATURE_DISABLED" } });

    const health = await route(new Request("https://sandbox.invalid/health"), flagsOff);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "0.7.0", externalNetworkDisabled: true });
  });

  it("provides a synthetic happy-path fixture compatible with the current canonical validator", () => {
    const fixture = canonicalHappyPathFixture();
    expect(() => assertSyntheticFixture(fixture)).not.toThrow();
    expect(validateCanonical(fixture)).toEqual([]);
    expect(fixture).toMatchObject({
      type: "INVOICE",
      seller: { organizationId: "TEST-FR-SELLER-001", address: { countryCode: "FR" } },
      buyer: { organizationId: "TEST-FR-BUYER-001", address: { countryCode: "FR" } },
      routing: { electronicAddress: { scheme: "0225", provenance: "DIRECTORY_SIMULATED" } },
      document: { invoice: { billingMode: "B1", operationCategory: "SERVICES" } },
    });
    expect(text(fixture).toLowerCase()).not.toContain("d2f compliant d.o.o");
  });

  it("isolates PAE and PAR as two logical tenants on one shared runtime", async () => {
    const store = new MemoryScenarioStore();
    const response = await executePhaseOneScenario({
      env: enabledEnv,
      store,
      connectionId: "test-connection",
      initiatingTenantId: "REAL-BUSINESS-TENANT-MUST-NOT-BE-USED",
      idempotencyKey: "phase-1-isolation-key",
      correlationId: "correlation-fixed",
      validateCanonical,
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      scenarioId: "DEMO-FR-PIPELINE-001",
      correlationId: "correlation-fixed",
      validation: { category: "REAL_REGULATORY_VALIDATION", boundary: "SIMULATION_BOUNDARY" },
      interoperability: { category: "SIMULATED_EXTERNAL_INTEROPERABILITY", externalPpfConnected: false, externalPaConnected: false },
      nodes: [
        { tenantId: "D2F-PAE-SIM", role: "PAE", endpoint: "sim://pae" },
        { tenantId: "D2F-PAR-SIM", role: "PAR", endpoint: "sim://par" },
      ],
    });
    expect(store.transactions.size).toBe(1);
    const stored = [...store.transactions.values()][0]!;
    expect(stored.initiatingTenantId).toBe(SIMULATION_TENANTS.pae);
    expect(stored.paeTenantId).not.toBe(stored.parTenantId);
    expect(text(response.body)).not.toContain("REAL-BUSINESS-TENANT-MUST-NOT-BE-USED");
    expect(await store.getTransaction(stored.transactionId, "another-connection")).toBeNull();
  });

  it("is idempotent and replays a transaction with a new run but the same business and correlation IDs", async () => {
    const store = new MemoryScenarioStore();
    const first = await executePhaseOneScenario({ env: enabledEnv, store, connectionId: "connection-a", initiatingTenantId: "business-a", idempotencyKey: "phase-1-idempotent-01", validateCanonical });
    const duplicate = await executePhaseOneScenario({ env: enabledEnv, store, connectionId: "connection-a", initiatingTenantId: "business-a", idempotencyKey: "phase-1-idempotent-01", validateCanonical });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ transactionId: first.body.transactionId, correlationId: first.body.correlationId, executionRunId: first.body.executionRunId, idempotentReplay: true });
    expect(store.transactions.size).toBe(1);
    expect(store.runs).toHaveLength(1);

    store.idempotency.clear();
    const recoveredRetry = await executePhaseOneScenario({ env: enabledEnv, store, connectionId: "connection-a", initiatingTenantId: "business-a", idempotencyKey: "phase-1-idempotent-01", validateCanonical });
    expect(recoveredRetry.body.transactionId).toBe(first.body.transactionId);
    expect(recoveredRetry.body.executionRunId).toBe(first.body.executionRunId);
    expect(store.transactions.size).toBe(1);
    expect(store.runs).toHaveLength(1);

    const replay = await executePhaseOneScenario({
      env: enabledEnv,
      store,
      connectionId: "connection-a",
      initiatingTenantId: "business-a",
      idempotencyKey: "phase-1-execution-replay",
      transactionId: String(first.body.transactionId),
      validateCanonical,
    });
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.correlationId).toBe(first.body.correlationId);
    expect(replay.body.executionRunId).not.toBe(first.body.executionRunId);
    expect(store.transactions.size).toBe(1);
    expect(store.runs).toHaveLength(2);
  });

  it("rejects a real Business tenant as a data-access key and preserves the Serbian profile boundary", () => {
    expect(isolatedSimulationTenant("D2F-COMPLIANT-DOO-RS-SEF")).toBe("D2F-PAE-SIM");
    expect(SIMULATION_TENANTS).toEqual({ pae: "D2F-PAE-SIM", par: "D2F-PAR-SIM" });
    expect(text(canonicalHappyPathFixture())).not.toMatch(/RS_SEF|D2F Compliant d\.o\.o\./i);
  });

  it("blocks an accidental external adapter target before fetch can run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const adapter = new SimulatedRemotePaAdapter(true);
    await expect(adapter.deliver({
      transactionId: "transaction",
      correlationId: "correlation",
      executionRunId: "run",
      endpoint: "https://external-pa.invalid/v1/invoices",
      payload: {},
    })).rejects.toMatchObject<Partial<SimulationNetworkError>>({ code: "EXTERNAL_NETWORK_BLOCKED" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps all four unavailable shared-contract boundaries explicit", () => {
    expect(PA_INTEGRATION_REQUESTS).toEqual([
      "PA_INTEGRATION_REQUEST_REGULATORY_RESULT",
      "PA_INTEGRATION_REQUEST_READINESS",
      "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME",
      "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    ]);
  });
});
