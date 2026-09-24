import { authenticate } from "./auth";
import { validateAnnuaire, type AnnuaireFlow } from "./annuaire";
import { sha256Hex } from "./crypto";
import { resolveSandboxDirectory } from "./directory-resolution";
import { validateEReporting } from "./e-reporting";
import { invoiceEvent } from "./events";
import { extractFlux1, simulatePpf } from "./flux1";
import { validateFormalInvoice } from "./formal-validation";
import { assertTransition, nextInvoiceStates, REGULATORY_CODES } from "./lifecycle";
import { SandboxRepository } from "./repository";
import { preflightCanonicalTransaction } from "./cbm-preflight";
import { regulatoryCoverage } from "./regulatory-coverage";
import { buildDispatchPlan } from "./routing-plan";
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
  if (request.method === "GET" && url.pathname === "/sandbox/v1/regulatory/coverage") return json(200, regulatoryCoverage(env.APP_VERSION, env.DGFiP_BASELINE));

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

  if (url.pathname === "/sandbox/v1/preflight/cbm" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const body = await safeJson(request);
    if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
    return json(200, { ok: true, result: preflightCanonicalTransaction(body), coverage: regulatoryCoverage(env.APP_VERSION, env.DGFiP_BASELINE), environment: "sandbox", testEvidence: true });
  }

  if (url.pathname === "/sandbox/v1/validate/flux1" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return validateFlux1(request, env, repository, auth);
  }

  if (url.pathname === "/sandbox/v1/validate/ereporting" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return validateEReportingSubmission(request, env, repository, auth);
  }

  const annuaireValidationMatch = url.pathname.match(/^\/sandbox\/v1\/validate\/annuaire\/(12|13|14)$/);
  if (annuaireValidationMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return validateAnnuaireSubmission(request, env, repository, auth, annuaireValidationMatch[1] as AnnuaireFlow);
  }

  const traceMatch = url.pathname.match(/^\/sandbox\/v1\/traces\/([^/]+)$/);
  if (traceMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const trace = await repository.trace(decodeURIComponent(traceMatch[1] ?? ""), auth.tenantId);
    return trace ? json(200, { environment: "sandbox", testEvidence: true, ...trace }) : problem(404, "TRACE_NOT_FOUND", "No trace matches this identifier.");
  }

  if (url.pathname === "/sandbox/v1/operations" && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const requestedLimit = Number(url.searchParams.get("limit") || "100");
    const operations = await repository.listOperations(auth.tenantId, Number.isFinite(requestedLimit) ? requestedLimit : 100);
    return json(200, {
      ok: true, service: "d2f-pa-sandbox", environment: "sandbox", tenantId: auth.tenantId,
      count: operations.length,
      totals: {
        accepted: operations.filter((item) => ["ROUTED", "DELIVERED", "MADE_AVAILABLE", "APPROVED", "PROCESSING", "PAID"].includes(String(item.status))).length,
        rejected: operations.filter((item) => item.status === "REJECTED").length,
        pending: operations.filter((item) => !["ROUTED", "DELIVERED", "MADE_AVAILABLE", "APPROVED", "PROCESSING", "PAID", "REJECTED"].includes(String(item.status))).length,
      },
      operations,
    });
  }

  if (url.pathname === "/sandbox/v1/directory/resolve" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return resolveDirectory(request, env, repository, auth);
  }

  if (url.pathname === "/sandbox/v1/directory/entries" && request.method === "PUT") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return provisionDirectoryEntry(request, env, repository, auth);
  }

  const lifecycleReadMatch = url.pathname.match(/^\/sandbox\/v1\/invoices\/([^/]+)\/lifecycle$/);
  if (lifecycleReadMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const identifier = decodeURIComponent(lifecycleReadMatch[1] ?? "");
    const trace = await repository.trace(identifier, auth.tenantId);
    if (!trace) return problem(404, "INVOICE_NOT_FOUND", "No sandbox invoice matches this identifier.");
    return json(200, {
      ok: true, environment: "sandbox", testEvidence: true, invoice: publicInvoice(trace.invoice),
      lifecycle: { currentState: trace.invoice.currentState, nextStates: nextInvoiceStates(trace.invoice.currentState), events: trace.events },
      links: operationLinks(trace.invoice.id),
    });
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
  const formal = issues.some((issue) => issue.severity === "error") ? { stages: [], issues: [] as ValidationIssue[] } : await validateFormalInvoice(payload, format);
  issues.push(...formal.issues);
  const flux1 = format === "UBL" ? extractFlux1(payload) : null;
  const ppfSimulation = flux1 ? simulatePpf(flux1, issues.some((issue) => issue.severity === "error")) : { status: issues.some((issue) => issue.severity === "error") ? "REJECTED" : "ACCEPTED", issues: [], externalNetworkCalled: false, target: "PPF sandbox simulation" };
  issues.push(...ppfSimulation.issues.map((item) => ({ ...item, severity: item.severity as ValidationIssue["severity"], source: item.source as ValidationIssue["source"], standard: "PPF sandbox simulation", standardVersion: env.DGFiP_BASELINE })));
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
  invoice.currentState = "ROUTED";
  await repository.createInvoice(invoice);
  const dispatchPlan = buildDispatchPlan({
    type: "INVOICE", document: { syntax: format },
    routing: { electronicAddress: flux1?.fields["BT-49"] || null, receiverPa: "SIMULATED_PAR" },
  }, "FR_DOMESTIC_B2B");
  const event = invoiceEvent({
    type: "SandboxInvoiceRouted",
    invoiceId: invoice.id, aggregateVersion: 1, auth, appVersion: env.APP_VERSION, correlationId: invoice.correlationId,
    category: "regulatory",
    payload: {
      remoteId: invoice.remoteId, format, payloadSha256: fingerprint, stages: formal.stages, issues, flux1, ppfSimulation, dispatchPlan,
      simulation: { senderPa: "D2F_PA_SANDBOX", receiverPa: "SIMULATED_PAR", ppf: "SIMULATED_PPF_CONCENTRATOR", directory: "SIMULATED_PPF_DIRECTORY", externalNetworkCalled: false, testEvidence: true },
    },
  });
  await repository.appendEvent(invoice.id, event);

  const response: StoredResponse = { status: 202, body: { id: invoice.remoteId, remote_id: invoice.remoteId, transaction_id: invoice.id, status: "routed", environment: "sandbox", testEvidence: true, externalNetworkCalled: false, dispatchPlan, ppfSimulation, links: operationLinks(invoice.id), warnings: baselineNotices(format) } };
  await repository.saveIdempotency(auth.connectionId, "legacy.invoice.submit", key, fingerprint, response);
  return json(response.status, response.body);
}

