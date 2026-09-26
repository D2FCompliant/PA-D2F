import type { InvoiceState } from "../types";
import type { EReportingFlow, EReportingValidation } from "../e-reporting";

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

export type SimulationRole = "PAE" | "PAR" | "DIRECTORY" | "BUYER" | "PPF";
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
  | "LIFECYCLE_PAE_RECORDED"
  | "PPF_SUBMISSION_CREATED"
  | "PPF_SUBMISSION_SENT"
  | "PPF_SUBMISSION_RECEIVED"
  | "PPF_VALIDATION_COMPLETED"
  | "PPF_SUBMISSION_ACCEPTED"
  | "PPF_SUBMISSION_REJECTED"
  | "PPF_SUBMISSION_TEMPORARY_ERROR";

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

export type PpfSubmissionOutcome =
  | "ACCEPTED"
  | "REJECTED_XSD"
  | "REJECTED_BUSINESS_RULE"
  | "INVALID_PAYLOAD"
  | "DUPLICATE_SUBMISSION"
  | "TEMPORARY_ERROR";

export type SimulationPpfSubmission = {
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  submissionId: string;
  flow: Exclude<EReportingFlow, "UNKNOWN"> | "UNKNOWN";
  sourceMode: "GENERATED" | "PROVIDED_PAYLOAD";
  payloadSha256: string;
  recordIds: string[];
  state: "CREATED" | "SENT" | "RECEIVED" | "COMPLETED";
  outcome: PpfSubmissionOutcome | null;
  retryable: boolean;
  validation: EReportingValidation | null;
  provenance: "PPF_SIMULATED";
  interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY";
  validationCategory: "REAL_REGULATORY_VALIDATION";
  role: "REGULATORY_DATA_COLLECTOR";
  target: "sim://ppf-reporting";
  externalNetworkCalled: false;
  technicalEvidenceOnly: true;
  timestamp: string;
  evidenceReference: string;
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
  scenarioId: string;
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
  ppf?: {
    submissions: SimulationPpfSubmission[];
    paymentBoundary: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT";
    countryRuntimeBoundary: "PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME";
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
