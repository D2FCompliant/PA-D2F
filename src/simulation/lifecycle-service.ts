import { sha256Hex } from "../crypto";
import { nextInvoiceStates } from "../lifecycle";
import type { InvoiceState, StoredResponse } from "../types";
import {
  SIMULATION_NODES,
  SIMULATION_SCENARIO_ID,
  simulationFlags,
  type SimulationExecution,
  type SimulationLifecycleActor,
  type SimulationLifecycleEvent,
} from "./contracts";
import {
  collectLifecycleEvents,
  LifecycleSimulationError,
  resumeLifecyclePropagation,
  simulateLifecycleTransition,
} from "./lifecycle-simulator";
import type { ScenarioStore, ScenarioTrace } from "./service";
import { uuidFromHex } from "./service";

export class LifecycleServiceError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_CONFLICT"
      | "LIFECYCLE_FEATURE_DISABLED"
      | "LIFECYCLE_TRANSITION_UNAVAILABLE"
      | "LIFECYCLE_WRONG_ACTOR"
      | "LIFECYCLE_OUT_OF_SEQUENCE"
      | "LIFECYCLE_FINAL_STATE_REACHED"
      | "LIFECYCLE_DUPLICATE_EVENT_CONFLICT"
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

export type LifecycleEventRequest = {
  actor?: string;
  previousState?: string;
  nextState?: string;
  eventType?: string;
  eventId?: string;
  payload?: Record<string, unknown>;
  interruptAfter?: "PAR_RECEIVED";
  resumeFromExecutionRunId?: string;
};

