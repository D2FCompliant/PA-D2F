import { sha256Hex } from "../crypto";
import type { StoredResponse } from "../types";
import { SimulatedDirectoryAdapter, SimulatedRemotePaAdapter } from "./adapters";
import { isolatedSimulationTenant, simulationFlags, SIMULATION_SCENARIO_ID, SIMULATION_TENANTS, type SimulationExecution } from "./contracts";
import { assertSyntheticFixture, canonicalHappyPathFixture } from "./fixtures";
import { PhaseOneScenarioEngine } from "./scenario-engine";

export type ScenarioTransactionRecord = {
  transactionId: string;
  scenarioId: typeof SIMULATION_SCENARIO_ID;
  connectionId: string;
  initiatingTenantId: string;
  paeTenantId: typeof SIMULATION_TENANTS.pae;
  parTenantId: typeof SIMULATION_TENANTS.par;
  correlationId: string;
  canonicalTransaction: Record<string, unknown>;
  createdAt: string;
};

export interface ScenarioStore {
  findIdempotency(connectionId: string, operation: string, key: string): Promise<{ fingerprint: string; response: StoredResponse } | null>;
  saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  getTransaction(transactionId: string, connectionId: string): Promise<ScenarioTransactionRecord | null>;
  createTransactionIfAbsent(transaction: ScenarioTransactionRecord): Promise<ScenarioTransactionRecord>;
  createRun(execution: SimulationExecution): Promise<void>;
}

export class ScenarioServiceError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "SIMULATION_TRANSACTION_NOT_FOUND", message: string) {
    super(message);
  }
}

export async function executePhaseOneScenario(input: {
  env: Env;
  store: ScenarioStore;
  connectionId: string;
  initiatingTenantId: string;
  idempotencyKey: string;
  transactionId?: string;
  correlationId?: string;
}): Promise<StoredResponse> {
  const operation = "sandbox.scenario.DEMO-FR-PIPELINE-001.execute";
  const fixture = canonicalHappyPathFixture();
  assertSyntheticFixture(fixture);
  const fingerprint = await sha256Hex(JSON.stringify({ scenarioId: SIMULATION_SCENARIO_ID, transactionId: input.transactionId || null, fixture }));
  const replay = await input.store.findIdempotency(input.connectionId, operation, input.idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw new ScenarioServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used for another simulation request.");
    return { status: 200, body: { ...replay.response.body, idempotentReplay: true } };
  }

  let transaction = input.transactionId ? await input.store.getTransaction(input.transactionId, input.connectionId) : null;
  if (input.transactionId && !transaction) throw new ScenarioServiceError("SIMULATION_TRANSACTION_NOT_FOUND", "The requested simulation transaction does not exist in this connection scope.");
  if (!transaction) {
    const transactionId = uuidFromHex(await sha256Hex(`${input.connectionId}:${operation}:${input.idempotencyKey}:transaction`));
    transaction = await input.store.createTransactionIfAbsent({
      transactionId,
      scenarioId: SIMULATION_SCENARIO_ID,
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
  const engine = new PhaseOneScenarioEngine(
    new SimulatedDirectoryAdapter(),
    new SimulatedRemotePaAdapter(input.env.EXTERNAL_NETWORK_DISABLED === "true"),
    simulationFlags(input.env),
    input.env.EXTERNAL_NETWORK_DISABLED === "true",
  );
  const execution = await engine.execute({
    transactionId: transaction.transactionId,
    correlationId: transaction.correlationId,
    executionRunId,
    canonicalTransaction: transaction.canonicalTransaction,
  });
  await input.store.createRun(execution);

  const response: StoredResponse = {
    status: 202,
    body: {
      ok: true,
      ...execution,
      versions: {
        application: input.env.APP_VERSION,
        cbm: input.env.CBM_VERSION,
        integrationHubReferenceCommit: "696249b7f53dc7b1f77f0c0ae297e332ae863c88",
        scenario: "1.0.0",
      },
    },
  };
  await input.store.saveIdempotency(input.connectionId, operation, input.idempotencyKey, fingerprint, response);
  return response;
}

function uuidFromHex(hex: string): string {
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
