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

export type SimulationStep = {
  sequence: number;
  actor: SimulationRole;
  event: string;
  provenance: Provenance;
  result: "PASS" | "BLOCKED";
  evidence: Record<string, unknown>;
};

export type SimulationExecution = {
  scenarioId: typeof SIMULATION_SCENARIO_ID;
  transactionId: string;
  correlationId: string;
  executionRunId: string;
  environment: "SIMULATION";
  validation: {
    category: "REAL_REGULATORY_VALIDATION";
    boundary: "SIMULATION_BOUNDARY";
    status: "NOT_EXECUTED";
    blockedBy: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT";
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
