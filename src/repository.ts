import type { CanonicalEventEnvelope, InvoiceState, StoredInvoice, StoredResponse } from "./types";

type IdempotencyRecord = { fingerprint: string; response: StoredResponse };

export class SandboxRepository {
  constructor(private readonly db: D1Database) {}

  async ensureConnection(id: string, tenantId: string, legalEntityId: string | null): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO sandbox_connections (id, tenant_id, legal_entity_id, created_at) VALUES (?, ?, ?, ?)").bind(id, tenantId, legalEntityId, new Date().toISOString()).run();
  }

  async createInvoice(invoice: StoredInvoice): Promise<void> {
    await this.db.prepare("INSERT INTO invoices (id, remote_id, connection_id, tenant_id, format, content_type, payload_sha256, payload, current_state, correlation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(invoice.id, invoice.remoteId, invoice.connectionId, invoice.tenantId, invoice.format, invoice.contentType, invoice.payloadSha256, invoice.payload, invoice.currentState, invoice.correlationId, invoice.createdAt, invoice.updatedAt).run();
  }

  async getInvoice(identifier: string, tenantId: string): Promise<StoredInvoice | null> {
    const row = await this.db.prepare("SELECT * FROM invoices WHERE (id = ? OR remote_id = ?) AND tenant_id = ?").bind(identifier, identifier, tenantId).first<Record<string, unknown>>();
    return row ? mapInvoice(row) : null;
  }

  async updateInvoiceState(id: string, tenantId: string, state: InvoiceState): Promise<void> {
    await this.db.prepare("UPDATE invoices SET current_state = ?, updated_at = ? WHERE id = ? AND tenant_id = ?").bind(state, new Date().toISOString(), id, tenantId).run();
  }

  async findIdempotency(connectionId: string, operation: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.db.prepare("SELECT fingerprint, response_status, response_body FROM idempotency WHERE connection_id = ? AND operation = ? AND key = ?").bind(connectionId, operation, key).first<{ fingerprint: string; response_status: number; response_body: string }>();
    return row ? { fingerprint: row.fingerprint, response: { status: row.response_status, body: JSON.parse(row.response_body) as Record<string, unknown> } } : null;
  }

  async saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse): Promise<void> {
    await this.db.prepare("INSERT INTO idempotency (connection_id, operation, key, fingerprint, response_status, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(connectionId, operation, key, fingerprint, response.status, JSON.stringify(response.body), new Date().toISOString()).run();
  }

  async appendEvent(invoiceId: string, event: CanonicalEventEnvelope, regulatoryCode: string | null = null): Promise<void> {
    const previous = await this.db.prepare("SELECT hash FROM events WHERE invoice_id = ? ORDER BY sequence DESC LIMIT 1").bind(invoiceId).first<{ hash: string }>();
    const material = `${previous?.hash ?? "GENESIS"}:${JSON.stringify(event)}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await this.db.prepare("INSERT INTO events (event_id, invoice_id, sequence, event_type, regulatory_code, envelope, previous_hash, hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(event.eventId, invoiceId, event.subject.aggregateVersion, event.eventType, regulatoryCode, JSON.stringify(event), previous?.hash ?? null, hash, event.recordedAt).run();
  }

  async trace(identifier: string, tenantId: string): Promise<{ invoice: StoredInvoice; events: CanonicalEventEnvelope[] } | null> {
    const invoice = await this.getInvoice(identifier, tenantId);
    if (!invoice) return null;
    const result = await this.db.prepare("SELECT envelope FROM events WHERE invoice_id = ? ORDER BY sequence").bind(invoice.id).all<{ envelope: string }>();
    return { invoice, events: (result.results ?? []).map((row) => JSON.parse(row.envelope) as CanonicalEventEnvelope) };
  }
}

function mapInvoice(row: Record<string, unknown>): StoredInvoice {
  return { id: String(row.id), remoteId: String(row.remote_id), connectionId: String(row.connection_id), tenantId: String(row.tenant_id), format: String(row.format) as StoredInvoice["format"], contentType: String(row.content_type), payloadSha256: String(row.payload_sha256), payload: String(row.payload), currentState: String(row.current_state) as InvoiceState, correlationId: String(row.correlation_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