async function resolveDirectory(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const body = await safeJson(request);
  if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
  const identifiers = Array.isArray(body.identifiers) ? body.identifiers.map(object) : [];
  const identifier = (scheme: string) => String(identifiers.find((item) => String(item.scheme || "").toUpperCase().replace(/^FR:/, "") === scheme)?.value || "").trim();
  const siren = String(body.siren || identifier("SIREN")).replace(/\s/g, "");
  const siret = String(body.siret || identifier("SIRET")).replace(/\s/g, "");
  const serviceCode = String(body.serviceCode || "").trim().slice(0, 80);
  const issues: ValidationIssue[] = [];
  if (siren && !/^\d{9}$/.test(siren)) issues.push(validationIssue("INVALID_SIREN", "routing", "ANNUAIRE-SIREN", "SIREN must contain exactly 9 digits.", "/siren"));
  if (siret && !/^\d{14}$/.test(siret)) issues.push(validationIssue("INVALID_SIRET", "routing", "ANNUAIRE-SIRET", "SIRET must contain exactly 14 digits.", "/siret"));
  if (!siren && !siret) issues.push(validationIssue("RECIPIENT_IDENTIFIER_REQUIRED", "routing", "ANNUAIRE-LOOKUP", "A SIREN or SIRET is required for directory resolution.", "/identifiers"));
  if (issues.length) return validationProblem(422, issues);
  const entries = await repository.directoryEntries(auth.tenantId, siren, siret);
  const result = resolveSandboxDirectory(entries, { siren, siret, serviceCode });
  const correlationId = request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID();
  return json(200, {
    ok: result.status === "RESOLVED",
    result: {
      ...result, country: "FR", regulatoryField: "BT-49", resolvedAt: new Date().toISOString(), correlationId,
      source: { kind: "PPF_DIRECTORY_SANDBOX_MIRROR", authority: "DGFiP/AIFE specifications", baseline: env.DGFiP_BASELINE, externalNetworkCalled: false },
      evidence: { testEvidence: true, lookupOrder: ["SIRET", "SIREN"], serviceCodeApplied: Boolean(serviceCode), noAddressInvented: true },
    },
    environment: "sandbox", testEvidence: true,
  });
}

