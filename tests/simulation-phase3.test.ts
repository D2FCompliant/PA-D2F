import { describe, expect, it, vi } from "vitest";
import { validateCanonical } from "../src/index";
import { collectLifecycleEvents } from "../src/simulation/lifecycle-simulator";
import {
  executeLifecycleEvent,
  getLifecycleView,
  type LifecycleEventRequest,
} from "../src/simulation/lifecycle-service";
import type { SimulationExecution } from "../src/simulation/contracts";
import {
  executePhaseTwoScenario,
  type ScenarioStore,
  type ScenarioTrace,
  type ScenarioTransactionRecord,
} from "../src/simulation/service";
import type { StoredResponse } from "../src/types";

const baseEnv = {
  DB: {} as D1Database,
  APP_VERSION: "0.9.0",
  ENVIRONMENT: "sandbox",
  EXTERNAL_NETWORK_DISABLED: "true",
  API_KEY_HEADER: "x-api-key",
  DGFiP_BASELINE: "3.2",
  CBM_VERSION: "2.1.0",
  PA_DUAL_NODE_SIMULATION: "true",
  DIRECTORY_SIMULATOR: "true",
  PPF_SIMULATOR: "false",
  LIFECYCLE_SIMULATION: "false",
} satisfies Env;

const lifecycleEnv = { ...baseEnv, LIFECYCLE_SIMULATION: "true" } as Env;

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

async function createPipeline(store: MemoryScenarioStore, key: string, lifecycle = false) {
  return executePhaseTwoScenario({
    env: lifecycle ? lifecycleEnv : baseEnv,
    store,
    connectionId: "phase-3-connection",
    initiatingTenantId: "REAL-BUSINESS-TENANT-MUST-NOT-BE-USED",
    idempotencyKey: key,
    validateCanonical,
  });
}

async function emit(
  store: MemoryScenarioStore,
  transactionId: string,
  key: string,
  request: LifecycleEventRequest,
  env: Env = lifecycleEnv,
) {
  return executeLifecycleEvent({
    env,
    store,
    connectionId: "phase-3-connection",
    transactionId,
    idempotencyKey: key,
    request,
  });
}

