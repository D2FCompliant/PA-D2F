import { sha256Hex } from "../crypto";
import { canTransition, lifecycleEventType, REGULATORY_CODES } from "../lifecycle";
import type { InvoiceState } from "../types";
import type {
  SimulationLifecycleActor,
  SimulationLifecycleEvent,
  SimulationStep,
} from "./contracts";

export type LifecycleSimulationErrorCode =
  | "LIFECYCLE_TRANSITION_UNAVAILABLE"
  | "LIFECYCLE_WRONG_ACTOR"
  | "SIMULATION_BOUNDARY";

export class LifecycleSimulationError extends Error {
  constructor(
    readonly code: LifecycleSimulationErrorCode,
    message: string,
    readonly blockedBy?: "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME" | "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
  ) {
    super(message);
  }
}

// This is an actor policy for the already-documented status families, not a
// second transition table. Transition legality remains owned by canTransition().
const DOCUMENTED_ACTOR_BY_TARGET: Partial<Record<InvoiceState, SimulationLifecycleActor>> = {
  MADE_AVAILABLE: "PAR",
  APPROVED: "BUYER",
  REFUSED: "BUYER",
  DISPUTED: "BUYER",
  SUSPENDED: "BUYER",
};

export async function simulateLifecycleTransition(input: {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  startSequence: number;
  previousState: InvoiceState;
  nextState: InvoiceState;
  actor: SimulationLifecycleActor;
  payload?: Record<string, unknown>;
  eventId?: string;
  requestedEventType?: string;
  interruptAfter?: "PAR_RECEIVED";
  now?: () => Date;
}): Promise<{
  event: SimulationLifecycleEvent;
  steps: SimulationStep[];
  interrupted: boolean;
}> {
  if (input.nextState === "PAID") {
    throw new LifecycleSimulationError(
      "SIMULATION_BOUNDARY",
      "Status 212/payment simulation requires the shared Payment Contract.",
      "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
    );
  }
  if (!canTransition(input.previousState, input.nextState)) {
    throw new LifecycleSimulationError(
      "LIFECYCLE_TRANSITION_UNAVAILABLE",
      `The shared lifecycle contract does not allow ${input.previousState} -> ${input.nextState}.`,
    );
  }
  const expectedActor = DOCUMENTED_ACTOR_BY_TARGET[input.nextState];
  if (!expectedActor) {
    throw new LifecycleSimulationError(
      "SIMULATION_BOUNDARY",
      `No public Country Runtime actor policy is exposed for ${input.nextState}.`,
      "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME",
    );
  }
  if (input.actor !== expectedActor) {
    throw new LifecycleSimulationError(
      "LIFECYCLE_WRONG_ACTOR",
      `${input.nextState} must be emitted by ${expectedActor} in the documented sandbox mapping.`,
    );
  }
  const eventType = lifecycleEventType(input.nextState);
  if (input.requestedEventType && input.requestedEventType !== eventType) {
    throw new LifecycleSimulationError(
      "LIFECYCLE_TRANSITION_UNAVAILABLE",
      `Event type ${input.requestedEventType} does not match ${eventType} for ${input.nextState}.`,
    );
  }

  const timestamp = (input.now ?? (() => new Date()))().toISOString();
  const payload = {
    ...(input.payload ?? {}),
    regulatoryCode: REGULATORY_CODES[input.nextState] ?? null,
  };
  const payloadHash = await sha256Hex(JSON.stringify(payload));
  const eventCore = {
    transactionId: input.transactionId,
    correlationId: input.correlationId,
    executionRunId: input.executionRunId,
    eventId: input.eventId ?? crypto.randomUUID(),
    actor: input.actor,
    previousState: input.previousState,
    eventType,
    nextState: input.nextState,
    payload,
    payloadHash,
    provenance: "REMOTE_PA_SIMULATED" as const,
    contractSource: "PA_D2F_LIFECYCLE_CONTRACT" as const,
    interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY" as const,
    timestamp,
    source: "LIFECYCLE_SIMULATOR" as const,
  };
  const evidenceReference = `sha256:${await sha256Hex(JSON.stringify(eventCore))}`;
  const event: SimulationLifecycleEvent = { ...eventCore, evidenceReference };
  const steps: SimulationStep[] = [];
  const add = (actor: SimulationStep["actor"], kind: SimulationStep["event"], receiver: string) => {
    steps.push({
      transactionId: input.transactionId,
      correlationId: input.correlationId,
      executionRunId: input.executionRunId,
      sequence: input.startSequence + steps.length + 1,
      actor,
      event: kind,
      provenance: "REMOTE_PA_SIMULATED",
      result: "PASS",
      evidence: {
        category: "SIMULATED_LIFECYCLE",
        technicalEvidenceOnly: true,
        receiver,
        lifecycleEvent: event,
      },
      timestamp,
    });
  };

  add(input.actor, "LIFECYCLE_EVENT_EMITTED", input.actor);
  if (input.actor === "BUYER") {
    add("PAR", "LIFECYCLE_PAR_RECEIVED", "D2F-PAR-SIM");
    if (input.interruptAfter === "PAR_RECEIVED") return { event, steps, interrupted: true };
  }
  add("PAE", "LIFECYCLE_PAE_RECORDED", "D2F-PAE-SIM");
  return { event, steps, interrupted: false };
}

export function resumeLifecyclePropagation(input: {
  event: SimulationLifecycleEvent;
  executionRunId: string;
  sequence: number;
  timestamp?: string;
}): SimulationStep {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    transactionId: input.event.transactionId,
    correlationId: input.event.correlationId,
    executionRunId: input.executionRunId,
    sequence: input.sequence,
    actor: "PAE",
    event: "LIFECYCLE_PAE_RECORDED",
    provenance: "REMOTE_PA_SIMULATED",
    result: "PASS",
    evidence: {
      category: "SIMULATED_LIFECYCLE",
      technicalEvidenceOnly: true,
      receiver: "D2F-PAE-SIM",
      replayedEventId: input.event.eventId,
      lifecycleEvent: input.event,
    },
    timestamp,
  };
}

export function collectLifecycleEvents(steps: SimulationStep[]): SimulationLifecycleEvent[] {
  const events = new Map<string, SimulationLifecycleEvent>();
  for (const step of steps) {
    const candidate = step.evidence.lifecycleEvent;
    if (!isSimulationLifecycleEvent(candidate)) continue;
    if (!events.has(candidate.eventId)) events.set(candidate.eventId, candidate);
  }
  return [...events.values()];
}

function isSimulationLifecycleEvent(value: unknown): value is SimulationLifecycleEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<SimulationLifecycleEvent>;
  return typeof event.eventId === "string"
    && typeof event.transactionId === "string"
    && typeof event.nextState === "string"
    && typeof event.previousState === "string"
    && event.source === "LIFECYCLE_SIMULATOR";
}
