import {
  assertSimulationTarget,
  type BuyerAdapter,
  type DirectoryAdapter,
  type DirectoryResolutionStatus,
  type RemotePaAdapter,
} from "./adapters";
import {
  requirePhaseOneFlags,
  SIMULATION_SCENARIO_ID,
  SIMULATION_TENANTS,
  type SimulationEventType,
  type SimulationExecution,
  type SimulationExecutionStatus,
  type SimulationFeatureFlags,
  type SimulationNode,
  type SimulationStep,
} from "./contracts";

const NODES = [
  { id: SIMULATION_TENANTS.pae, tenantId: SIMULATION_TENANTS.pae, role: "PAE", endpoint: "sim://pae", queue: "pae-outbound", credentialRef: "simulated://pae" },
  { id: SIMULATION_TENANTS.par, tenantId: SIMULATION_TENANTS.par, role: "PAR", endpoint: "sim://par", queue: "par-inbound", credentialRef: "simulated://par" },
] as const satisfies readonly [SimulationNode, SimulationNode];

const DIRECTORY_FAILURE_EVENTS: Record<Exclude<DirectoryResolutionStatus, "FOUND">, SimulationEventType> = {
  NOT_FOUND: "DIRECTORY_NOT_FOUND",
  INVALID_IDENTIFIER: "DIRECTORY_INVALID_IDENTIFIER",
  NO_ACTIVE_ROUTING: "DIRECTORY_NO_ACTIVE_ROUTING",
  MULTIPLE_ADDRESSES: "DIRECTORY_MULTIPLE_ADDRESSES",
  PA_NOT_FOUND: "DIRECTORY_PA_NOT_FOUND",
  ADDRESS_DISABLED: "DIRECTORY_ADDRESS_DISABLED",
  TEMPORARY_ERROR: "DIRECTORY_TEMPORARY_ERROR",
};

type ResumeCursor = "START" | "AFTER_DIRECTORY" | "AFTER_ROUTING" | "AFTER_PAR";

