import { describe, expect, it, vi } from "vitest";
import { validateCanonical } from "../src/index";
import {
  SimulatedBuyerAdapter,
  SimulatedDirectoryAdapter,
  SimulationNetworkError,
} from "../src/simulation/adapters";
import type { SimulationExecution } from "../src/simulation/contracts";
import {
  executePhaseTwoScenario,
  type ScenarioStore,
  type ScenarioTrace,
  type ScenarioTransactionRecord,
} from "../src/simulation/service";
import type { StoredResponse } from "../src/types";

const enabledEnv = {
  APP_VERSION: "0.7.0",
  ENVIRONMENT: "sandbox",
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

  async getExecutionRun(executionRunId: string, connectionId: string) {
    const execution = this.runs.find((item) => item.executionRunId === executionRunId);
    const transaction = execution ? this.transactions.get(execution.transactionId) : undefined;
    return transaction?.connectionId === connectionId ? execution ?? null : null;
  }

  async createRun(execution: SimulationExecution) {
    if (!this.runs.some((item) => item.executionRunId === execution.executionRunId)) this.runs.push(execution);
  }

  async getTrace(transactionId: string, connectionId: string): Promise<ScenarioTrace | null> {
    const transaction = await this.getTransaction(transactionId, connectionId);
    if (!transaction) return null;
    const { canonicalTransaction: _canonicalTransaction, ...safeTransaction } = transaction;
    const runs = this.runs.filter((item) => item.transactionId === transactionId);
    return { transaction: safeTransaction, runs, messages: runs.flatMap((item) => item.steps) };
  }
}

function request(store: ScenarioStore, idempotencyKey: string, extra: Partial<Parameters<typeof executePhaseTwoScenario>[0]> = {}) {
  return executePhaseTwoScenario({
    env: enabledEnv,
    store,
    connectionId: "phase-2-connection",
    initiatingTenantId: "REAL-BUSINESS-TENANT-MUST-NOT-BE-USED",
    idempotencyKey,
    validateCanonical,
    ...extra,
  });
}

