import { sha256Hex } from "../crypto";
import type { StoredResponse } from "../types";
import {
  SimulatedBuyerAdapter,
  SimulatedDirectoryAdapter,
  SimulatedRemotePaAdapter,
  type BuyerOutcome,
  type RemotePaOutcome,
} from "./adapters";
import { isolatedSimulationTenant, simulationFlags, SIMULATION_SCENARIO_ID, SIMULATION_TENANTS, type SimulationExecution } from "./contracts";
import { assertSyntheticFixture, canonicalHappyPathFixture } from "./fixtures";
import { PhaseTwoScenarioEngine } from "./scenario-engine";

export type ScenarioTransactionRecord = {
  transactionId: string;
  scenarioId: string;
  connectionId: string;
  initiatingTenantId: string;
  paeTenantId: typeof SIMULATION_TENANTS.pae;
  parTenantId: typeof SIMULATION_TENANTS.par;
  correlationId: string;
  canonicalTransaction: Record<string, unknown>;
  createdAt: string;
};

export type ScenarioTrace = {
  transaction: Omit<ScenarioTransactionRecord, "canonicalTransaction">;
  runs: SimulationExecution[];
  messages: SimulationExecution["steps"];
};

export interface ScenarioStore {
  findIdempotency(connectionId: string, operation: string, key: string): Promise<{ fingerprint: string; response: StoredResponse } | null>;
  saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  getTransaction(transactionId: string, connectionId: string): Promise<ScenarioTransactionRecord | null>;
  createTransactionIfAbsent(transaction: ScenarioTransactionRecord): Promise<ScenarioTransactionRecord>;
  getExecutionRun(executionRunId: string, connectionId: string): Promise<SimulationExecution | null>;
  createRun(execution: SimulationExecution): Promise<void>;
  getTrace(transactionId: string, connectionId: string): Promise<ScenarioTrace | null>;
}

export type ScenarioExecutionOptions = {
  directoryScheme?: string;
  directoryIdentifier?: string;
  remotePaOutcome?: RemotePaOutcome;
  buyerOutcome?: BuyerOutcome;
  interruptAfter?: "DIRECTORY_RESOLVED" | "PAR_ACCEPTED";
  resumeFromExecutionRunId?: string;
};

export class ScenarioServiceError extends Error {
  constructor(
    readonly code:
      | "IDEMPOTENCY_CONFLICT"
      | "SIMULATION_TRANSACTION_NOT_FOUND"
      | "SIMULATION_RUN_NOT_FOUND"
      | "SIMULATION_RUN_NOT_REPLAYABLE"
      | "RESUME_TRANSACTION_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

export async function executePhaseTwoScenario(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  initiatingTenantId: string;
  idempotencyKey: string;
  validateCanonical: (value: Record<string, unknown>) => unknown[];
  transactionId?: string;
  correlationId?: string;
  scenarioId?: string;
  canonicalFixture?: Record<string, unknown>;
  options?: ScenarioExecutionOptions;
}): Promise<StoredResponse> {
  const scenarioId = input.scenarioId ?? SIMULATION_SCENARIO_ID;
  const operation = `sandbox.scenario.${scenarioId}.execute`;
  const options = input.options ?? {};
  const fixture = input.canonicalFixture ?? canonicalHappyPathFixture();
  assertSyntheticFixture(fixture);
  const fingerprint = await sha256Hex(JSON.stringify({
    scenarioId,
    transactionId: input.transactionId || null,
    correlationId: input.correlationId || null,
    options,
    fixture,
  }));
  const replay = await input.store.findIdempotency(input.connectionId, operation, input.idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new ScenarioServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another simulation request.");
    return { status: 200, body: { ...replay.response.body, idempotentReplay: true } };
  }

  let resumeFrom: SimulationExecution | undefined;
  if (options.resumeFromExecutionRunId) {
    resumeFrom = await input.store.getExecutionRun(options.resumeFromExecutionRunId, input.connectionId) ?? undefined;
    if (!resumeFrom) throw new ScenarioServiceError("SIMULATION_RUN_NOT_FOUND", "The requested execution run does not exist in this connection scope.");
    if (!resumeFrom.outcome?.retryable) throw new ScenarioServiceError("SIMULATION_RUN_NOT_REPLAYABLE", "The requested execution run is not replayable.");
    if (input.transactionId && input.transactionId !== resumeFrom.transactionId) {
      throw new ScenarioServiceError("RESUME_TRANSACTION_MISMATCH", "The execution run does not belong to the requested transaction.");
    }
  }

  const requestedTransactionId = input.transactionId ?? resumeFrom?.transactionId;
  let transaction = requestedTransactionId ? await input.store.getTransaction(requestedTransactionId, input.connectionId) : null;
  if (requestedTransactionId && !transaction) throw new ScenarioServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The requested simulation transaction does not exist in this connection scope.");
  if (!transaction) {
    const transactionId = uuidFromHex(await sha256Hex(`${input.connectionId}:${operation}:${input.idempotencyKey}:transaction`));
    transaction = await input.store.createTransactionIfAbsent({
      transactionId,
      scenarioId,
      connectionId: input.connectionId,
      initiatingTenantId: isolatedSimulationTenant(input.initiatingTenantId),
      paeTenantId: SIMULATION_TENANTS.pae,
      parTenantId: SIMULATION_TENANTS.par,
      correlationId: input.correlationId || crypto.randomUUID(),
      canonicalTransaction: fixture,
      createdAt: new Date().toISOString(),
    });
  }

  const executionRunId = uuidFromHex(await sha256Hex(`${input.connectionId}:${operation}:${input.idempotencyKey}:run`));
  const externalNetworkDisabled = input.env.EXTERNAL_NETWORK_DISABLED === "true";
  const flags = simulationFlags(input.env);
  const engine = new PhaseTwoScenarioEngine(
    new SimulatedDirectoryAdapter(),
    new SimulatedRemotePaAdapter(externalNetworkDisabled, options.remotePaOutcome ?? "ACCEPTED"),
    new SimulatedBuyerAdapter(externalNetworkDisabled, options.buyerOutcome ?? "DELIVERED"),
    flags,
    externalNetworkDisabled,
  );
  let execution: SimulationExecution;
  try {
    execution = await engine.execute({
      transactionId: transaction.transactionId,
      correlationId: transaction.correlationId,
      executionRunId,
      canonicalTransaction: transaction.canonicalTransaction,
      validateCanonical: input.validateCanonical,
      directoryQuery: {
        scheme: options.directoryScheme ?? "0225",
        value: options.directoryIdentifier ?? "TEST-FR-BUYER-001",
      },
      interruptAfter: options.interruptAfter,
      resumeFrom,
      scenarioId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "SIMULATION_RUN_NOT_REPLAYABLE") {
      throw new ScenarioServiceError("SIMULATION_RUN_NOT_REPLAYABLE", error.message);
    }
    throw error;
  }
  await input.store.createRun(execution);

  const response: StoredResponse = {
    status: 202,
    body: {
      ok: execution.status === "COMPLETED",
      ...execution,
      versions: {
        application: input.env.APP_VERSION,
        cbm: input.env.CBM_VERSION,
        integrationHubReferenceCommit: "696249b7f53dc7b1f77f0c0ae297e332ae863c88",
        scenario: flags.lifecycleSimulation ? "3.0.0" : "2.0.0",
      },
    },
  };
  await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, response);
  return response;
}

export const executePhaseOneScenario = executePhaseTwoScenario;

export function uuidFromHex(hex: string): string {
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
