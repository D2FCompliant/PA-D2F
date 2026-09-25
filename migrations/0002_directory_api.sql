ALTER TABLE directory ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'legacy-business-suite';
ALTER TABLE directory ADD COLUMN electronic_address_scheme TEXT NOT NULL DEFAULT '0225';
ALTER TABLE directory ADD COLUMN source_reference TEXT;
ALTER TABLE directory ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE directory ADD COLUMN updated_at TEXT;

CREATE INDEX directory_tenant_connection_siren
  ON directory(tenant_id, connection_id, siren, status);
CREATE INDEX directory_tenant_connection_siret
  ON directory(tenant_id, connection_id, siret, status);