async function provisionDirectoryEntry(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const body = await safeJson(request);
  if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
  const siren = String(body.siren || "").replace(/\s/g, "");
  const siret = String(body.siret || "").replace(/\s/g, "");
  const electronicAddress = String(body.electronicAddress || "").trim().slice(0, 200);
  const electronicAddressScheme = String(body.electronicAddressScheme || "0225").trim().slice(0, 40);
  const serviceCode = String(body.serviceCode || "").trim().slice(0, 80);
  const sourceReference = String(body.sourceReference || "").trim().slice(0, 300);
  const activeFrom = String(body.activeFrom || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const activeTo = String(body.activeTo || "").slice(0, 10) || null;
  const issues: ValidationIssue[] = [];
  if (!/^\d{9}$/.test(siren) && !/^\d{14}$/.test(siret)) issues.push(validationIssue("RECIPIENT_IDENTIFIER_REQUIRED", "routing", "ANNUAIRE-PROVISION", "A valid SIREN or SIRET is required.", "/siren"));
  if (!electronicAddress) issues.push(validationIssue("ELECTRONIC_ADDRESS_REQUIRED", "routing", "BT-49", "The sandbox electronic address is required.", "/electronicAddress"));
  if (!sourceReference) issues.push(validationIssue("SOURCE_REFERENCE_REQUIRED", "routing", "ANNUAIRE-EVIDENCE", "A traceable sandbox source reference is required.", "/sourceReference"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activeFrom) || (activeTo && !/^\d{4}-\d{2}-\d{2}$/.test(activeTo))) issues.push(validationIssue("ACTIVE_PERIOD_INVALID", "routing", "ANNUAIRE-PERIOD", "The active period must use YYYY-MM-DD.", "/activeFrom"));
  if (issues.length) return validationProblem(422, issues);
  const digest = await sha256Hex(`${auth.tenantId}:${siret || siren}:${serviceCode || "*"}`);
  const id = `sbx_dir_${digest.slice(0, 32)}`;
  const synchronizedAt = new Date().toISOString();
  const entry = {
    id, siren: siren || (siret ? siret.slice(0, 9) : null), siret: siret || null, electronicAddress,
    receptionPa: "PA-D2F-SANDBOX", activeFrom, activeTo,
    metadata: { electronicAddressScheme, serviceCode: serviceCode || null, sourceReference, directoryVersion: String(body.directoryVersion || synchronizedAt.slice(0, 10)), synchronizedAt, synthetic: true, externalNetworkCalled: false },
  };
  await repository.upsertDirectoryEntry(auth.tenantId, entry);
  return json(200, { ok: true, entry, environment: "sandbox", testEvidence: true, externalNetworkCalled: false, warning: "Synthetic sandbox directory entry; no production PPF directory was modified." });
}

async function submitCanonicalTransaction(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
  const body = await safeJson(request);
  if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
  const preflight = preflightCanonicalTransaction(body);
  const blockingIssues = preflight.issues.filter((issue) => issue.severity === "error");
  if (blockingIssues.length) return json(422, { ok: false, error: { code: "CBM_PREFLIGHT_FAILED", message: "The canonical transaction is incomplete or inconsistent." }, preflight, environment: "sandbox", correlationId: crypto.randomUUID() });
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
  const response: StoredResponse = { status: 202, body: { ok: true, transactionId: invoice.id, remote_id: invoice.remoteId, status: "RECEIVED", correlationId: invoice.correlationId, preflight, links: operationLinks(invoice.id), versions: { api: "1.0.0", cbm: env.CBM_VERSION, application: env.APP_VERSION } } };
  await repository.saveIdempotency(auth.connectionId, "canonical.transaction.submit", idempotencyKey, fingerprint, response);
  return json(response.status, response.body);
}

async function validateFlux1(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) return validationProblem(413, [validationIssue("DOCUMENT_TOO_LARGE", "transport", "TRANSPORT-002", `The document exceeds ${MAX_BODY_BYTES} bytes.`)]);
  const payload = await request.text();
  const contentType = request.headers.get("content-type") || "application/xml";
  const format = detectInvoiceFormat(contentType, payload);
  const initialIssues = [...validateTransport(contentType, payload), ...validateXmlStructure(payload, format)];
  const fingerprint = await sha256Hex(payload);
  const replay = await repository.findIdempotency(auth.connectionId, "sandbox.flux1.validate", idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different content.");
    return json(replay.response.status, { ...replay.response.body, idempotentReplay: true });
  }

  const formal = initialIssues.some((issue) => issue.severity === "error")
    ? { stages: [{ id: "xml", status: "FAIL", standard: "XML", version: "1.0", issueCount: initialIssues.length }], issues: [] }
    : await validateFormalInvoice(payload, format);
  const flux1 = format === "UBL" ? extractFlux1(payload) : { standard: "DGFiP Flux 1", version: "1.2", syntax: format, fields: {}, source: "20260430_Annexe-1-Flux-1-v1.2.xlsx" };
  const allIssues: ValidationIssue[] = [...initialIssues, ...formal.issues];
  const ppfSimulation = simulatePpf(flux1 as ReturnType<typeof extractFlux1>, allIssues.some((issue) => issue.severity === "error"));
  allIssues.push(...ppfSimulation.issues.map((item) => ({ ...item, standard: "PPF simulation", standardVersion: "sandbox" })) as ValidationIssue[]);
  const accepted = !allIssues.some((issue) => issue.severity === "error") && ppfSimulation.status === "ACCEPTED";
  const invoice = newInvoice(auth, format, contentType, payload, fingerprint);
  invoice.currentState = accepted ? "ROUTED" : "REJECTED";
  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  await repository.createInvoice(invoice);
  const event = invoiceEvent({
    type: accepted ? "SandboxFlux1Validated" : "SandboxFlux1Rejected",
    invoiceId: invoice.id,
    aggregateVersion: 1,
    auth,
    appVersion: env.APP_VERSION,
    correlationId: invoice.correlationId,
    category: "regulatory",
    payload: { format, payloadSha256: fingerprint, stages: formal.stages, issues: allIssues, flux1, ppfSimulation },
  });
  await repository.appendEvent(invoice.id, event);
  const result = {
    status: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    transactionId: invoice.id,
    remoteId: invoice.remoteId,
    correlationId: invoice.correlationId,
    stages: formal.stages,
    issues: allIssues,
    flux1,
    ppfSimulation,
    versions: { application: env.APP_VERSION, dgfip: env.DGFiP_BASELINE, flux1: "1.2", fnfeSchematron: "1.4.0.04" },
  };
  const response: StoredResponse = { status: 200, body: { ok: true, result, environment: "sandbox", testEvidence: true } };
  await repository.saveIdempotency(auth.connectionId, "sandbox.flux1.validate", idempotencyKey, fingerprint, response);
  return json(response.status, response.body);
}

