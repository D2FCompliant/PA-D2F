import { nextInvoiceStates } from "./lifecycle";
import type { CanonicalEventEnvelope, DirectoryEntry, InvoiceState, StoredInvoice, StoredResponse } from "./types";

type IdempotencyRecord = { fingerprint: string; response: StoredResponse };

export class SandboxRepository {
  constructor(private readonly db: D1Database) {}

  async ensureConnection(id: string, tenantId: string, legalEntityId: string | null): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO sandbox_connections (id, tenant_id, legal_entity_id, created_at) VALUES (?, ?, ?, ?)").bind(id, tenantId, legalEntityId, new Date().toISOString()).run();
  }

  async replaceDirectoryEntry(entry: DirectoryEntry): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM directory WHERE tenant_id = ? AND connection_id = ? AND (siren = ? OR (? IS NOT NULL AND siret = ?))")
        .bind(entry.tenantId, entry.connectionId, entry.siren, entry.siret, entry.siret),
      this.db.prepare("INSERT INTO directory (id, tenant_id, connection_id, siren, siret, electronic_address_scheme, electronic_address, reception_pa, active_from, active_to, source_reference, status, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(entry.id, entry.tenantId, entry.connectionId, entry.siren, entry.siret, entry.electronicAddressScheme, entry.electronicAddress, "D2F_PA_SANDBOX", entry.activeFrom, entry.activeTo, entry.sourceReference, entry.status, JSON.stringify({ testOnly: true }), new Date().toISOString()),
    ]);
  }

  async resolveDirectoryEntry(connectionId: string, tenantId: string, identifiers: Array<{ scheme: string; value: string }>, onDate: string): Promise<DirectoryEntry | null> {
    for (const identifier of identifiers) {
      const column = identifier.scheme === "SIRET" ? "siret" : identifier.scheme === "SIREN" ? "siren" : "";
      if (!column) continue;
      const row = await this.db.prepare(`SELECT * FROM directory WHERE tenant_id = ? AND connection_id = ? AND ${column} = ? AND status = 'active' AND (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to = '' OR active_to >= ?) ORDER BY updated_at DESC LIMIT 1`)
        .bind(tenantId, connectionId, identifier.value, onDate, onDate).first<Record<string, unknown>>();
      if (row) return mapDirectoryEntry(row);
    }
    return null;
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

  async listOperations(tenantId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.db.prepare(`
      SELECT i.id, i.remote_id, i.connection_id, i.format, i.content_type,
             i.payload_sha256, i.current_state, i.correlation_id, i.created_at, i.updated_at,
             e.event_type, e.regulatory_code, e.envelope, e.recorded_at,
             (SELECT first.envelope FROM events first WHERE first.invoice_id = i.id ORDER BY first.sequence ASC LIMIT 1) AS validation_envelope,
             (SELECT COUNT(*) FROM events history WHERE history.invoice_id = i.id) AS event_count
      FROM invoices i
      LEFT JOIN events e ON e.event_id = (
        SELECT latest.event_id FROM events latest
        WHERE latest.invoice_id = i.id
        ORDER BY latest.sequence DESC LIMIT 1
      )
      WHERE i.tenant_id = ?
      ORDER BY i.created_at DESC
      LIMIT ?
    `).bind(tenantId, boundedLimit).all<Record<string, unknown>>();
    return (result.results ?? []).map((row) => {
      const envelope = parseObject(row.envelope);
      const eventPayload = parseObject(envelope.payload);
      const validationEnvelope = parseObject(row.validation_envelope);
      const validationPayload = parseObject(validationEnvelope.payload);
      const issues = Array.isArray(validationPayload.issues) ? validationPayload.issues : [];
      const stages = Array.isArray(validationPayload.stages) ? validationPayload.stages : [];
      const ppf = parseObject(validationPayload.ppfSimulation);
      const flux1 = parseObject(validationPayload.flux1);
      const state = String(row.current_state || "RECEIVED");
      return {
        transactionId: String(row.id), remoteId: String(row.remote_id), connectionId: String(row.connection_id),
        direction: "INBOUND_TO_PA", output: ["ROUTED", "DELIVERED", "MADE_AVAILABLE", "APPROVED", "PROCESSING", "PAID"].includes(state) ? "PPF_SIMULATED" : "NOT_SUBMITTED",
        format: String(row.format), contentType: String(row.content_type), payloadSha256: String(row.payload_sha256),
        status: state, correlationId: String(row.correlation_id),
        eventType: row.event_type ? String(row.event_type) : null,
        regulatoryCode: row.regulatory_code ? String(row.regulatory_code) : null,
        flow: validationPayload.flow ? String(validationPayload.flow) : validationPayload.flux1 ? "1" : null,
        stages, issues, issueCount: issues.length,
        ppfStatus: ppf.status ? String(ppf.status) : null,
        externalNetworkCalled: ppf.externalNetworkCalled === true,
        structuredDocument: Object.keys(flux1).length ? { syntax: String(flux1.syntax || row.format), standard: String(flux1.standard || "DGFiP Flux 1"), version: String(flux1.version || "1.2"), generated: true } : null,
        nextStates: nextInvoiceStates(state as InvoiceState), eventCount: Number(row.event_count || 0),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        recordedAt: row.recorded_at ? String(row.recorded_at) : null,
      };
    });
  }
}

function mapDirectoryEntry(row: Record<string, unknown>): DirectoryEntry {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), connectionId: String(row.connection_id),
    siren: row.siren ? String(row.siren) : null, siret: row.siret ? String(row.siret) : null,
    electronicAddressScheme: String(row.electronic_address_scheme || "0225"), electronicAddress: String(row.electronic_address),
    sourceReference: String(row.source_reference || ""), activeFrom: row.active_from ? String(row.active_from) : null,
    activeTo: row.active_to ? String(row.active_to) : null, status: String(row.status) === "inactive" ? "inactive" : "active",
  };
}

function mapInvoice(row: Record<string, unknown>): StoredInvoice {
  return { id: String(row.id), remoteId: String(row.remote_id), connectionId: String(row.connection_id), tenantId: String(row.tenant_id), format: String(row.format) as StoredInvoice["format"], contentType: String(row.content_type), payloadSha256: String(row.payload_sha256), payload: String(row.payload), currentState: String(row.current_state) as InvoiceState, correlationId: String(row.correlation_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
