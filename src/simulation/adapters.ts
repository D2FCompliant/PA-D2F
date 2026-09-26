import type { Provenance } from "./contracts";

export type DirectoryResolutionStatus =
  | "FOUND"
  | "NOT_FOUND"
  | "INVALID_IDENTIFIER"
  | "NO_ACTIVE_ROUTING"
  | "MULTIPLE_ADDRESSES"
  | "PA_NOT_FOUND"
  | "ADDRESS_DISABLED"
  | "TEMPORARY_ERROR";

export type DirectoryResolution = {
  status: DirectoryResolutionStatus;
  provenance: "DIRECTORY_SIMULATED";
  query: { scheme: string; value: string };
  entity: { id: string; displayName: string } | null;
  electronicAddresses: Array<{ scheme: string; value: string; enabled: boolean }>;
  destinationPa: "D2F-PAR-SIM" | null;
  retryable: boolean;
  error: { code: DirectoryResolutionStatus; message: string } | null;
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

export type RemotePaOutcome = "ACCEPTED" | "TEMPORARY_FAILURE" | "REJECTED";
export type BuyerOutcome = "DELIVERED" | "TEMPORARY_FAILURE";

export interface RemotePaAdapter {
  deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }): Promise<{
    status: RemotePaOutcome;
    provenance: "REMOTE_PA_SIMULATED";
    destination: "D2F-PAR-SIM";
  }>;
}

export interface BuyerAdapter {
  deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }): Promise<{
    status: BuyerOutcome;
    provenance: "REMOTE_PA_SIMULATED";
    buyer: "TEST-FR-BUYER-001";
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

const DIRECTORY_CASES: Record<string, DirectoryResolutionStatus> = {
  "TEST-FR-BUYER-001": "FOUND",
  "TEST-FR-NOT-FOUND": "NOT_FOUND",
  "TEST-FR-NO-ROUTING": "NO_ACTIVE_ROUTING",
  "TEST-FR-MULTIPLE": "MULTIPLE_ADDRESSES",
  "TEST-FR-PA-NOT-FOUND": "PA_NOT_FOUND",
  "TEST-FR-ADDRESS-DISABLED": "ADDRESS_DISABLED",
  "TEST-FR-TEMPORARY": "TEMPORARY_ERROR",
};

export class SimulatedDirectoryAdapter implements DirectoryAdapter {
  async resolve(input: { scheme: string; value: string }): Promise<DirectoryResolution> {
    const identifierIsValid = /^\d{4}$/.test(input.scheme) && /^TEST-FR-[A-Z0-9-]+$/.test(input.value);
    const status = identifierIsValid ? (DIRECTORY_CASES[input.value] ?? "NOT_FOUND") : "INVALID_IDENTIFIER";
    const base = {
      status,
      provenance: "DIRECTORY_SIMULATED" as const,
      query: { ...input },
      destinationPa: status === "FOUND" ? "D2F-PAR-SIM" as const : null,
      retryable: status === "TEMPORARY_ERROR",
      error: status === "FOUND" ? null : { code: status, message: `Simulated directory result: ${status}` },
    };

    if (status === "FOUND") {
      return {
        ...base,
        entity: { id: input.value, displayName: "Synthetic French buyer" },
        electronicAddresses: [{ scheme: input.scheme, value: input.value, enabled: true }],
      };
    }
    if (status === "MULTIPLE_ADDRESSES") {
      return {
        ...base,
        entity: { id: input.value, displayName: "Synthetic ambiguous buyer" },
        electronicAddresses: [
          { scheme: input.scheme, value: `${input.value}-A`, enabled: true },
          { scheme: input.scheme, value: `${input.value}-B`, enabled: true },
        ],
      };
    }
    if (status === "ADDRESS_DISABLED") {
      return {
        ...base,
        entity: { id: input.value, displayName: "Synthetic disabled buyer" },
        electronicAddresses: [{ scheme: input.scheme, value: input.value, enabled: false }],
      };
    }
    return { ...base, entity: null, electronicAddresses: [] };
  }
}

export class SimulatedRemotePaAdapter implements RemotePaAdapter {
  constructor(
    private readonly externalNetworkDisabled: boolean,
    private readonly outcome: RemotePaOutcome = "ACCEPTED",
  ) {}

  async deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }) {
    assertSimulationTarget(input.endpoint, this.externalNetworkDisabled);
    return {
      status: this.outcome,
      provenance: "REMOTE_PA_SIMULATED" as const,
      destination: "D2F-PAR-SIM" as const,
    };
  }
}

export class SimulatedBuyerAdapter implements BuyerAdapter {
  constructor(
    private readonly externalNetworkDisabled: boolean,
    private readonly outcome: BuyerOutcome = "DELIVERED",
  ) {}

  async deliver(input: { transactionId: string; correlationId: string; executionRunId: string; endpoint: string; payload: Record<string, unknown> }) {
    assertSimulationTarget(input.endpoint, this.externalNetworkDisabled);
    return {
      status: this.outcome,
      provenance: "REMOTE_PA_SIMULATED" as const,
      buyer: "TEST-FR-BUYER-001" as const,
    };
  }
}