async function validateEReportingSubmission(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const input = await regulatoryInput(request, repository, auth, "sandbox.ereporting.validate");
  if (input instanceof Response) return input;
  const validation = await validateEReporting(input.payload);
  const accepted = !validation.issues.some((issue) => issue.severity === "error");
  const invoice = newInvoice(auth, "UNKNOWN", input.contentType, input.payload, input.fingerprint);
  invoice.currentState = accepted ? "ROUTED" : "REJECTED";
  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  await repository.createInvoice(invoice);
  const ppfSimulation = { status: accepted ? "ACCEPTED" : "REJECTED", externalNetworkCalled: false, target: "PPF sandbox simulation", flow: validation.flow };
  const event = invoiceEvent({
    type: accepted ? "SandboxEReportingValidated" : "SandboxEReportingRejected",
    invoiceId: invoice.id,
    aggregateVersion: 1,
    auth,
    appVersion: env.APP_VERSION,
    correlationId: invoice.correlationId,
    category: "regulatory",
    payload: { payloadSha256: input.fingerprint, ...validation, ppfSimulation },
  });
  await repository.appendEvent(invoice.id, event);
  const result = { status: accepted ? "ACCEPTED" : "REJECTED", accepted, transactionId: invoice.id, remoteId: invoice.remoteId, correlationId: invoice.correlationId, ...validation, ppfSimulation, versions: { application: env.APP_VERSION, dgfip: env.DGFiP_BASELINE, annex6: "1.10", annex7: "1.9" } };
  const response: StoredResponse = { status: 200, body: { ok: true, result, environment: "sandbox", testEvidence: true } };
  await repository.saveIdempotency(auth.connectionId, "sandbox.ereporting.validate", input.idempotencyKey, input.fingerprint, response);
  return json(response.status, response.body);
}