export async function executeLifecycleEvent(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  transactionId: string;
  idempotencyKey: string;
  request: LifecycleEventRequest;
}): Promise<StoredResponse> {
  if (!simulationFlags(input.env).lifecycleSimulation) {
    throw new LifecycleServiceError("LIFECYCLE_FEATURE_DISABLED", "Lifecycle simulation is disabled for this environment.");
  }
  const operation = `sandbox.lifecycle.${input.transactionId}.emit`;
  const fingerprint = await sha256Hex(JSON.stringify(input.request));
  const replay = await input.store.findIdempotency(input.connectionId, operation, input.idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new LifecycleServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another lifecycle request.");
    return { status: 200, body: { ...replay.response.body, idempotentReplay: true } };
  }

  const transaction = await input.store.getTransaction(input.transactionId, input.connectionId);
  if (!transaction) throw new LifecycleServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The simulation transaction does not exist in this connection scope.");
  const trace = await input.store.getTrace(input.transactionId, input.connectionId);
  if (!trace) throw new LifecycleServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The simulation trace does not exist in this connection scope.");
  const executionRunId = uuidFromHex(await sha256Hex(`${input.connectionId}:${operation}:${input.idempotencyKey}:run`));

  if (input.request.resumeFromExecutionRunId) {
    return resumeInterruptedLifecycle({
      ...input,
      trace,
      operation,
      fingerprint,
      executionRunId,
      resumeFromExecutionRunId: input.request.resumeFromExecutionRunId,
    });
  }

  const currentState = deriveLifecycleState(trace);
  if (!currentState) {
    throw new LifecycleServiceError("LIFECYCLE_TRANSITION_UNAVAILABLE", "The transaction has not reached BUYER_DELIVERED.");
  }
  const requestedState = String(input.request.nextState ?? "").toUpperCase();
  if (!isKnownInvoiceState(requestedState)) {
    throw new LifecycleServiceError("LIFECYCLE_TRANSITION_UNAVAILABLE", `Unknown lifecycle state: ${requestedState || "(empty)"}.`);
  }
  const actor = String(input.request.actor ?? "").toUpperCase();
  if (!isLifecycleActor(actor)) {
    throw new LifecycleServiceError("LIFECYCLE_WRONG_ACTOR", `Unknown lifecycle actor: ${actor || "(empty)"}.`);
  }

  const existingEvents = collectLifecycleEvents(trace.messages);
  if (input.request.eventId) {
    const duplicate = existingEvents.find((event) => event.eventId === input.request.eventId);
    if (duplicate) {
      const sameEvent = duplicate.actor === actor
        && duplicate.previousState === (input.request.previousState ?? duplicate.previousState)
        && duplicate.nextState === requestedState
        && JSON.stringify(duplicate.payload) === JSON.stringify({
          ...(input.request.payload ?? {}),
          regulatoryCode: duplicate.payload.regulatoryCode ?? null,
        });
      if (!sameEvent) throw new LifecycleServiceError("LIFECYCLE_DUPLICATE_EVENT_CONFLICT", "The eventId is already associated with another lifecycle event.");
      const duplicateResponse: StoredResponse = {
        status: 200,
        body: {
          ok: true,
          duplicateEvent: true,
          transactionId: input.transactionId,
          correlationId: transaction.correlationId,
          event: duplicate,
          currentState: duplicate.nextState,
          technicalEvidenceOnly: true,
        },
      };
      await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, duplicateResponse);
      return duplicateResponse;
    }
  }
  if (isTerminalState(currentState)) {
    throw new LifecycleServiceError("LIFECYCLE_FINAL_STATE_REACHED", `${currentState} is already a final state.`);
  }
  if (input.request.previousState && input.request.previousState !== currentState) {
    throw new LifecycleServiceError(
      "LIFECYCLE_OUT_OF_SEQUENCE",
      `Expected previous state ${currentState}, received ${input.request.previousState}.`,
    );
  }

  const startSequence = maxSequence(trace);
  let transition;
  try {
    transition = await simulateLifecycleTransition({
      transactionId: input.transactionId,
      correlationId: transaction.correlationId,
      executionRunId,
      startSequence,
      previousState: currentState,
      nextState: requestedState,
      actor,
      payload: input.request.payload,
      eventId: input.request.eventId,
      requestedEventType: input.request.eventType,
      interruptAfter: input.request.interruptAfter,
    });
  } catch (error) {
    if (error instanceof LifecycleSimulationError) {
      throw new LifecycleServiceError(error.code, error.message, error.blockedBy);
    }
    throw error;
  }

  const execution = lifecycleExecution({
    transactionId: input.transactionId,
    correlationId: transaction.correlationId,
    executionRunId,
    status: transition.interrupted ? "INTERRUPTED" : "COMPLETED",
    outcomeCode: transition.interrupted ? "LIFECYCLE_INTERRUPTED_AFTER_PAR" : `LIFECYCLE_${requestedState}`,
    retryable: transition.interrupted,
    steps: transition.steps,
    events: [transition.event],
    currentState: requestedState,
  });
  await input.store.createRun(execution);
  const response = lifecycleResponse(input.env, execution, transition.event);
  await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, response);
  return response;
}

export async function getLifecycleView(
  store: ScenarioStore,
  transactionId: string,
  connectionId: string,
): Promise<Record<string, unknown> | null> {
  const trace = await store.getTrace(transactionId, connectionId);
  if (!trace) return null;
  const events = collectLifecycleEvents(trace.messages);
  return {
    transactionId,
    correlationId: trace.transaction.correlationId,
    currentState: deriveLifecycleState(trace),
    events,
    payment: {
      status: "SIMULATION_BOUNDARY",
      blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    },
    technicalEvidenceOnly: true,
  };
}

function deriveLifecycleState(trace: ScenarioTrace): InvoiceState | null {
  const events = collectLifecycleEvents(trace.messages);
  const latest = events.at(-1);
  if (latest) return latest.nextState;
  return trace.messages.some((message) => message.event === "BUYER_DELIVERED") ? "DELIVERED" : null;
}

