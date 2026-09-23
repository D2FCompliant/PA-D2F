import type { AuthContext, CanonicalEventEnvelope } from "./types";

export function invoiceEvent(input: {
  type: string;
  invoiceId: string;
  aggregateVersion: number;
  auth: AuthContext;
  appVersion: string;
  correlationId: string;
  causationId?: string | null;
  payload: Record<string, unknown>;
  category?: CanonicalEventEnvelope["eventCategory"];
}): CanonicalEventEnvelope {
  const now = new Date().toISOString();
  return {
    eventId: crypto.randomUUID(),
    eventType: input.type,
    eventVersion: 1,
    eventCategory: input.category ?? "integration",
    occurredAt: now,
    recordedAt: now,
    producer: { application: "D2F PA Sandbox", service: "regulatory-simulation", instance: null, version: input.appVersion },
    subject: { aggregateType: "Invoice", aggregateId: input.invoiceId, aggregateVersion: input.aggregateVersion },
    context: { tenantId: input.auth.tenantId, organizationId: null, legalEntityId: input.auth.legalEntityId, establishmentId: null, countryContext: "FR", languageContext: "fr-FR" },
    actor: { actorType: "connector", actorId: input.auth.connectionId, delegatedBy: null },
    trace: { correlationId: input.correlationId, causationId: input.causationId ?? null, commandId: null, workflowInstanceId: null, traceId: null },
    contract: { schemaId: "https://schemas.d2fcompliant.com/events/event-envelope.v1.schema.json", schemaVersion: 1, contentType: "application/json" },
    security: { classification: "confidential", containsPersonalData: true, containsFinancialData: true, encryptionRequired: true },
    payload: input.payload,
    metadata: { environment: "sandbox", testEvidence: true }
  };
}
