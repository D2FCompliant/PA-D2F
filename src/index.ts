import { authenticate } from "./auth";
import { sha256Hex } from "./crypto";
import { invoiceEvent } from "./events";
import { assertTransition, REGULATORY_CODES } from "./lifecycle";
import { SandboxRepository } from "./repository";
import type { AuthContext, InvoiceState, StoredInvoice, StoredResponse, ValidationIssue } from "./types";
import { baselineNotices, detectInvoiceFormat, validateTransport, validateXmlStructure } from "./validation";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-d2f-environment": "SANDBOX / TEST ONLY" };
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", service: "d2f-pa-sandbox", message: error instanceof Error ? error.message : String(error) }));
      return problem(500, "SANDBOX_INTERNAL_ERROR", "The sandbox could not process the request.");
    }
  }
} satisfies ExportedHandler<Env>;

export async function route(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const repository = new SandboxRepository(env.DB);

  if (request.method === "GET" && url.pathname === "/") return html(portal(env));
  if (request.method === "GET" && url.pathname === "/health") return json(200, health(env));
  if (request.method === "GET" && url.pathname === "/openapi.yaml") return new Response(openApi(env), { headers: { "content-type": "application/yaml; charset=utf-8", "cache-control": "public, max-age=300" } });

  if (url.pathname === "/invoices" && request.method === "POST") {
    const auth = authenticate(request, env);
    if (!auth) return problem(401, "INVALID_AUTH", "Bearer or configured API-key authentication is required.");
    return submitLegacyInvoice(request, env, repository, auth);
  }

  const legacyInvoiceMatch = url.pathname.match(/^\/invoices\/([^/]+)$/);
  if (legacyInvoiceMatch && request.method === "GET") {
    const auth = authenticate(request, env);
    if (!auth) return problem(401, "INVALID_AUTH", "Bearer or configured API-key authentication is required.");
    const invoice = await repository.getInvoice(decodeURIComponent(legacyInvoiceMatch[1] ?? ""), auth.tenantId);
    return invoice ? json(200, publicInvoice(invoice)) : problem(404, "INVOICE_NOT_FOUND", "No sandbox invoice matches this identifier.");
  }

  if (url.pathname === "/api/v1/transactions" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return submitCanonicalTransaction(request, env, repository, auth);
  }

  const traceMatch = url.pathname.match(/^\/sandbox\/v1\/traces\/([^/]+)$/);
  if (traceMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const trace = await repository.trace(decodeURIComponent(traceMatch[1] ?? ""), auth.tenantId);
    return trace ? json(200, { environment: "sandbox", testEvidence: true, ...trace }) : problem(404, "TRACE_NOT_FOUND", "No trace matches this identifier.");
  }

  const lifecycleMatch = url.pathname.match(/^\/sandbox\/v1\/invoices\/([^/]+)\/lifecycle$/);
  if (lifecycleMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return transitionInvoice(request, env, repository, auth, decodeURIComponent(lifecycleMatch[1] ?? ""));
  }

  return problem(404, "ROUTE_NOT_FOUND", "The requested sandbox route does not exist.");
}