async function validateAnnuaireSubmission(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext, flow: AnnuaireFlow): Promise<Response> {
  const operation = `sandbox.annuaire.flux${flow}.validate`;
  const input = await regulatoryInput(request, repository, auth, operation);
  if (input instanceof Response) return input;
  const validation = await validateAnnuaire(input.payload, flow);
  const accepted = !validation.issues.some((issue) => issue.severity === "error");
  const invoice = newInvoice(auth, "UNKNOWN", input.contentType, input.payload, input.fingerprint);
  invoice.currentState = accepted ? "ROUTED" : "REJECTED";
  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  await repository.createInvoice(invoice);
  const event = invoiceEvent({
    type: accepted ? `SandboxAnnuaireFlux${flow}Validated` : `SandboxAnnuaireFlux${flow}Rejected`,
    invoiceId: invoice.id,
    aggregateVersion: 1,
    auth,
    appVersion: env.APP_VERSION,
    correlationId: invoice.correlationId,
    category: "regulatory",
    payload: { payloadSha256: input.fingerprint, ...validation, simulation: { status: accepted ? "ACCEPTED" : "REJECTED", externalNetworkCalled: false } },
  });
  await repository.appendEvent(invoice.id, event);
  const result = { status: accepted ? "ACCEPTED" : "REJECTED", accepted, transactionId: invoice.id, remoteId: invoice.remoteId, correlationId: invoice.correlationId, ...validation, versions: { application: env.APP_VERSION, dgfip: env.DGFiP_BASELINE, annuaireAnnex: "1.8", annex7: "1.9" } };
  const response: StoredResponse = { status: 200, body: { ok: true, result, environment: "sandbox", testEvidence: true } };
  await repository.saveIdempotency(auth.connectionId, operation, input.idempotencyKey, input.fingerprint, response);
  return json(response.status, response.body);
}

async function regulatoryInput(request: Request, repository: SandboxRepository, auth: AuthContext, operation: string): Promise<Response | { payload: string; contentType: string; fingerprint: string; idempotencyKey: string }> {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) return validationProblem(413, [validationIssue("DOCUMENT_TOO_LARGE", "transport", "TRANSPORT-002", `The document exceeds ${MAX_BODY_BYTES} bytes.`)]);
  const payload = await request.text();
  const contentType = request.headers.get("content-type") || "application/xml";
  const transport = validateTransport(contentType, payload);
  if (/<!DOCTYPE|<!ENTITY/i.test(payload)) transport.push(validationIssue("XML_DTD_FORBIDDEN", "xml", "XML-SEC-001", "DTD and entity declarations are forbidden."));
  if (transport.length) return validationProblem(422, transport);
  const fingerprint = await sha256Hex(payload);
  const replay = await repository.findIdempotency(auth.connectionId, operation, idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different content.");
    return json(replay.response.status, { ...replay.response.body, idempotentReplay: true });
  }
  return { payload, contentType, fingerprint, idempotencyKey };
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
  return json(202, { ok: true, invoiceId: invoice.id, previousState: invoice.currentState, state: nextState, regulatoryCode: REGULATORY_CODES[nextState] ?? null, eventId: event.eventId, event, links: operationLinks(invoice.id), environment: "sandbox", testEvidence: true });
}

function newInvoice(auth: AuthContext, format: StoredInvoice["format"], contentType: string, payload: string, payloadSha256: string): StoredInvoice {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return { id, remoteId: `sbx_inv_${id}`, connectionId: auth.connectionId, tenantId: auth.tenantId, format, contentType, payloadSha256, payload, currentState: "RECEIVED", correlationId: crypto.randomUUID(), createdAt: now, updatedAt: now };
}

