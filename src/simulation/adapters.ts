import type { Provenance } from "./contracts";

export type DirectoryResolution = {
  status: "FOUND" | "NOT_FOUND";
  provenance: "DIRECTORY_SIMULATED";
  electronicAddress: { scheme: string; value: string } | null;
  destinationPa: "D2F-PAR-SIM" | null;
};

export interface DirectoryAdapter {
  resolve(input: { scheme: string; value: string }): Promise<DirectoryResolution>;
}

export interface PpfReportingAdapter {
  submit(input: { transactionId: string; executionRunId: string; payload: Record<string, unknown> }): Promise<{
    status: "ACCEPTED" | "REJECTED";
    provenance: "PPF_SIMULATED";
  }>;
}

export interface RemotePaAdapter {
  deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }): Promise<{
    status: "DELIVERED";
    provenance: "REMOTE_PA_SIMULATED";
    destination: "D2F-PAR-SIM";
  }>;
}

// Temporary boundary only. The definitive result contract remains blocked by
// PA_INTEGRATION_REQUEST_REGULATORY_RESULT.
export interface RegulatoryValidationAdapter {
  validate(input: Record<string, unknown>): Promise<{
    category: "REAL_REGULATORY_VALIDATION";
    provenance: Provenance;
    result: unknown;
  }>;
}

export class SimulationNetworkError extends Error {
  readonly code = "EXTERNAL_NETWORK_BLOCKED";

  constructor(target: string) {
    super(`EXTERNAL_NETWORK_BLOCKED: ${target}`);
  }
}

export function assertSimulationTarget(target: string, externalNetworkDisabled: boolean): void {
  if (!externalNetworkDisabled || !target.startsWith("sim://")) throw new SimulationNetworkError(target);
}

export class SimulatedDirectoryAdapter implements DirectoryAdapter {
  async resolve(input: { scheme: string; value: string }): Promise<DirectoryResolution> {
    const found = input.scheme === "0225" && input.value === "TEST-FR-BUYER-001";
    return {
      status: found ? "FOUND" : "NOT_FOUND",
      provenance: "DIRECTORY_SIMULATED",
      electronicAddress: found ? { scheme: "0225", value: "TEST-FR-BUYER-001" } : null,
      destinationPa: found ? "D2F-PAR-SIM" : null,
    };
  }
}

export class SimulatedRemotePaAdapter implements RemotePaAdapter {
  constructor(private readonly externalNetworkDisabled: boolean) {}

  async deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }) {
    assertSimulationTarget(input.endpoint, this.externalNetworkDisabled);
    return {
      status: "DELIVERED" as const,
      provenance: "REMOTE_PA_SIMULATED" as const,
      destination: "D2F-PAR-SIM" as const,
    };
  }
}