async function submitLegacyInvoice(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) return validationProblem(413, [validationIssue("DOCUMENT_TOO_LARGE", "transport", "TRANSPORT-002", `The document exceeds ${MAX_BODY_BYTES} bytes.`)]);
  const payload = await request.text();
  const contentType = request.headers.get("content-type") || "application/xml";
  const format = detectInvoiceFormat(contentType, payload);
  const issues = [...validateTransport(contentType, payload), ...validateXmlStructure(payload, format)];
  if (issues.some((issue) => issue.severity === "error")) return validationProblem(422, issues);

  const fingerprint = await sha256Hex(payload);
  const key = request.headers.get("idempotency-key")?.trim() || `legacy:${fingerprint}`;
  const replay = await repository.findIdempotency(auth.connectionId, "legacy.invoice.submit", key);
  if (replay) {
    if (replay.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different content.");
    return json(replay.response.status, { ...replay.response.body, idempotent_replay: true });
  }

  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  const invoice = newInvoice(auth, format, contentType, payload, fingerprint);
  await repository.createInvoice(invoice);
  const event = invoiceEvent({ type: "InvoiceReceivedByPa", invoiceId: invoice.id, aggregateVersion: 1, auth, appVersion: env.APP_VERSION, correlationId: invoice.correlationId, payload: { remoteId: invoice.remoteId, format, payloadSha256: fingerprint } });
  await repository.appendEvent(invoice.id, event);

  const response: StoredResponse = { status: 202, body: { id: invoice.remoteId, remote_id: invoice.remoteId, status: "submitted", environment: "sandbox", warnings: baselineNotices(format) } };
  await repository.saveIdempotency(auth.connectionId, "legacy.invoice.submit", key, fingerprint, response);
  return json(response.status, response.body);
}

async function submitCanonicalTransaction(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
  const body = await safeJson(request);
  if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
  const issues = validateCanonical(body);
  if (issues.length) return validationProblem(422, issues);
  const canonical = JSON.stringify(body);
  const fingerprint = await sha256Hex(canonical);
  const replay = await repository.findIdempotency(auth.connectionId, "canonical.transaction.submit", idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different canonical transaction.");
    return json(200, { ...replay.response.body, idempotent_replay: true });
  }

  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  const invoice = newInvoice(auth, "UNKNOWN", "application/json", canonical, fingerprint);
  await repository.createInvoice(invoice);
  const event = invoiceEvent({ type: "InvoiceReceivedByPa", invoiceId: invoice.id, aggregateVersion: 1, auth, appVersion: env.APP_VERSION, correlationId: invoice.correlationId, payload: { remoteId: invoice.remoteId, cbmVersion: env.CBM_VERSION, externalId: body.externalId } });
  await repository.appendEvent(invoice.id, event);
  const response: StoredResponse = { status: 202, body: { ok: true, transactionId: invoice.id, remote_id: invoice.remoteId, status: "RECEIVED", correlationId: invoice.correlationId, versions: { api: "1.0.0", cbm: env.CBM_VERSION, application: env.APP_VERSION } } };
  await repository.saveIdempotency(auth.connectionId, "canonical.transaction.submit", idempotencyKey, fingerprint, response);
  return json(response.status, response.body);
}

async function transitionInvoice(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext, invoiceId: string): Promise<Response> {
  const body = await safeJson(request);
  const nextState = String(body?.state || "").toUpperCase() as InvoiceState;
  const trace = await repository.trace(invoiceId, auth.tenantId);
  const invoice = trace?.invoice as StoredInvoice | undefined;
  if (!invoice) return problem(404, "INVOICE_NOT_FOUND", "No sandbox invoice matches this identifier.");
  try {
    assertTransition(invoice.currentState, nextState);
  } catch (error) {
    return problem(422, "OUT_OF_ORDER_LIFECYCLE", error instanceof Error ? error.message : "Invalid lifecycle transition.");
  }
  await repository.updateInvoiceState(invoice.id, auth.tenantId, nextState);
  const event = invoiceEvent({ type: lifecycleEventType(nextState), invoiceId: invoice.id, aggregateVersion: ((trace?.events as unknown[])?.length ?? 0) + 1, auth, appVersion: env.APP_VERSION, correlationId: invoice.correlationId, payload: { previousState: invoice.currentState, state: nextState, regulatoryCode: REGULATORY_CODES[nextState] ?? null }, category: REGULATORY_CODES[nextState] ? "regulatory" : "integration" });
  await repository.appendEvent(invoice.id, event, REGULATORY_CODES[nextState] ?? null);
  return json(202, { ok: true, invoiceId: invoice.id, previousState: invoice.currentState, state: nextState, regulatoryCode: REGULATORY_CODES[nextState] ?? null, eventId: event.eventId });
}