describe("Phase 2 regulatory simulation", () => {
  it("resolves FOUND and every deterministic directory error with simulated provenance", async () => {
    const directory = new SimulatedDirectoryAdapter();
    await expect(directory.resolve({ scheme: "0225", value: "TEST-FR-BUYER-001" })).resolves.toMatchObject({
      status: "FOUND",
      provenance: "DIRECTORY_SIMULATED",
      destinationPa: "D2F-PAR-SIM",
    });
    const cases = [
      ["0225", "TEST-FR-NOT-FOUND", "NOT_FOUND"],
      ["bad", "TEST-FR-BUYER-001", "INVALID_IDENTIFIER"],
      ["0225", "TEST-FR-NO-ROUTING", "NO_ACTIVE_ROUTING"],
      ["0225", "TEST-FR-MULTIPLE", "MULTIPLE_ADDRESSES"],
      ["0225", "TEST-FR-PA-NOT-FOUND", "PA_NOT_FOUND"],
      ["0225", "TEST-FR-ADDRESS-DISABLED", "ADDRESS_DISABLED"],
      ["0225", "TEST-FR-TEMPORARY", "TEMPORARY_ERROR"],
    ] as const;
    for (const [scheme, value, status] of cases) {
      const result = await directory.resolve({ scheme, value });
      expect(result).toMatchObject({ status, provenance: "DIRECTORY_SIMULATED", destinationPa: null });
    }
  });

  it("persists the complete PAE to Directory to PAR to Buyer message sequence", async () => {
    const store = new MemoryScenarioStore();
    const response = await request(store, "phase-2-happy-path-001", { correlationId: "phase-2-correlation" });
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: "COMPLETED", outcome: { code: "BUYER_DELIVERED" }, correlationId: "phase-2-correlation" });
    const execution = store.runs[0]!;
    expect(execution.steps.map((step) => step.event)).toEqual([
      "PAE_RECEIVED",
      "PAE_VALIDATED",
      "DIRECTORY_LOOKUP",
      "DIRECTORY_RESOLVED",
      "PAE_ROUTED",
      "PAR_RECEIVED",
      "PAR_ACCEPTED",
      "BUYER_DELIVERED",
    ]);
    expect(execution.steps.map((step) => step.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const message of execution.steps) {
      expect(message).toMatchObject({
        transactionId: execution.transactionId,
        correlationId: execution.correlationId,
        executionRunId: execution.executionRunId,
      });
      expect(message.timestamp).toMatch(/Z$/);
    }
  });

  it("blocks before PAR when the simulated directory cannot resolve the buyer", async () => {
    const store = new MemoryScenarioStore();
    const response = await request(store, "phase-2-directory-not-found", {
      options: { directoryIdentifier: "TEST-FR-NOT-FOUND" },
    });
    expect(response.body).toMatchObject({ status: "BLOCKED", outcome: { code: "DIRECTORY_NOT_FOUND", retryable: false } });
    expect(store.runs[0]!.steps.map((step) => step.event)).toEqual([
      "PAE_RECEIVED", "PAE_VALIDATED", "DIRECTORY_LOOKUP", "DIRECTORY_NOT_FOUND",
    ]);
    expect(store.runs[0]!.steps.some((step) => step.actor === "PAR")).toBe(false);
  });

  it("persists PAR rejection and keeps temporary remote failure replayable", async () => {
    const rejectedStore = new MemoryScenarioStore();
    const rejected = await request(rejectedStore, "phase-2-par-rejected-001", { options: { remotePaOutcome: "REJECTED" } });
    expect(rejected.body).toMatchObject({ status: "REJECTED", outcome: { code: "PAR_REJECTED", retryable: false } });
    expect(rejectedStore.runs[0]!.steps.at(-1)?.event).toBe("PAR_REJECTED");

    const retryStore = new MemoryScenarioStore();
    const failed = await request(retryStore, "phase-2-remote-temporary", { options: { remotePaOutcome: "TEMPORARY_FAILURE" } });
    expect(failed.body).toMatchObject({ status: "RETRYABLE", outcome: { code: "REMOTE_PA_TEMPORARY_FAILURE", retryable: true } });
    const resumed = await request(retryStore, "phase-2-remote-resume-01", {
      transactionId: String(failed.body.transactionId),
      options: { resumeFromExecutionRunId: String(failed.body.executionRunId), remotePaOutcome: "ACCEPTED" },
    });
    expect(resumed.body).toMatchObject({ status: "COMPLETED", transactionId: failed.body.transactionId, correlationId: failed.body.correlationId });
    expect(retryStore.transactions).toHaveLength(1);
  });

  it("does not duplicate a business transaction, run or messages on an idempotent replay", async () => {
    const store = new MemoryScenarioStore();
    const first = await request(store, "phase-2-duplicate-message");
    const duplicate = await request(store, "phase-2-duplicate-message");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      idempotentReplay: true,
      transactionId: first.body.transactionId,
      executionRunId: first.body.executionRunId,
    });
    expect(store.transactions.size).toBe(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.steps).toHaveLength(8);
  });

  it("resumes after Directory and after PAR without recreating the business transaction", async () => {
    const directoryStore = new MemoryScenarioStore();
    const afterDirectory = await request(directoryStore, "phase-2-interrupt-directory", { options: { interruptAfter: "DIRECTORY_RESOLVED" } });
    const resumedDirectory = await request(directoryStore, "phase-2-resume-directory", {
      transactionId: String(afterDirectory.body.transactionId),
      options: { resumeFromExecutionRunId: String(afterDirectory.body.executionRunId) },
    });
    expect(resumedDirectory.body).toMatchObject({ status: "COMPLETED", resumedFromExecutionRunId: afterDirectory.body.executionRunId });
    expect(directoryStore.runs[1]!.steps.map((step) => step.event)).toEqual(["PAE_ROUTED", "PAR_RECEIVED", "PAR_ACCEPTED", "BUYER_DELIVERED"]);
    expect(directoryStore.runs[1]!.steps.map((step) => step.sequence)).toEqual([5, 6, 7, 8]);
    expect(directoryStore.transactions.size).toBe(1);

    const parStore = new MemoryScenarioStore();
    const afterPar = await request(parStore, "phase-2-interrupt-par-001", { options: { interruptAfter: "PAR_ACCEPTED" } });
    const resumedPar = await request(parStore, "phase-2-resume-par-0001", {
      options: { resumeFromExecutionRunId: String(afterPar.body.executionRunId) },
    });
    expect(parStore.runs[1]!.steps.map((step) => step.event)).toEqual(["BUYER_DELIVERED"]);
    expect(parStore.runs[1]!.steps[0]!.sequence).toBe(8);
    expect(resumedPar.body.transactionId).toBe(afterPar.body.transactionId);
  });

  it("returns a connection-isolated persisted trace without the canonical payload", async () => {
    const store = new MemoryScenarioStore();
    const response = await request(store, "phase-2-trace-persistence");
    const trace = await store.getTrace(String(response.body.transactionId), "phase-2-connection");
    expect(trace?.runs).toHaveLength(1);
    expect(trace?.messages).toHaveLength(8);
    expect(trace?.transaction).not.toHaveProperty("canonicalTransaction");
    expect(await store.getTrace(String(response.body.transactionId), "another-connection")).toBeNull();
    expect(JSON.stringify(trace)).not.toContain("REAL-BUSINESS-TENANT-MUST-NOT-BE-USED");
  });

  it("blocks Buyer simulator external targets without invoking fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const buyer = new SimulatedBuyerAdapter(true);
    await expect(buyer.deliver({
      transactionId: "transaction",
      correlationId: "correlation",
      executionRunId: "run",
      endpoint: "https://business.invalid/buyer",
      payload: {},
    })).rejects.toMatchObject<Partial<SimulationNetworkError>>({ code: "EXTERNAL_NETWORK_BLOCKED" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
