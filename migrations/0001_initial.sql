CREATE TABLE sandbox_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  legal_entity_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  remote_id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  format TEXT NOT NULL,
  content_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload TEXT NOT NULL,
  current_state TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES sandbox_connections(id)
);
CREATE INDEX invoices_tenant_remote ON invoices(tenant_id, remote_id);

CREATE TABLE idempotency (
  connection_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, operation, key)
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  regulatory_code TEXT,
  envelope TEXT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (invoice_id, sequence),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

CREATE TABLE directory (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  siren TEXT,
  siret TEXT,
  electronic_address TEXT NOT NULL,
  reception_pa TEXT,
  active_from TEXT,
  active_to TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE scenarios (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  configuration TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  response_status INTEGER,
  created_at TEXT NOT NULL
);
