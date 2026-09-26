import { assertSimulationTarget, type DirectoryAdapter, type RemotePaAdapter } from "./adapters";
import {
  requirePhaseOneFlags,
  SIMULATION_SCENARIO_ID,
  SIMULATION_TENANTS,
  type SimulationExecution,
  type SimulationFeatureFlags,
  type SimulationNode,
  type SimulationStep,
} from "./contracts";

const NODES = [
  { id: SIMULATION_TENANTS.pae, tenantId: SIMULATION_TENANTS.pae, role: "PAE", endpoint: "sim://pae", queue: "pae-outbound", credentialRef: "simulated://pae" },
  { id: SIMULATION_TENANTS.par, tenantId: SIMULATION_TENANTS.par, role: "PAR", endpoint: "sim://par", queue: "par-inbound", credentialRef: "simulated://par" },
] as const satisfies readonly [SimulationNode, SimulationNode];

export class PhaseOneScenarioEngine {
  constructor(
    private readonly directory: DirectoryAdapter,
    private readonly remotePa: RemotePaAdapter,
    private readonly flags: SimulationFeatureFlags,
    private readonly externalNetworkDisabled: boolean,
  ) {}

  async execute(input: {
    transactionId: string;
    correlationId: string;
    executionRunId: string;
    canonicalTransaction: Record<string, unknown>;
  }): Promise<SimulationExecution> {
    requirePhaseOneFlags(this.flags);
    assertSimulationTarget(NODES[0].endpoint, this.externalNetworkDisabled);
    const steps: SimulationStep[] = [];
    const add = (actor: SimulationStep["actor"], event: string, provenance: SimulationStep["provenance"], evidence: Record<string, unknown>) => {
      steps.push({ sequence: steps.length + 1, actor, event, provenance, result: "PASS", evidence });
    };

    add("PAE", "CANONICAL_TRANSACTION_INGESTED", "CBM_DERIVED", { tenantId: NODES[0].tenantId });
    const directory = await this.directory.resolve({ scheme: "0225", value: "TEST-FR-BUYER-001" });
    if (directory.status !== "FOUND" || !directory.destinationPa) throw new Error("SIMULATED_DIRECTORY_NOT_FOUND");
    add("DIRECTORY", "SIMULATED_DIRECTORY_RESOLVED", directory.provenance, { ...directory });
    const delivery = await this.remotePa.deliver({
      transactionId: input.transactionId,
      correlationId: input.correlationId,
      executionRunId: input.executionRunId,
      endpoint: NODES[1].endpoint,
      payload: input.canonicalTransaction,
    });
    add("PAR", "SIMULATED_REMOTE_PA_RECEIVED", delivery.provenance, { destination: delivery.destination, tenantId: NODES[1].tenantId });
    add("BUYER", "SIMULATED_BUYER_DELIVERED", "REMOTE_PA_SIMULATED", { buyer: "TEST-FR-BUYER-001" });

    return {
      scenarioId: SIMULATION_SCENARIO_ID,
      transactionId: input.transactionId,
      correlationId: input.correlationId,
      executionRunId: input.executionRunId,
      environment: "SIMULATION",
      validation: { category: "REAL_REGULATORY_VALIDATION", boundary: "SIMULATION_BOUNDARY", status: "NOT_EXECUTED", blockedBy: "PA_INTEGRATION_REQUEST_REGULATORY_RESULT" },
      interoperability: {
        category: "SIMULATED_EXTERNAL_INTEROPERABILITY",
        externalPpfConnected: false,
        externalDirectoryConnected: false,
        externalPaConnected: false,
        notice: "NOT AN AIFE/PPF INTEROPERABILITY TEST",
      },
      nodes: NODES,
      steps,
    };
  }
}
