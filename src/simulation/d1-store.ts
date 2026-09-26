import type { StoredResponse } from "../types";
import type { SimulationExecution, SimulationStep } from "./contracts";
import type { ScenarioStore, ScenarioTrace, ScenarioTransactionRecord } from "./service";

export class D1ScenarioStore implements ScenarioStore {
  constructor(private readonly db: D1Database) {}

  async findIdempotency(connectionId: string, operation: string, key: string) {
    const row = await this.db.prepare("SELECT fingerprint, response_status, response_body FROM idempotency WHERE connection_id = ? AND operation = ? AND key = ?")
      .bind(connectionId, operation, key).first<{ fingerprint: string; response_status: number; response_body: string }>();
    return row ? { fingerprint: row.fingerprint, response: { status: row.response_status, body: JSON.parse(row.response_body) as Record<string, unknown> } } : null;
  }

  async saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse): Promise<void> {
    await this.db.prepare("INSERT INTO idempotency (connection_id, operation, key, fingerprint, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(connectionId, operation, key, fingerprint, response.status, JSON.stringify(response.body), new Date().toISOString()).run();
  }

  async getTransaction(transactionId: string, connectionId: string): Promise<ScenarioTransactionRecord | null> {
    const row = await this.db.prepare("SELECT * FROM simulation_transactions WHERE transaction_id = ? AND connection_id = ?")
      .bind(transactionId, connectionId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      transactionId: String(row.transaction_id),
      scenarioId: "DEMO-FR-PIPELINE-001",
      connectionId: String(row.connection_id),
      initiatingTenantId: String(row.initiating_tenant_id),
      paeTenantId: "D2F-PAE-SIM",
      parTenantId: "D2F-PAR-SIM",
      correlationId: String(row.correlation_id),
      canonicalTransaction: JSON.parse(String(row.canonical_payload)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    };
  }

  async createTransactionIfAbsent(transaction: ScenarioTransactionRecord): Promise<ScenarioTransactionRecord> {
    await this.db.prepare(`INSERT OR IGNORE INTO simulation_transactions
      (transaction_id, scenario_id, connection_id, initiating_tenant_id, pae_tenant_id, par_tenant_id, correlation_id, canonical_payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(transaction.transactionId, transaction.scenarioId, transaction.connectionId, transaction.initiatingTenantId, transaction.paeTenantId, transaction.parTenantId, transaction.correlationId, JSON.stringify(transaction.canonicalTransaction), transaction.createdAt).run();
    const stored = await this.getTransaction(transaction.transactionId, transaction.connectionId);
    if (!stored) throw new Error("SIMULATION_TRANSACTION_PERSISTENCE_FAILED");
    return stored;
  }

  async getExecutionRun(executionRunId: string, connectionId: string): Promise<SimulationExecution | null> {
    const row = await this.db.prepare(`SELECT r.result
      FROM simulation_runs r
      JOIN simulation_transactions t ON t.transaction_id = r.transaction_id
      WHERE r.execution_run_id = ? AND t.connection_id = ?`)
      .bind(executionRunId, connectionId).first<{ result: string }>();
    return row ? JSON.parse(row.result) as SimulationExecution : null;
  }

  async createRun(execution: SimulationExecution): Promise<void> {
    const createdAt = execution.steps[0]?.timestamp ?? new Date().toISOString();
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO simulation_runs
        (execution_run_id, transaction_id, correlation_id, status, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(execution.executionRunId, execution.transactionId, execution.correlationId, execution.status, JSON.stringify(execution), createdAt),
      ...execution.steps.map((step) => this.db.prepare(`INSERT OR IGNORE INTO simulation_messages
        (message_id, execution_run_id, sequence, actor, event_type, provenance, payload, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          crypto.randomUUID(),
          execution.executionRunId,
          step.sequence,
          step.actor,
          step.event,
          step.provenance,
          JSON.stringify(step),
          step.timestamp,
        )),
    ]);
  }

  async getTrace(transactionId: string, connectionId: string): Promise<ScenarioTrace | null> {
    const transaction = await this.getTransaction(transactionId, connectionId);
    if (!transaction) return null;
    const runRows = await this.db.prepare(`SELECT r.result
      FROM simulation_runs r
      JOIN simulation_transactions t ON t.transaction_id = r.transaction_id
      WHERE r.transaction_id = ? AND t.connection_id = ?
      ORDER BY r.rowid`)
      .bind(transactionId, connectionId).all<{ result: string }>();
    const messageRows = await this.db.prepare(`SELECT m.payload
      FROM simulation_messages m
      JOIN simulation_runs r ON r.execution_run_id = m.execution_run_id
      JOIN simulation_transactions t ON t.transaction_id = r.transaction_id
      WHERE r.transaction_id = ? AND t.connection_id = ?
      ORDER BY r.rowid, m.sequence`)
      .bind(transactionId, connectionId).all<{ payload: string }>();
    const { canonicalTransaction: _canonicalTransaction, ...safeTransaction } = transaction;
    return {
      transaction: safeTransaction,
      runs: runRows.results.map((row) => JSON.parse(row.result) as SimulationExecution),
      messages: messageRows.results.map((row) => JSON.parse(row.payload) as SimulationStep),
    };
  }
}