export class PhaseTwoScenarioEngine {
  constructor(
    private readonly directory: DirectoryAdapter,
    private readonly remotePa: RemotePaAdapter,
    private readonly buyer: BuyerAdapter,
    private readonly flags: SimulationFeatureFlags,
    private readonly externalNetworkDisabled: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: {
    transactionId: string;
    correlationId: string;
    executionRunId: string;
    canonicalTransaction: Record<string, unknown>;
    validateCanonical: (value: Record<string, unknown>) => unknown[];
    directoryQuery: { scheme: string; value: string };
    interruptAfter?: "DIRECTORY_RESOLVED" | "PAR_ACCEPTED";
    resumeFrom?: SimulationExecution;
  }): Promise<SimulationExecution> {
    requirePhaseOneFlags(this.flags);
    assertSimulationTarget(NODES[0].endpoint, this.externalNetworkDisabled);
    const cursor = resumeCursor(input.resumeFrom);
    const previousSequence = input.resumeFrom?.steps.reduce((max, step) => Math.max(max, step.sequence), 0) ?? 0;
    const steps: SimulationStep[] = [];
    const add = (
      actor: SimulationStep["actor"],
      event: SimulationEventType,
      provenance: SimulationStep["provenance"],
      result: SimulationStep["result"],
      evidence: Record<string, unknown>,
    ) => {
      steps.push({
        transactionId: input.transactionId,
        correlationId: input.correlationId,
        executionRunId: input.executionRunId,
        sequence: previousSequence + steps.length + 1,
        actor,
        event,
        provenance,
        result,
        evidence,
        timestamp: this.now().toISOString(),
      });
    };
    const finish = (
      status: SimulationExecutionStatus,
      code: string,
      retryable: boolean,
      validationStatus: "PASSED" | "FAILED" = "PASSED",
    ): SimulationExecution => ({
      scenarioId: SIMULATION_SCENARIO_ID,
      transactionId: input.transactionId,
      correlationId: input.correlationId,
      executionRunId: input.executionRunId,
      resumedFromExecutionRunId: input.resumeFrom?.executionRunId ?? null,
      environment: "SIMULATION",
      status,
      outcome: { code, retryable },
      validation: {
        category: "REAL_REGULATORY_VALIDATION",
        boundary: "SIMULATION_BOUNDARY",
        status: validationStatus,
        blockedContract: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT",
      },
      interoperability: {
        category: "SIMULATED_EXTERNAL_INTEROPERABILITY",
        externalPpfConnected: false,
        externalDirectoryConnected: false,
        externalPaConnected: false,
        notice: "NOT AN AIFE/PPF INTEROPERABILITY TEST",
      },
      nodes: NODES,
      steps,
    });

    if (cursor === "START") {
      add("PAE", "PAE_RECEIVED", "USER_INPUT", "PASS", { tenantId: NODES[0].tenantId });
      const validationIssues = input.validateCanonical(input.canonicalTransaction);
      add("PAE", "PAE_VALIDATED", "CBM_DERIVED", validationIssues.length === 0 ? "PASS" : "BLOCKED", {
        category: "REAL_REGULATORY_VALIDATION",
        issueCount: validationIssues.length,
        issues: validationIssues,
      });
      if (validationIssues.length > 0) return finish("BLOCKED", "CANONICAL_VALIDATION_FAILED", false, "FAILED");

      add("DIRECTORY", "DIRECTORY_LOOKUP", "DIRECTORY_SIMULATED", "PASS", {
        category: "SIMULATED_DIRECTORY",
        query: input.directoryQuery,
      });
      const resolution = await this.directory.resolve(input.directoryQuery);
      if (resolution.status !== "FOUND" || !resolution.destinationPa) {
        const failureStatus = resolution.status as Exclude<DirectoryResolutionStatus, "FOUND">;
        add("DIRECTORY", DIRECTORY_FAILURE_EVENTS[failureStatus], resolution.provenance, "BLOCKED", {
          category: "SIMULATED_DIRECTORY",
          resolution,
        });
        return finish(resolution.retryable ? "RETRYABLE" : "BLOCKED", `DIRECTORY_${resolution.status}`, resolution.retryable);
      }
      add("DIRECTORY", "DIRECTORY_RESOLVED", resolution.provenance, "PASS", {
        category: "SIMULATED_DIRECTORY",
        resolution,
      });
      if (input.interruptAfter === "DIRECTORY_RESOLVED") return finish("INTERRUPTED", "INTERRUPTED_AFTER_DIRECTORY", true);
    }

    if (cursor !== "AFTER_ROUTING" && cursor !== "AFTER_PAR") {
      add("PAE", "PAE_ROUTED", "DIRECTORY_SIMULATED", "PASS", {
        category: "SIMULATED_DIRECTORY",
        destination: SIMULATION_TENANTS.par,
        resumed: cursor === "AFTER_DIRECTORY",
      });
    }

    if (cursor !== "AFTER_PAR") {
      const remoteResult = await this.remotePa.deliver({
        transactionId: input.transactionId,
        correlationId: input.correlationId,
        executionRunId: input.executionRunId,
        endpoint: NODES[1].endpoint,
        payload: input.canonicalTransaction,
      });
      if (remoteResult.status === "TEMPORARY_FAILURE") {
        add("PAR", "PAR_TEMPORARY_FAILURE", remoteResult.provenance, "BLOCKED", {
          category: "SIMULATED_REMOTE_PA",
          destination: remoteResult.destination,
        });
        return finish("RETRYABLE", "REMOTE_PA_TEMPORARY_FAILURE", true);
      }
      add("PAR", "PAR_RECEIVED", remoteResult.provenance, "PASS", {
        category: "SIMULATED_REMOTE_PA",
        destination: remoteResult.destination,
        tenantId: NODES[1].tenantId,
      });
      if (remoteResult.status === "REJECTED") {
        add("PAR", "PAR_REJECTED", remoteResult.provenance, "BLOCKED", {
          category: "SIMULATED_REMOTE_PA",
          reason: "SIMULATED_PAR_REJECTION",
        });
        return finish("REJECTED", "PAR_REJECTED", false);
      }
      add("PAR", "PAR_ACCEPTED", remoteResult.provenance, "PASS", {
        category: "SIMULATED_REMOTE_PA",
        boundary: "SIMULATION_BOUNDARY",
      });
      if (input.interruptAfter === "PAR_ACCEPTED") return finish("INTERRUPTED", "INTERRUPTED_AFTER_PAR", true);
    }

    const buyerResult = await this.buyer.deliver({
      transactionId: input.transactionId,
      correlationId: input.correlationId,
      executionRunId: input.executionRunId,
      endpoint: "sim://buyer",
      payload: input.canonicalTransaction,
    });
    if (buyerResult.status === "TEMPORARY_FAILURE") {
      add("BUYER", "BUYER_TEMPORARY_FAILURE", buyerResult.provenance, "BLOCKED", {
        category: "SIMULATED_REMOTE_PA",
        buyer: buyerResult.buyer,
      });
      return finish("RETRYABLE", "BUYER_TEMPORARY_FAILURE", true);
    }
    add("BUYER", "BUYER_DELIVERED", buyerResult.provenance, "PASS", {
      category: "SIMULATED_REMOTE_PA",
      buyer: buyerResult.buyer,
    });
    return finish("COMPLETED", "BUYER_DELIVERED", false);
  }
}

export { PhaseTwoScenarioEngine as PhaseOneScenarioEngine };

function resumeCursor(execution?: SimulationExecution): ResumeCursor {
  if (!execution) return "START";
  if (!execution.outcome?.retryable) throw new Error("SIMULATION_RUN_NOT_REPLAYABLE");
  if (execution.outcome.code === "INTERRUPTED_AFTER_DIRECTORY") return "AFTER_DIRECTORY";
  if (execution.outcome.code === "INTERRUPTED_AFTER_PAR" || execution.outcome.code === "BUYER_TEMPORARY_FAILURE") return "AFTER_PAR";
  if (execution.outcome.code === "REMOTE_PA_TEMPORARY_FAILURE") return "AFTER_ROUTING";
  return "START";
}
