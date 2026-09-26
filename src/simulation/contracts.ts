import type { InvoiceState } from "../types";

export const SIMULATION_SCENARIO_ID = "DEMO-FR-PIPELINE-001" as const;

export const SIMULATION_TENANTS = {
  pae: "D2F-PAE-SIM",
  par: "D2F-PAR-SIM",
} as const;

export const PA_INTEGRATION_REQUESTS = [
  "PA_INTEGRATION_REQUEST_REGULATORY_RESULT",
  "PA_INTEGRATION_REQUEST_READINESS",
  "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME",
  "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
] as const;

export type SimulationRole = "PAE" | "PAR" | "DIRECTORY" | "BUYER";
export type Provenance =
  | "USER_INPUT"
  | "CBM_DERIVED"
  | "COUNTRY_PACK_DERIVED"
  | "REGULATORY_ARTIFACT"
  | "DIRECTORY_SIMULATED"
  | "PPF_SIMULATED"
  | "REMOTE_PA_SIMULATED";

export type SimulationFeatureFlags = {
  dualNodeSimulation: boolean;
  directorySimulator: boolean;
  ppfSimulator: boolean;
  lifecycleSimulation: boolean;
};

export type SimulationNode = {
  id: "D2F-PAE-SIM" | "D2F-PAR-SIM";
  tenantId: "D2F-PAE-SIM" | "D2F-PAR-SIM";
  role: "PAE" | "PAR";
  endpoint: "sim://pae" | "sim://par";
  queue: "pae-outbound" | "par-inbound";
  credentialRef: "simulated://pae" | "simulated://par";
};

export const SIMULATION_NODES = [
  { id: SIMULATION_TENANTS.pae, tenantId: SIMULATION_TENANTS.pae, role: "PAE", endpoint: "sim://pae", queue: "pae-outbound", credentialRef: "simulated://pae" },
  { id: SIMULATION_TENANTS.par, tenantId: SIMULATION_TENANTS.par, role: "PAR", endpoint: "sim://par", queue: "par-inbound", credentialRef: "simulated://par" },
] as const satisfies readonly [SimulationNode, SimulationNode];

export type SimulationEventType =
  | "PAE_RECEIVED"
  | "PAE_VALIDATED"
  | "DIRECTORY_LOOKUP"
  | "DIRECTORY_RESOLVED"
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_INVALID_IDENTIFIER"
  | "DIRECTORY_NO_ACTIVE_ROUTING"
  | "DIRECTORY_MULTIPLE_ADDRESSES"
  | "DIRECTORY_PA_NOT_FOUND"
  | "DIRECTORY_ADDRESS_DISABLED"
  | "DIRECTORY_TEMPORARY_ERROR"
  | "PAE_ROUTED"
  | "PAR_RECEIVED"
  | "PAR_ACCEPTED"
  | "PAR_REJECTED"
  | "PAR_TEMPORARY_FAILURE"
  | "BUYER_DELIVERED"
  | "BUYER_TEMPORARY_FAILURE"
  | "LIFECYCLE_EVENT_EMITTED"
  | "LIFECYCLE_PAR_RECEIVED"
  | "LIFECYCLE_PAE_RECORDED";

export type SimulationLifecycleActor = "BUYER" | "PAR" | "PAE";

// Temporary sandbox evidence view. Transition semantics remain owned by
// src/lifecycle.ts and this type must not become a parallel lifecycle contract.
export type SimulationLifecycleEvent = {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  eventId: string;
  actor: SimulationLifecycleActor;
  previousState: InvoiceState;
  eventType: string;
  nextState: InvoiceState;
  payload: Record<string, unknown>;
  payloadHash: string;
  provenance: "REMOTE_PA_SIMULATED";
  contractSource: "PA_D2F_LIFECYCLE_CONTRACT";
  interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY";
  timestamp: string;
  evidenceReference: string;
  source: "LIFECYCLE_SIMULATOR";
};

export type SimulationStep = {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  sequence: number;
  actor: SimulationRole;
  event: SimulationEventType;
  provenance: Provenance;
  result: "PASS" | "BLOCKED";
  evidence: Record<string, unknown>;
  timestamp: string;
};

export type SimulationExecutionStatus = "COMPLETED" | "BLOCKED" | "RETRYABLE" | "REJECTED" | "INTERRUPTED";

export type SimulationExecution = {
  scenarioId: typeof SIMULATION_SCENARIO_ID;
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  resumedFromExecutionRunId: string | null;
  environment: "SIMULATION";
  status: SimulationExecutionStatus;
  outcome: { code: string; retryable: boolean };
  validation: {
    category: "REAL_REGULATORY_VALIDATION";
    boundary: "SIMULATION_BOUNDARY";
    status: "PASSED" | "FAILED";
    blockedContract: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT";
  };
  interoperability: {
    category: "SIMULATED_EXTERNAL_INTEROPERABILITY";
    externalPpfConnected: false;
    externalDirectoryConnected: false;
    externalPaConnected: false;
    notice: "NOT AN AIFE/PPF INTEROPERABILITY TEST";
  };
  nodes: readonly [SimulationNode, SimulationNode];
  steps: SimulationStep[];
  lifecycle?: {
    currentState: InvoiceState;
    events: SimulationLifecycleEvent[];
    paymentBoundary: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT";
  };
};

export function simulationFlags(env: Env): SimulationFeatureFlags {
  return {
    dualNodeSimulation: String(env.PA_DUAL_NODE_SIMULATION) === "true",
    directorySimulator: String(env.DIRECTORY_SIMULATOR) === "true",
    ppfSimulator: String(env.PPF_SIMULATOR) === "true",
    lifecycleSimulation: String(env.LIFECYCLE_SIMULATION) === "true",
  };
}

export function requirePhaseOneFlags(flags: SimulationFeatureFlags): void {
  if (!flags.dualNodeSimulation || !flags.directorySimulator) {
    throw new Error("PA_SIMULATION_FEATURE_DISABLED");
  }
}

export function isolatedSimulationTenant(_requestedTenantId: string): typeof SIMULATION_TENANTS.pae {
  return SIMULATION_TENANTS.pae;
}