function newInvoice(auth: AuthContext, format: StoredInvoice["format"], contentType: string, payload: string, payloadSha256: string): StoredInvoice {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return { id, remoteId: `sbx_inv_${id}`, connectionId: auth.connectionId, tenantId: auth.tenantId, format, contentType, payloadSha256, payload, currentState: "RECEIVED", correlationId: crypto.randomUUID(), createdAt: now, updatedAt: now };
}

function publicInvoice(invoice: StoredInvoice): Record<string, unknown> {
  return { id: invoice.remoteId, remote_id: invoice.remoteId, status: invoice.currentState.toLowerCase(), format: invoice.format, correlation_id: invoice.correlationId, created_at: invoice.createdAt, updated_at: invoice.updatedAt, environment: "sandbox" };
}

function validateCanonical(body: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (body.type !== "INVOICE") issues.push(validationIssue("UNSUPPORTED_TRANSACTION_TYPE", "business", "CBM-TYPE-001", "This increment accepts canonical INVOICE transactions only."));
  if (!String(body.externalId || "").trim()) issues.push(validationIssue("MISSING_SOURCE_REQUIRED_FIELD", "business", "CBM-EXT-001", "externalId is required.", "/externalId"));
  const source = object(body.source);
  if (!String(source.system || "").trim()) issues.push(validationIssue("MISSING_SOURCE_REQUIRED_FIELD", "business", "CBM-SOURCE-001", "source.system is required.", "/source/system"));
  if (!Object.keys(object(body.seller)).length) issues.push(validationIssue("MISSING_SOURCE_REQUIRED_FIELD", "business", "CBM-SELLER-001", "seller is required.", "/seller"));
  if (!Object.keys(object(body.buyer)).length) issues.push(validationIssue("MISSING_SOURCE_REQUIRED_FIELD", "business", "CBM-BUYER-001", "buyer is required.", "/buyer"));
  return issues;
}

function validationIssue(code: string, source: ValidationIssue["source"], rule: string, message: string, path = "/"): ValidationIssue {
  return { code, severity: "error", source, rule, message, path, standard: source === "business" ? "d2f.cbm.v2" : "DGFiP external specifications", standardVersion: source === "business" ? "2.1.0" : "3.2" };
}

function lifecycleEventType(state: InvoiceState): string {
  const map: Record<InvoiceState, string> = { RECEIVED: "InvoiceReceivedByPa", REJECTED: "InvoiceRejectedByPa", ROUTED: "InvoiceRouted", DELIVERED: "InvoiceDelivered", MADE_AVAILABLE: "InvoiceMadeAvailable", APPROVED: "InvoiceApproved", REFUSED: "InvoiceRefused", DISPUTED: "InvoiceDisputed", SUSPENDED: "InvoiceSuspended", PROCESSING: "InvoiceProcessing", PAID: "LifecycleEmitted" };
  return map[state];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function safeJson(request: Request): Promise<Record<string, unknown> | null> {
  try { return object(await request.json()); } catch { return null; }
}

function health(env: Env): Record<string, unknown> {
  return { ok: true, service: "d2f-pa-sandbox", status: "UP", environment: "sandbox", warning: "SANDBOX / TEST ONLY — not an accredited Plateforme Agréée", version: env.APP_VERSION, apiVersion: "1.0.0", cbmVersion: env.CBM_VERSION, dgfipBaseline: env.DGFiP_BASELINE, externalNetworkDisabled: env.EXTERNAL_NETWORK_DISABLED === "true", timestamp: new Date().toISOString() };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function problem(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message }, environment: "sandbox", correlationId: crypto.randomUUID() });
}

function validationProblem(status: number, issues: ValidationIssue[]): Response {
  return json(status, { ok: false, error: { code: "VALIDATION_FAILED", message: "The submitted document failed sandbox validation." }, validation: issues, environment: "sandbox", correlationId: crypto.randomUUID() });
}