function publicInvoice(invoice: StoredInvoice): Record<string, unknown> {
  return { id: invoice.remoteId, remote_id: invoice.remoteId, transaction_id: invoice.id, status: invoice.currentState.toLowerCase(), format: invoice.format, correlation_id: invoice.correlationId, created_at: invoice.createdAt, updated_at: invoice.updatedAt, environment: "sandbox", links: operationLinks(invoice.id) };
}

function operationLinks(invoiceId: string): Record<string, string> {
  const encoded = encodeURIComponent(invoiceId);
  return { lifecycle: `/sandbox/v1/invoices/${encoded}/lifecycle`, trace: `/sandbox/v1/traces/${encoded}`, operations: "/sandbox/v1/operations" };
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D2F PA Sandbox</title><style>:root{color-scheme:dark;background:#07111f;color:#edf6ff;font:16px/1.5 system-ui}body{margin:0}.banner{background:#f5a623;color:#111;padding:.65rem;text-align:center;font-weight:900;letter-spacing:.16em}.wrap{max-width:960px;margin:auto;padding:4rem 1.5rem}h1{font-size:clamp(2.4rem,7vw,5.8rem);line-height:.95;margin:.25rem 0 1.5rem}.tag{color:#6ee7ff;text-transform:uppercase;letter-spacing:.13em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-top:3rem}.card{border:1px solid #25415d;background:#0d1c2d;border-radius:18px;padding:1.25rem}.card b{display:block;color:#6ee7ff;margin-bottom:.5rem}.ok{color:#62e6a7}code{background:#14283d;padding:.15rem .35rem;border-radius:5px}</style></head><body><div class="banner">SANDBOX / TEST ONLY — NOT AN ACCREDITED PA</div><main class="wrap"><p class="tag">D2F regulatory simulation</p><h1>Test the flow.<br>Keep production safe.</h1><p>D2F PA Sandbox is an isolated simulation service for Business Suite and Enterprise Platform integration tests.</p><div class="grid"><section class="card"><b>Runtime</b><span class="ok">● UP</span><p>Version ${escapeHtml(env.APP_VERSION)} · DGFiP baseline ${escapeHtml(env.DGFiP_BASELINE)}</p></section><section class="card"><b>Network safety</b><p><code>EXTERNAL_NETWORK_DISABLED=${escapeHtml(env.EXTERNAL_NETWORK_DISABLED)}</code></p></section><section class="card"><b>Regulatory controls</b><p><code>Flux 1–14</code> coverage is explicit and fail-closed.<br>Implemented: Flux 1, 10.1–10.4.<br>Partial/blocked flows remain visible with missing proof.</p></section><section class="card"><b>Developer contract</b><p><a href="/openapi.yaml" style="color:#6ee7ff">OpenAPI definition</a><br><a href="/sandbox/v1/regulatory/coverage" style="color:#6ee7ff">Regulatory coverage</a></p></section></div></main></body></html>`;
}

function openApi(env: Env): string {
  return `openapi: 3.1.0
info:
  title: D2F PA Sandbox API
  version: ${env.APP_VERSION}
  description: SANDBOX / TEST ONLY. This service is not an accredited Plateforme Agréée.
components:
  securitySchemes:
    enterpriseBearer:
      type: http
      scheme: bearer
  parameters:
    connectionId:
      name: X-D2F-Connection-Id
      in: header
      required: true
      schema: { type: string }
    idempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      schema: { type: string, minLength: 16, maxLength: 200 }
security:
  - enterpriseBearer: []
paths:
  /health:
    get:
      security: []
      responses:
        '200': { description: Sandbox health and version }
  /invoices:
    post:
      summary: D2F Business Suite raw XML compatibility endpoint
      parameters:
        - { name: Idempotency-Key, in: header, required: false, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/xml: { schema: { type: string } }
      responses:
        '202': { description: Submitted to the sandbox engine }
        '409': { description: Idempotency conflict }
        '422': { description: Structured validation errors }
  /invoices/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: Normalized invoice state }
        '404': { description: Invoice not found }
  /api/v1/transactions:
    post:
      summary: D2F CBM 2.1 canonical transaction submission
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      responses:
        '202': { description: Canonical transaction accepted }
        '409': { description: Idempotency conflict }
        '422': { description: Canonical validation errors }
  /sandbox/v1/validate/flux1:
    post:
      summary: Validate an invoice with the official Flux 1 XSD and Schematron rules and simulate PPF submission
      description: Returns every validation phase, failed rule, extracted Flux 1 business term and the simulated PPF routing result. No external PPF call is made.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/xml: { schema: { type: string } }
      responses:
        '200': { description: Structured validation and PPF simulation report }
        '409': { description: Idempotency conflict }
        '413': { description: Document too large }
  /sandbox/v1/validate/ereporting:
    post:
      summary: Validate and classify DGFiP e-reporting Flux 10.1, 10.2, 10.3 or 10.4
      description: Runs the official v3.2 XSD and traceable Annex 7 management rules. The official DGFiP v3.2 archive does not publish a Flux 10 Schematron, so the response marks that stage not applicable instead of overstating compliance.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/xml: { schema: { type: string } }
      responses:
        '200': { description: Structured Flux 10 validation and simulated PPF result }
        '409': { description: Idempotency conflict }
        '413': { description: Document too large }
  /sandbox/v1/validate/annuaire/{flow}:
    post:
      summary: Validate DGFiP Annuaire Flux 12, 13 or 14
      parameters:
        - { name: flow, in: path, required: true, schema: { type: string, enum: ['12', '13', '14'] } }
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/xml: { schema: { type: string } }
      responses:
        '200': { description: Structured Annuaire XSD and management-rule report }
        '409': { description: Idempotency conflict }
        '413': { description: Document too large }
  /sandbox/v1/traces/{id}:
    get:
      summary: Retrieve immutable sandbox evidence for one transaction
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: Transaction, events and evidence }
        '404': { description: Trace not found }
  /sandbox/v1/operations:
    get:
      summary: List tenant-isolated inbound PA flows and their latest controls
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 200, default: 100 } }
      responses:
        '200': { description: Sanitized operations without invoice payloads or secrets }
  /sandbox/v1/directory/resolve:
    post:
      summary: Resolve a French sandbox recipient route from the simulated PPF directory mirror
      description: Returns BT-49 and source evidence or an explicit NOT_FOUND/AMBIGUOUS result. It never fabricates an address and never calls the production PPF directory.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                siren: { type: string, pattern: '^[0-9]{9}$' }
                siret: { type: string, pattern: '^[0-9]{14}$' }
                serviceCode: { type: string, maxLength: 80 }
                identifiers:
                  type: array
                  items:
                    type: object
                    required: [scheme, value]
                    properties: { scheme: { type: string }, value: { type: string } }
      responses:
        '200': { description: Resolution result with BT-49, reception platform, directory version and evidence }
        '422': { description: Invalid or missing recipient identifiers }
  /sandbox/v1/directory/entries:
    put:
      summary: Provision an idempotent synthetic directory entry for sandbox tests
      description: Never modifies the production PPF directory. The source reference is mandatory and the result is explicit test evidence.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: Synthetic tenant-isolated route provisioned }
        '422': { description: Missing identifier, electronic address, source reference or invalid period }
  /sandbox/v1/preflight/cbm:
    post:
      summary: Classify and validate a CBM invoice before structured generation and dispatch
      description: Selects Flux 2, 3, 4, 8 or 9 and parallel Flux 1, 6, 7 and 10 obligations. Returns exact source, PA and interoperability blockers.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: CBM preflight, dispatch plan and regulatory coverage }
  /sandbox/v1/regulatory/coverage:
    get:
      security: []
      summary: Read the complete fail-closed Flux 1–14 implementation matrix
      responses:
        '200': { description: Implemented, partial and blocked flows with evidence gaps }
  /sandbox/v1/invoices/{id}/lifecycle:
    get:
      summary: Read the complete immutable lifecycle and legal next states
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200': { description: Current state, legal next states and canonical events }
        '404': { description: Invoice not found }
    post:
      summary: Sandbox-only lifecycle transition control
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '202': { description: Transition accepted and evidence recorded }
        '422': { description: Out-of-order lifecycle transition }
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