async function resumeInterruptedLifecycle(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  transactionId: string;
  idempotencyKey: string;
  request: LifecycleEventRequest;
  trace: ScenarioTrace;
  operation: string;
  fingerprint: string;
  executionRunId: string;
  resumeFromExecutionRunId: string;
}): Promise<StoredResponse> {
  const prior = await input.store.getExecutionRun(input.resumeFromExecutionRunId, input.connectionId);
  if (!prior || prior.transactionId !== input.transactionId) {
    throw new LifecycleServiceError("SIMULATION_RUN_NOT_FOUND", "The lifecycle execution run does not exist in this connection scope.");
  }
  if (prior.outcome.code !== "LIFECYCLE_INTERRUPTED_AFTER_PAR" || !prior.outcome.retryable) {
    throw new LifecycleServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The lifecycle execution run is not replayable.");
  }
  const event = collectLifecycleEvents(prior.steps)[0];
  if (!event) throw new LifecycleServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The lifecycle execution run has no replayable event.");
  const step = resumeLifecyclePropagation({
    event,
    executionRunId: input.executionRunId,
    sequence: maxSequence(input.trace) + 1,
  });
  const execution = lifecycleExecution({
    transactionId: input.transactionId,
    correlationId: input.trace.transaction.correlationId,
    executionRunId: input.executionRunId,
    resumedFromExecutionRunId: prior.executionRunId,
    status: "COMPLETED",
    outcomeCode: `LIFECYCLE_${event.nextState}`,
    retryable: false,
    steps: [step],
    events: [event],
    currentState: event.nextState,
  });
  await input.store.createRun(execution);
  const response = lifecycleResponse(input.env, execution, event);
  await input.store.saveIdempotency(input.connectionId, input.operation, input.idempotencyKey, input.fingerprint, response);
  return response;
}

function lifecycleExecution(input: {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  resumedFromExecutionRunId?: string;
  status: SimulationExecution["status"];
  outcomeCode: string;
  retryable: boolean;
  steps: SimulationExecution["steps"];
  events: SimulationLifecycleEvent[];
  currentState: InvoiceState;
}): SimulationExecution {
  return {
    scenarioId: SIMULATION_SCENARIO_ID,
    transactionId: input.transactionId,
    correlationId: input.correlationId,
    executionRunId: input.executionRunId,
    resumedFromExecutionRunId: input.resumedFromExecutionRunId ?? null,
    environment: "SIMULATION",
    status: input.status,
    outcome: { code: input.outcomeCode, retryable: input.retryable },
    validation: {
      category: "REAL_REGULATORY_VALIDATION",
      boundary: "SIMULATION_BOUNDARY",
      status: "PASSED",
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
    lifecycle: {
      currentState: input.currentState,
      events: input.events,
      paymentBoundary: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    },
  };
}

function lifecycleResponse(env: Env, execution: SimulationExecution, event: SimulationLifecycleEvent): StoredResponse {
  return {
    status: 202,
    body: {
      ok: execution.status === "COMPLETED",
      transactionId: execution.transactionId,
      correlationId: execution.correlationId,
      executionRunId: execution.executionRunId,
      resumedFromExecutionRunId: execution.resumedFromExecutionRunId,
      status: execution.status,
      outcome: execution.outcome,
      currentState: event.nextState,
      event,
      messages: execution.steps,
      payment: {
        status: "SIMULATION_BOUNDARY",
        blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      },
      technicalEvidenceOnly: true,
      versions: { application: env.APP_VERSION, cbm: env.CBM_VERSION, scenario: "3.0.0" },
    },
  };
}

function maxSequence(trace: ScenarioTrace): number {
  return trace.messages.reduce((maximum, message) => Math.max(maximum, message.sequence), 0);
}

function isLifecycleActor(value: string): value is SimulationLifecycleActor {
  return value === "BUYER" || value === "PAR" || value === "PAE";
}

function isKnownInvoiceState(value: string): value is InvoiceState {
  return Array.isArray(nextInvoiceStates(value as InvoiceState));
}

function isTerminalState(value: InvoiceState): boolean {
  return nextInvoiceStates(value).length === 0;
}