function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-d2f-environment": "SANDBOX / TEST ONLY" } });
}

function portal(env: Env): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D2F PA Sandbox</title><style>:root{color-scheme:dark;background:#07111f;color:#edf6ff;font:16px/1.5 system-ui}body{margin:0}.banner{background:#f5a623;color:#111;padding:.65rem;text-align:center;font-weight:900;letter-spacing:.16em}.wrap{max-width:960px;margin:auto;padding:4rem 1.5rem}h1{font-size:clamp(2.4rem,7vw,5.8rem);line-height:.95;margin:.25rem 0 1.5rem}.tag{color:#6ee7ff;text-transform:uppercase;letter-spacing:.13em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-top:3rem}.card{border:1px solid #25415d;background:#0d1c2d;border-radius:18px;padding:1.25rem}.card b{display:block;color:#6ee7ff;margin-bottom:.5rem}.ok{color:#62e6a7}code{background:#14283d;padding:.15rem .35rem;border-radius:5px}</style></head><body><div class="banner">SANDBOX / TEST ONLY — NOT AN ACCREDITED PA</div><main class="wrap"><p class="tag">D2F regulatory simulation</p><h1>Test the flow.<br>Keep production safe.</h1><p>D2F PA Sandbox is an isolated simulation service for Business Suite and Enterprise Platform integration tests.</p><div class="grid"><section class="card"><b>Runtime</b><span class="ok">● UP</span><p>Version ${escapeHtml(env.APP_VERSION)} · DGFiP baseline ${escapeHtml(env.DGFiP_BASELINE)}</p></section><section class="card"><b>Network safety</b><p><code>EXTERNAL_NETWORK_DISABLED=${escapeHtml(env.EXTERNAL_NETWORK_DISABLED)}</code></p></section><section class="card"><b>Compatibility</b><p><code>GET /health</code><br><code>POST /invoices</code><br><code>GET /invoices/{id}</code></p></section><section class="card"><b>Developer contract</b><p><a href="/openapi.yaml" style="color:#6ee7ff">OpenAPI definition</a></p></section></div></main></body></html>`;
}

function openApi(env: Env): string {
  return `openapi: 3.1.0\ninfo:\n  title: D2F PA Sandbox API\n  version: ${env.APP_VERSION}\n  description: SANDBOX / TEST ONLY. This service is not an accredited Plateforme Agréée.\npaths:\n  /health:\n    get:\n      security: []\n      responses:\n        '200': { description: Sandbox health and version }\n  /invoices:\n    post:\n      summary: D2F Business Suite raw XML compatibility endpoint\n      parameters:\n        - { name: Idempotency-Key, in: header, required: false, schema: { type: string } }\n      requestBody:\n        required: true\n        content:\n          application/xml: { schema: { type: string } }\n      responses:\n        '202': { description: Submitted to the sandbox engine }\n        '409': { description: Idempotency conflict }\n        '422': { description: Structured validation errors }\n  /invoices/{id}:\n    get:\n      parameters:\n        - { name: id, in: path, required: true, schema: { type: string } }\n      responses:\n        '200': { description: Normalized invoice state }\n  /api/v1/transactions:\n    post:\n      summary: D2F CBM 2.1 canonical transaction submission\n      parameters:\n        - { name: X-D2F-Connection-Id, in: header, required: true, schema: { type: string } }\n        - { name: Idempotency-Key, in: header, required: true, schema: { type: string, minLength: 16, maxLength: 200 } }\n      responses:\n        '202': { description: Canonical transaction accepted }\n  /sandbox/v1/invoices/{id}/lifecycle:\n    post:\n      summary: Sandbox-only lifecycle transition control\n      responses:\n        '202': { description: Transition accepted and evidence recorded }\n        '422': { description: Out-of-order lifecycle transition }\n`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