describe("Phase 3 lifecycle simulation", () => {
  it("extends the pipeline through documented 203 and 205 lifecycle events back to PAR and PAE", async () => {
    const store = new MemoryScenarioStore();
    const response = await createPipeline(store, "phase-3-full-happy-path", true);
    expect(response.body).toMatchObject({
      status: "COMPLETED",
      outcome: { code: "LIFECYCLE_APPROVED" },
      lifecycle: {
        currentState: "APPROVED",
        paymentBoundary: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      },
    });
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
      "LIFECYCLE_EVENT_EMITTED",
      "LIFECYCLE_PAE_RECORDED",
      "LIFECYCLE_EVENT_EMITTED",
      "LIFECYCLE_PAR_RECEIVED",
      "LIFECYCLE_PAE_RECORDED",
    ]);
    const events = collectLifecycleEvents(execution.steps);
    expect(events.map((event) => [event.previousState, event.nextState, event.actor])).toEqual([
      ["DELIVERED", "MADE_AVAILABLE", "PAR"],
      ["MADE_AVAILABLE", "APPROVED", "BUYER"],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        transactionId: execution.transactionId,
        correlationId: execution.correlationId,
        executionRunId: execution.executionRunId,
        provenance: "REMOTE_PA_SIMULATED",
        source: "LIFECYCLE_SIMULATOR",
        contractSource: "PA_D2F_LIFECYCLE_CONTRACT",
        interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY",
      });
      expect(event.eventId).toBeTruthy();
      expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(event.evidenceReference).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(event.timestamp).toMatch(/Z$/);
    }
    for (const step of execution.steps.slice(8)) {
      expect(step.evidence).toMatchObject({
        category: "SIMULATED_LIFECYCLE",
        technicalEvidenceOnly: true,
      });
      expect(step).not.toHaveProperty("regulatoryCode");
    }
  });

  it("preserves exact 0.8.0 behavior when the lifecycle flag is off", async () => {
    const store = new MemoryScenarioStore();
    const response = await createPipeline(store, "phase-3-compatibility-080", false);
    expect(response.body).toMatchObject({ outcome: { code: "BUYER_DELIVERED" } });
    expect(store.runs[0]!.steps).toHaveLength(8);
    expect(store.runs[0]!.lifecycle).toBeUndefined();
    await expect(emit(store, String(response.body.transactionId), "phase-3-disabled-event", {
      actor: "PAR",
      nextState: "MADE_AVAILABLE",
    }, baseEnv)).rejects.toMatchObject({ code: "LIFECYCLE_FEATURE_DISABLED" });
  });

  it("rejects unknown, forbidden, out-of-sequence and wrong-actor transitions", async () => {
    const store = new MemoryScenarioStore();
    const pipeline = await createPipeline(store, "phase-3-negative-base");
    const transactionId = String(pipeline.body.transactionId);
    await expect(emit(store, transactionId, "phase-3-unknown-state", {
      actor: "BUYER",
      nextState: "UNKNOWN",
    })).rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_UNAVAILABLE" });
    await expect(emit(store, transactionId, "phase-3-forbidden-state", {
      actor: "BUYER",
      nextState: "APPROVED",
    })).rejects.toMatchObject({ code: "LIFECYCLE_TRANSITION_UNAVAILABLE" });
    await expect(emit(store, transactionId, "phase-3-out-of-sequence", {
      actor: "BUYER",
      previousState: "MADE_AVAILABLE",
      nextState: "REFUSED",
    })).rejects.toMatchObject({ code: "LIFECYCLE_OUT_OF_SEQUENCE" });
    await expect(emit(store, transactionId, "phase-3-wrong-actor", {
      actor: "BUYER",
      previousState: "DELIVERED",
      nextState: "MADE_AVAILABLE",
    })).rejects.toMatchObject({ code: "LIFECYCLE_WRONG_ACTOR" });
  });

  it("deduplicates the same lifecycle eventId and the same request replay", async () => {
    const store = new MemoryScenarioStore();
    const pipeline = await createPipeline(store, "phase-3-duplicate-base");
    const transactionId = String(pipeline.body.transactionId);
    const eventRequest = {
      eventId: "00000000-0000-4000-8000-000000000203",
      actor: "PAR",
      previousState: "DELIVERED",
      nextState: "MADE_AVAILABLE",
      payload: { note: "available" },
    };
    const first = await emit(store, transactionId, "phase-3-event-first", eventRequest);
    const requestReplay = await emit(store, transactionId, "phase-3-event-first", eventRequest);
    const duplicateEvent = await emit(store, transactionId, "phase-3-event-duplicate", eventRequest);
    expect(first.status).toBe(202);
    expect(requestReplay).toMatchObject({ status: 200, body: { idempotentReplay: true } });
    expect(duplicateEvent).toMatchObject({ status: 200, body: { duplicateEvent: true } });
    expect(store.runs).toHaveLength(2);
    expect(collectLifecycleEvents((await store.getTrace(transactionId, "phase-3-connection"))!.messages)).toHaveLength(1);
  });

  it("resumes propagation after PAR without duplicating the lifecycle event", async () => {
    const store = new MemoryScenarioStore();
    const pipeline = await createPipeline(store, "phase-3-resume-base");
    const transactionId = String(pipeline.body.transactionId);
    await emit(store, transactionId, "phase-3-made-available", {
      actor: "PAR",
      previousState: "DELIVERED",
      nextState: "MADE_AVAILABLE",
    });
    const interrupted = await emit(store, transactionId, "phase-3-interrupted-approval", {
      actor: "BUYER",
      previousState: "MADE_AVAILABLE",
      nextState: "APPROVED",
      interruptAfter: "PAR_RECEIVED",
    });
    expect(interrupted.body).toMatchObject({
      status: "INTERRUPTED",
      outcome: { code: "LIFECYCLE_INTERRUPTED_AFTER_PAR", retryable: true },
    });
    const resumed = await emit(store, transactionId, "phase-3-resumed-approval", {
      resumeFromExecutionRunId: String(interrupted.body.executionRunId),
    });
    expect(resumed.body).toMatchObject({
      status: "COMPLETED",
      currentState: "APPROVED",
      resumedFromExecutionRunId: interrupted.body.executionRunId,
    });
    expect(store.runs.at(-1)!.steps.map((step) => step.event)).toEqual(["LIFECYCLE_PAE_RECORDED"]);
    const view = await getLifecycleView(store, transactionId, "phase-3-connection");
    expect(view).toMatchObject({ currentState: "APPROVED", technicalEvidenceOnly: true });
    expect((view?.events as unknown[])).toHaveLength(2);
  });

  it("rejects a new event after a final state has been reached", async () => {
    const store = new MemoryScenarioStore();
    const pipeline = await createPipeline(store, "phase-3-final-base");
    const transactionId = String(pipeline.body.transactionId);
    await emit(store, transactionId, "phase-3-final-refused", {
      actor: "BUYER",
      previousState: "DELIVERED",
      nextState: "REFUSED",
    });
    await expect(emit(store, transactionId, "phase-3-after-final", {
      actor: "PAR",
      nextState: "MADE_AVAILABLE",
    })).rejects.toMatchObject({ code: "LIFECYCLE_FINAL_STATE_REACHED" });
  });

  it("keeps 212/payment and unavailable Country Runtime policies at explicit boundaries", async () => {
    const store = new MemoryScenarioStore();
    const pipeline = await createPipeline(store, "phase-3-boundary-base");
    const transactionId = String(pipeline.body.transactionId);
    await emit(store, transactionId, "phase-3-boundary-203", {
      actor: "PAR",
      nextState: "MADE_AVAILABLE",
    });
    await emit(store, transactionId, "phase-3-boundary-205", {
      actor: "BUYER",
      nextState: "APPROVED",
    });
    const runCountBeforePaymentBoundary = store.runs.length;
    const eventCountBeforePaymentBoundary = collectLifecycleEvents(
      (await store.getTrace(transactionId, "phase-3-connection"))!.messages,
    ).length;
    await expect(emit(store, transactionId, "phase-3-payment-boundary", {
      actor: "PAE",
      nextState: "PAID",
    })).rejects.toMatchObject({
      code: "SIMULATION_BOUNDARY",
      blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    });
    expect(store.runs).toHaveLength(runCountBeforePaymentBoundary);
    expect(collectLifecycleEvents(
      (await store.getTrace(transactionId, "phase-3-connection"))!.messages,
    )).toHaveLength(eventCountBeforePaymentBoundary);
    await expect(emit(store, transactionId, "phase-3-country-boundary", {
      actor: "PAE",
      nextState: "PROCESSING",
    })).rejects.toMatchObject({
      code: "SIMULATION_BOUNDARY",
      blockedBy: "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME",
    });
  });

  it("keeps lifecycle simulation internal and never invokes fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new MemoryScenarioStore();
    const response = await createPipeline(store, "phase-3-network-blocked", true);
    expect(response.body).toMatchObject({
      interoperability: {
        externalPpfConnected: false,
        externalDirectoryConnected: false,
        externalPaConnected: false,
      },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
