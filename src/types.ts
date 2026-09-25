export type InvoiceFormat = "UBL" | "CII" | "FACTUR-X" | "UNKNOWN";

export type ValidationIssue = {
  code: string;
  severity: "error" | "warning" | "information";
  source: "transport" | "mime" | "xml" | "xsd" | "en16931" | "fr-profile" | "schematron" | "business" | "routing" | "scenario";
  rule: string;
  message: string;
  path: string;
  standard: string;
  standardVersion: string;
};

export type InvoiceState = "RECEIVED" | "REJECTED" | "ROUTED" | "DELIVERED" | "MADE_AVAILABLE" | "APPROVED" | "REFUSED" | "DISPUTED" | "SUSPENDED" | "PROCESSING" | "PAID";

export type StoredInvoice = {
  id: string;
  remoteId: string;
  connectionId: string;
  tenantId: string;
  format: InvoiceFormat;
  contentType: string;
  payloadSha256: string;
  payload: string;
  currentState: InvoiceState;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredResponse = { status: number; body: Record<string, unknown> };

export type DirectoryEntry = {
  id: string;
  tenantId: string;
  connectionId: string;
  siren: string | null;
  siret: string | null;
  electronicAddressScheme: string;
  electronicAddress: string;
  sourceReference: string;
  activeFrom: string | null;
  activeTo: string | null;
  status: "active" | "inactive";
};

export type AuthContext = {
  connectionId: string;
  tenantId: string;
  legalEntityId: string | null;
  scopes: string[];
  authMode: "bearer" | "api-key";
};

export type CanonicalEventEnvelope = {
  eventId: string;
  eventType: string;
  eventVersion: number;
  eventCategory: "business" | "integration" | "platform" | "regulatory";
  occurredAt: string;
  recordedAt: string;
  producer: { application: string; service: string; instance: string | null; version: string };
  subject: { aggregateType: string; aggregateId: string; aggregateVersion: number };
  context: { tenantId: string; organizationId: string | null; legalEntityId: string | null; establishmentId: string | null; countryContext: string | null; languageContext: string | null };
  actor: { actorType: "user" | "service" | "system" | "connector" | "ai"; actorId: string; delegatedBy: string | null };
  trace: { correlationId: string; causationId: string | null; commandId: string | null; workflowInstanceId: string | null; traceId: string | null };
  contract: { schemaId: string; schemaVersion: number; contentType: string };
  security: { classification: "public" | "internal" | "confidential" | "restricted"; containsPersonalData: boolean; containsFinancialData: boolean; encryptionRequired: boolean };
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};
