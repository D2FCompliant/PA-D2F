CREATE TABLE simulation_transactions (
  transaction_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  initiating_tenant_id TEXT NOT NULL,
  pae_tenant_id TEXT NOT NULL CHECK (pae_tenant_id = 'D2F-PAE-SIM'),
  par_tenant_id TEXT NOT NULL CHECK (par_tenant_id = 'D2F-PAR-SIM'),
  correlation_id TEXT NOT NULL,
  canonical_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX simulation_transactions_connection
  ON simulation_transactions(connection_id, transaction_id);

CREATE TABLE simulation_runs (
  execution_run_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES simulation_transactions(transaction_id)
);

CREATE INDEX simulation_runs_transaction
  ON simulation_runs(transaction_id, created_at);

CREATE TABLE simulation_messages (
  message_id TEXT PRIMARY KEY,
  execution_run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provenance TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_run_id, sequence),
  FOREIGN KEY (execution_run_id) REFERENCES simulation_runs(execution_run_id)
);
