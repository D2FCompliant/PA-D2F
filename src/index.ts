import { authenticate } from "./auth";
import { validateAnnuaire, type AnnuaireFlow } from "./annuaire";
import { sha256Hex } from "./crypto";
import { validateEReporting } from "./e-reporting";
import { generateEReportingDocuments } from "./e-reporting-ingest";
import { invoiceEvent } from "./events";
import { extractFlux1, simulateDirectoryRouting } from "./flux1";
import { validateFormalInvoice } from "./formal-validation";
import { assertTransition, lifecycleEventType, REGULATORY_CODES } from "./lifecycle";
import { SandboxRepository } from "./repository";
import { simulationFlags } from "./simulation/contracts";
import { D1ScenarioStore } from "./simulation/d1-store";
import { DEMO_SCENARIOS, executeDemoScenario, isDemoScenarioId } from "./simulation/demo-service";
import { executeLifecycleEvent, getLifecycleView, LifecycleServiceError } from "./simulation/lifecycle-service";
import { executePpfSubmission, getPpfSubmissionView, PpfServiceError, type PpfSubmissionRequest } from "./simulation/ppf-service";
import { executePhaseTwoScenario, ScenarioServiceError, type ScenarioExecutionOptions } from "./simulation/service";
import { buildEvidenceReport, buildUnifiedTrace } from "./simulation/trace-service";
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

  if (url.pathname === "/sandbox/v1/scenarios" && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return json(200, { ok: true, environment: "sandbox", scenarios: DEMO_SCENARIOS, count: DEMO_SCENARIOS.length });
  }

  const finalDemoMatch = url.pathname.match(/^\/sandbox\/v1\/scenarios\/(DEMO-FR-00[1-9]|DEMO-FR-010|MATIC-DEMO)\/executions$/);
  if (finalDemoMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const flags = simulationFlags(env);
    if (!flags.dualNodeSimulation || !flags.directorySimulator || !flags.lifecycleSimulation || !flags.ppfSimulator) {
      return problem(404, "PA_SIMULATION_FEATURE_DISABLED", "The final regulatory simulation lab is disabled for this environment.");
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (idempotencyKey.length < 16 || idempotencyKey.length > 160) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 160 characters.");
    const scenarioId = decodeURIComponent(finalDemoMatch[1] ?? "");
    if (!isDemoScenarioId(scenarioId)) return problem(404, "SCENARIO_NOT_FOUND", "The requested final demonstration scenario is not registered.");
    const response = await executeDemoScenario({
      env,
      store: new D1ScenarioStore(env.DB),
      connectionId: auth.connectionId,
      initiatingTenantId: auth.tenantId,
      idempotencyKey,
      scenarioId,
      correlationId: request.headers.get("x-correlation-id")?.trim() || undefined,
      validateCanonical,
    });
    return json(response.status, response.body);
  }

  if (url.pathname === "/sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const flags = simulationFlags(env);
    if (!flags.dualNodeSimulation || !flags.directorySimulator) {
      return problem(404, "PA_SIMULATION_FEATURE_DISABLED", "The regulatory simulation route is disabled for this environment.");
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
    const body = await safeJson(request) ?? {};
    const remotePaOutcome = String(body.remotePaOutcome || "").trim();
    const buyerOutcome = String(body.buyerOutcome || "").trim();
    const interruptAfter = String(body.interruptAfter || "").trim();
    if (remotePaOutcome && !["ACCEPTED", "TEMPORARY_FAILURE", "TIMEOUT", "REJECTED"].includes(remotePaOutcome)) return problem(422, "INVALID_SCENARIO_OPTION", "remotePaOutcome is not supported.");
    if (buyerOutcome && !["DELIVERED", "TEMPORARY_FAILURE"].includes(buyerOutcome)) return problem(422, "INVALID_SCENARIO_OPTION", "buyerOutcome is not supported.");
    if (interruptAfter && !["DIRECTORY_RESOLVED", "PAR_ACCEPTED"].includes(interruptAfter)) return problem(422, "INVALID_SCENARIO_OPTION", "interruptAfter is not supported.");
    try {
      const response = await executePhaseTwoScenario({
        env,
        store: new D1ScenarioStore(env.DB),
        connectionId: auth.connectionId,
        initiatingTenantId: auth.tenantId,
        idempotencyKey,
        validateCanonical,
        transactionId: String(body.transactionId || "").trim() || undefined,
        correlationId: request.headers.get("x-correlation-id")?.trim() || String(body.correlationId || "").trim() || undefined,
        options: {
          directoryScheme: String(body.directoryScheme || "").trim() || undefined,
          directoryIdentifier: String(body.directoryIdentifier || "").trim() || undefined,
          remotePaOutcome: remotePaOutcome as ScenarioExecutionOptions["remotePaOutcome"],
          buyerOutcome: buyerOutcome as ScenarioExecutionOptions["buyerOutcome"],
          interruptAfter: interruptAfter as ScenarioExecutionOptions["interruptAfter"],
          resumeFromExecutionRunId: String(body.resumeFromExecutionRunId || "").trim() || undefined,
        },
      });
      return json(response.status, response.body);
    } catch (error) {
      if (error instanceof ScenarioServiceError) {
        const status = ["SIMULATION_TRANSACTION_NOT_FOUND", "SIMULATION_RUN_NOT_FOUND"].includes(error.code) ? 404 : 409;
        return problem(status, error.code, error.message);
      }
      throw error;
    }
  }

  const ppfSubmissionsMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)\/ppf-submissions$/);
  if (ppfSubmissionsMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    if (!simulationFlags(env).ppfSimulator) {
      return problem(404, "PPF_FEATURE_DISABLED", "PPF simulation is disabled for this environment.");
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_BODY_BYTES) return problem(413, "DOCUMENT_TOO_LARGE", `The document exceeds ${MAX_BODY_BYTES} bytes.`);
    const body = await safeJson(request);
    if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
    const mode = String(body.mode || "").trim().toUpperCase();
    const flow = String(body.flow || "").trim();
    const simulatedTransportOutcome = String(body.simulatedTransportOutcome || "").trim().toUpperCase();
    const interruptAfter = String(body.interruptAfter || "").trim().toUpperCase();
    if (mode && !["GENERATE", "PROVIDED_PAYLOAD"].includes(mode)) return problem(422, "INVALID_PPF_OPTION", "mode is not supported.");
    if (flow && !["10.1", "10.2", "10.3", "10.4", "UNKNOWN"].includes(flow)) return problem(422, "INVALID_PPF_OPTION", "flow is not supported.");
    if (simulatedTransportOutcome && !["RECEIVED", "TEMPORARY_ERROR"].includes(simulatedTransportOutcome)) return problem(422, "INVALID_PPF_OPTION", "simulatedTransportOutcome is not supported.");
    if (interruptAfter && !["BEFORE_SUBMISSION", "AFTER_SUBMISSION", "AFTER_RECEIPT"].includes(interruptAfter)) return problem(422, "INVALID_PPF_OPTION", "interruptAfter is not supported.");
    const canonicalBatch = object(body.canonicalBatch);
    try {
      const response = await executePpfSubmission({
        env,
        store: new D1ScenarioStore(env.DB),
        connectionId: auth.connectionId,
        transactionId: decodeURIComponent(ppfSubmissionsMatch[1] ?? ""),
        idempotencyKey,
        request: {
          mode: (mode || undefined) as PpfSubmissionRequest["mode"],
          flow: (flow || undefined) as PpfSubmissionRequest["flow"],
          canonicalBatch: Object.keys(canonicalBatch).length ? canonicalBatch : undefined,
          payload: typeof body.payload === "string" ? body.payload : undefined,
          simulatedTransportOutcome: (simulatedTransportOutcome || undefined) as PpfSubmissionRequest["simulatedTransportOutcome"],
          interruptAfter: (interruptAfter || undefined) as PpfSubmissionRequest["interruptAfter"],
          resumeFromExecutionRunId: String(body.resumeFromExecutionRunId || "").trim() || undefined,
        },
      });
      return json(response.status, response.body);
    } catch (error) {
      if (error instanceof PpfServiceError) {
        const status = ["SIMULATION_TRANSACTION_NOT_FOUND", "SIMULATION_RUN_NOT_FOUND", "PPF_FEATURE_DISABLED"].includes(error.code)
          ? 404
          : error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 422;
        return json(status, {
          ok: false,
          error: { code: error.code, message: error.message, ...(error.blockedBy ? { blockedBy: error.blockedBy } : {}) },
          environment: "sandbox",
          correlationId: crypto.randomUUID(),
        });
      }
      throw error;
    }
  }

  if (ppfSubmissionsMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    if (!simulationFlags(env).ppfSimulator) {
      return problem(404, "PPF_FEATURE_DISABLED", "PPF simulation is disabled for this environment.");
    }
    const view = await getPpfSubmissionView(
      new D1ScenarioStore(env.DB),
      decodeURIComponent(ppfSubmissionsMatch[1] ?? ""),
      auth.connectionId,
    );
    return view
      ? json(200, { ok: true, environment: "sandbox", ...view })
      : problem(404, "SIMULATION_TRANSACTION_NOT_FOUND", "No simulation transaction matches this identifier in the connection scope.");
  }

  const lifecycleEventsMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)\/lifecycle-events$/);
  if (lifecycleEventsMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    if (!simulationFlags(env).lifecycleSimulation) {
      return problem(404, "LIFECYCLE_FEATURE_DISABLED", "Lifecycle simulation is disabled for this environment.");
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
    const body = await safeJson(request);
    if (!body) return problem(400, "INVALID_JSON", "A JSON object is required.");
    try {
      const response = await executeLifecycleEvent({
        env,
        store: new D1ScenarioStore(env.DB),
        connectionId: auth.connectionId,
        transactionId: decodeURIComponent(lifecycleEventsMatch[1] ?? ""),
        idempotencyKey,
        request: {
          actor: String(body.actor || "").trim() || undefined,
          previousState: String(body.previousState || "").trim() || undefined,
          nextState: String(body.nextState || "").trim() || undefined,
          eventType: String(body.eventType || "").trim() || undefined,
          eventId: String(body.eventId || "").trim() || undefined,
          payload: object(body.payload),
          interruptAfter: body.interruptAfter === "PAR_RECEIVED" ? "PAR_RECEIVED" : undefined,
          resumeFromExecutionRunId: String(body.resumeFromExecutionRunId || "").trim() || undefined,
        },
      });
      return json(response.status, response.body);
    } catch (error) {
      if (error instanceof LifecycleServiceError) {
        const status = ["SIMULATION_TRANSACTION_NOT_FOUND", "SIMULATION_RUN_NOT_FOUND", "LIFECYCLE_FEATURE_DISABLED"].includes(error.code)
          ? 404
          : ["IDEMPOTENCY_CONFLICT", "LIFECYCLE_DUPLICATE_EVENT_CONFLICT"].includes(error.code) ? 409 : 422;
        return json(status, {
          ok: false,
          error: { code: error.code, message: error.message, ...(error.blockedBy ? { blockedBy: error.blockedBy } : {}) },
          environment: "sandbox",
          correlationId: crypto.randomUUID(),
        });
      }
      throw error;
    }
  }

  const lifecycleViewMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)\/lifecycle$/);
  if (lifecycleViewMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    if (!simulationFlags(env).lifecycleSimulation) {
      return problem(404, "LIFECYCLE_FEATURE_DISABLED", "Lifecycle simulation is disabled for this environment.");
    }
    const view = await getLifecycleView(
      new D1ScenarioStore(env.DB),
      decodeURIComponent(lifecycleViewMatch[1] ?? ""),
      auth.connectionId,
    );
    return view
      ? json(200, { ok: true, environment: "sandbox", ...view })
      : problem(404, "SIMULATION_TRANSACTION_NOT_FOUND", "No simulation transaction matches this identifier in the connection scope.");
  }

  const simulationTransactionMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)$/);
  if (simulationTransactionMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const flags = simulationFlags(env);
    if (!flags.dualNodeSimulation || !flags.directorySimulator) {
      return problem(404, "PA_SIMULATION_FEATURE_DISABLED", "The regulatory simulation route is disabled for this environment.");
    }
    const trace = await new D1ScenarioStore(env.DB).getTrace(decodeURIComponent(simulationTransactionMatch[1] ?? ""), auth.connectionId);
    return trace
      ? json(200, { ok: true, environment: "sandbox", testEvidence: true, ...trace })
      : problem(404, "SIMULATION_TRANSACTION_NOT_FOUND", "No simulation transaction matches this identifier in the connection scope.");
  }

  const unifiedTraceMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)\/trace$/);
  if (unifiedTraceMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const trace = await buildUnifiedTrace({
      env,
      store: new D1ScenarioStore(env.DB),
      transactionId: decodeURIComponent(unifiedTraceMatch[1] ?? ""),
      connectionId: auth.connectionId,
    });
    return trace ? json(200, { ok: true, ...trace }) : problem(404, "SIMULATION_TRANSACTION_NOT_FOUND", "No simulation transaction matches this identifier in the connection scope.");
  }

  const evidenceReportMatch = url.pathname.match(/^\/sandbox\/v1\/transactions\/([^/]+)\/evidence-report$/);
  if (evidenceReportMatch && request.method === "GET") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    const report = await buildEvidenceReport({
      env,
      store: new D1ScenarioStore(env.DB),
      transactionId: decodeURIComponent(evidenceReportMatch[1] ?? ""),
      connectionId: auth.connectionId,
    });
    return report ? json(200, { ok: true, report }) : problem(404, "SIMULATION_TRANSACTION_NOT_FOUND", "No simulation transaction matches this identifier in the connection scope.");
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

  if (url.pathname === "/sandbox/v1/ingest/ereporting" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return ingestEReportingSubmission(request, env, repository, auth);
  }

  if (url.pathname === "/sandbox/v1/directory/entries" && request.method === "PUT") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return putDirectoryEntry(request, repository, auth);
  }

  if (url.pathname === "/sandbox/v1/directory/resolve" && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return resolveDirectoryEntry(request, repository, auth);
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

  const lifecycleMatch = url.pathname.match(/^\/sandbox\/v1\/invoices\/([^/]+)\/lifecycle$/);
  if (lifecycleMatch && request.method === "POST") {
    const auth = authenticate(request, env, true);
    if (!auth) return problem(401, "INVALID_AUTH", "Enterprise bearer authentication is required.");
    return transitionInvoice(request, env, repository, auth, decodeURIComponent(lifecycleMatch[1] ?? ""));
  }

  return problem(404, "ROUTE_NOT_FOUND", "The requested sandbox route does not exist.");
}

async function putDirectoryEntry(request: Request, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return problem(400, "INVALID_DIRECTORY_ENTRY", "A JSON directory entry is required.");
  const siren = String(body.siren || "").replace(/\s/g, "");
  const siret = String(body.siret || "").replace(/\s/g, "") || null;
  const electronicAddressScheme = String(body.electronicAddressScheme || "").trim();
  const electronicAddress = String(body.electronicAddress || "").trim();
  const sourceReference = String(body.sourceReference || "").trim();
  const activeFrom = String(body.activeFrom || "").slice(0, 10) || null;
  const activeTo = String(body.activeTo || "").slice(0, 10) || null;
  if (!/^\d{9}$/.test(siren) || (siret && !/^\d{14}$/.test(siret))) return problem(422, "INVALID_DIRECTORY_IDENTIFIER", "SIREN must contain 9 digits and SIRET, when supplied, 14 digits.");
  if (!electronicAddressScheme || !electronicAddress || !sourceReference) return problem(422, "INCOMPLETE_DIRECTORY_ENTRY", "Electronic address scheme, value and source reference are required.");
  if ((activeFrom && !/^\d{4}-\d{2}-\d{2}$/.test(activeFrom)) || (activeTo && !/^\d{4}-\d{2}-\d{2}$/.test(activeTo)) || (activeFrom && activeTo && activeTo < activeFrom)) return problem(422, "INVALID_DIRECTORY_PERIOD", "The directory activation period is invalid.");
  const entry = { id: crypto.randomUUID(), tenantId: auth.tenantId, connectionId: auth.connectionId, siren, siret, electronicAddressScheme, electronicAddress, sourceReference, activeFrom, activeTo, status: "active" as const };
  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  await repository.replaceDirectoryEntry(entry);
  return json(200, { ok: true, service: "d2f-pa-sandbox", environment: "sandbox", result: { status: "REGISTERED", entryId: entry.id, siren, siret, electronicAddress: { scheme: electronicAddressScheme, value: electronicAddress }, sourceReference } });
}

async function resolveDirectoryEntry(request: Request, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const identifiers = Array.isArray(body?.identifiers) ? body.identifiers.map((value) => {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { scheme: String(item.scheme || "").trim().toUpperCase(), value: String(item.value || "").replace(/\s/g, "") };
  }).filter((item) => (item.scheme === "SIREN" && /^\d{9}$/.test(item.value)) || (item.scheme === "SIRET" && /^\d{14}$/.test(item.value))) : [];
  if (!identifiers.length) return problem(422, "DIRECTORY_IDENTIFIER_REQUIRED", "At least one valid SIREN or SIRET is required.");
  const correlationId = request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID();
  const entry = await repository.resolveDirectoryEntry(auth.connectionId, auth.tenantId, identifiers, new Date().toISOString().slice(0, 10));
  return json(200, { ok: true, service: "d2f-pa-sandbox", environment: "sandbox", result: entry ? { status: "RESOLVED", correlationId, entryId: entry.id, matchedIdentifier: entry.siret && identifiers.some((item) => item.scheme === "SIRET" && item.value === entry.siret) ? { scheme: "SIRET", value: entry.siret } : { scheme: "SIREN", value: entry.siren }, electronicAddress: { scheme: entry.electronicAddressScheme, value: entry.electronicAddress }, sourceReference: entry.sourceReference } : { status: "NOT_FOUND", correlationId, entryId: null, electronicAddress: null, sourceReference: null } });
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
  const routingSimulation = simulateDirectoryRouting(flux1 as ReturnType<typeof extractFlux1>, allIssues.some((issue) => issue.severity === "error"));
  allIssues.push(...routingSimulation.issues.map((item) => ({ ...item, standard: "Directory and PA routing simulation", standardVersion: "sandbox" })) as ValidationIssue[]);
  const accepted = !allIssues.some((issue) => issue.severity === "error") && routingSimulation.status === "ACCEPTED";
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
    payload: { format, payloadSha256: fingerprint, stages: formal.stages, issues: allIssues, flux1, routingSimulation },
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
    routingSimulation,
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

async function ingestEReportingSubmission(request: Request, env: Env, repository: SandboxRepository, auth: AuthContext): Promise<Response> {
  const operation = "sandbox.ereporting.ingest";
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || "";
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) return problem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 16 to 200 characters.");
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return problem(415, "UNSUPPORTED_MEDIA_TYPE", "Canonical e-reporting ingestion requires application/json.");
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) return problem(413, "DOCUMENT_TOO_LARGE", `The document exceeds ${MAX_BODY_BYTES} bytes.`);
  const rawPayload = await request.text();
  const fingerprint = await sha256Hex(rawPayload);
  const replay = await repository.findIdempotency(auth.connectionId, operation, idempotencyKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) return problem(409, "IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different content.");
    return json(replay.response.status, { ...replay.response.body, idempotentReplay: true });
  }
  let canonical: Record<string, unknown>;
  try {
    canonical = object(JSON.parse(rawPayload));
  } catch {
    return problem(400, "INVALID_JSON", "The canonical e-reporting batch must be valid JSON.");
  }
  let documents;
  try {
    documents = generateEReportingDocuments(canonical);
  } catch (error) {
    return problem(422, "E_REPORTING_SOURCE_REJECTED", error instanceof Error ? error.message : "The canonical e-reporting source could not be aggregated.");
  }
  const validations = await Promise.all(documents.map(async (document) => ({ document, payloadSha256: await sha256Hex(document.xml), validation: await validateEReporting(document.xml) })));
  const accepted = validations.every(({ validation }) => !validation.issues.some((issue) => issue.severity === "error"));
  const invoice = newInvoice(auth, "UNKNOWN", "application/json", rawPayload, fingerprint);
  invoice.currentState = accepted ? "ROUTED" : "REJECTED";
  await repository.ensureConnection(auth.connectionId, auth.tenantId, auth.legalEntityId);
  await repository.createInvoice(invoice);
  const results = validations.map(({ document, payloadSha256, validation }) => ({
    ...validation,
    flow: document.flow,
    format: "DGFiP_FLUX_10",
    recordIds: document.recordIds,
    payloadSha256,
    accepted: !validation.issues.some((issue) => issue.severity === "error"),
  }));
  const ppfSimulation = { status: accepted ? "ACCEPTED" : "REJECTED", externalNetworkCalled: false, target: "PPF sandbox simulation", flows: results.map((item) => ({ flow: item.flow, status: item.accepted ? "ACCEPTED" : "REJECTED" })) };
  const event = invoiceEvent({
    type: accepted ? "SandboxEReportingBatchAggregated" : "SandboxEReportingBatchRejected",
    invoiceId: invoice.id,
    aggregateVersion: 1,
    auth,
    appVersion: env.APP_VERSION,
    correlationId: invoice.correlationId,
    category: "regulatory",
    payload: { payloadSha256: fingerprint, sourceSchema: "D2F_REGULATORY_BATCH_V1", generatedBy: "D2F PA Sandbox", results, ppfSimulation },
  });
  await repository.appendEvent(invoice.id, event);
  const issues = results.flatMap((item) => item.issues.map((issue) => ({ ...issue, source: issue.source, flow: item.flow })));
  const stages = results.flatMap((item) => item.stages.map((stage) => ({ ...stage, flow: item.flow })));
  const result = {
    status: accepted ? "ACCEPTED" : "REJECTED",
    accepted,
    transactionId: invoice.id,
    remoteId: invoice.remoteId,
    correlationId: invoice.correlationId,
    issues,
    stages,
    generatedDocuments: results,
    ppfSimulation,
    versions: { application: env.APP_VERSION, dgfip: env.DGFiP_BASELINE, annex6: "1.10", annex7: "1.9" },
  };
  const response: StoredResponse = { status: 200, body: { ok: true, result, environment: "sandbox", testEvidence: true } };
  await repository.saveIdempotency(auth.connectionId, operation, idempotencyKey, fingerprint, response);
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
  if (nextState === "PAID") {
    return json(422, {
      ok: false,
      error: {
        code: "SIMULATION_BOUNDARY",
        message: "Status 212/payment simulation requires the shared Payment Contract.",
        blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      },
      environment: "sandbox",
      correlationId: invoice.correlationId,
    });
  }
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

export function validateCanonical(body: Record<string, unknown>): ValidationIssue[] {
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>D2F PA Sandbox</title><style>:root{color-scheme:dark;background:#07111f;color:#edf6ff;font:16px/1.5 system-ui}body{margin:0}.banner{background:#f5a623;color:#111;padding:.65rem;text-align:center;font-weight:900;letter-spacing:.16em}.wrap{max-width:960px;margin:auto;padding:4rem 1.5rem}h1{font-size:clamp(2.4rem,7vw,5.8rem);line-height:.95;margin:.25rem 0 1.5rem}.tag{color:#6ee7ff;text-transform:uppercase;letter-spacing:.13em}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem;margin-top:3rem}.card{border:1px solid #25415d;background:#0d1c2d;border-radius:18px;padding:1.25rem}.card b{display:block;color:#6ee7ff;margin-bottom:.5rem}.ok{color:#62e6a7}code{background:#14283d;padding:.15rem .35rem;border-radius:5px}</style></head><body><div class="banner">SANDBOX / TEST ONLY — NOT AN ACCREDITED PA</div><main class="wrap"><p class="tag">D2F regulatory simulation</p><h1>Test the flow.<br>Keep production safe.</h1><p>D2F PA Sandbox is an isolated simulation service for Business Suite and Enterprise Platform integration tests.</p><div class="grid"><section class="card"><b>Runtime</b><span class="ok">● UP</span><p>Version ${escapeHtml(env.APP_VERSION)} · DGFiP baseline ${escapeHtml(env.DGFiP_BASELINE)}</p></section><section class="card"><b>Network safety</b><p><code>EXTERNAL_NETWORK_DISABLED=${escapeHtml(env.EXTERNAL_NETWORK_DISABLED)}</code></p></section><section class="card"><b>Regulatory controls</b><p><code>Flux 1</code> XSD + EN16931/FNFE Schematron<br><code>Flux 10.1–10.4</code> XSD + Annex 7 rules<br><code>Flux 12–14</code> Annuaire XSD</p></section><section class="card"><b>Developer contract</b><p><a href="/openapi.yaml" style="color:#6ee7ff">OpenAPI definition</a></p></section></div></main></body></html>`;
}

function openApi(env: Env): string {
  return `openapi: 3.1.0
info:
  title: D2F PA Sandbox API
  version: 1.0.0
  x-runtime-version: ${env.APP_VERSION}
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
    correlationId:
      name: X-Correlation-Id
      in: header
      required: false
      schema: { type: string, format: uuid }
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
        - { $ref: '#/components/parameters/correlationId' }
      responses:
        '202': { description: Canonical transaction accepted }
        '409': { description: Idempotency conflict }
        '422': { description: Canonical validation errors }
  /sandbox/v1/validate/flux1:
    post:
      summary: Validate an invoice with the official Flux 1 XSD and Schematron rules and simulate PA routing
      description: Returns every validation phase, failed rule, extracted Flux 1 business term and the simulated Directory/PA routing result. Invoice routing never traverses the PPF Simulator.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/xml: { schema: { type: string } }
      responses:
        '200': { description: Structured validation and Directory/PA routing simulation report }
        '409': { description: Idempotency conflict }
        '413': { description: Document too large }
  /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions:
    post:
      summary: Execute or replay the isolated PAE to Directory to PAR to Buyer scenario
      description: Feature-flagged synthetic orchestration only. With lifecycle enabled, the trace continues through documented 203 and 205 events back to PAR/PAE. REAL_REGULATORY_VALIDATION is reported separately from simulated services. Returns a SIMULATION_BOUNDARY and never calls AIFE, PPF or a remote PA.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                transactionId: { type: string, format: uuid, description: Existing sandbox transaction to replay without creating a new business invoice }
                correlationId: { type: string, format: uuid }
                directoryScheme: { type: string, example: '0225' }
                directoryIdentifier:
                  type: string
                  enum: [TEST-FR-BUYER-001, TEST-FR-NOT-FOUND, TEST-FR-NO-ROUTING, TEST-FR-MULTIPLE, TEST-FR-PA-NOT-FOUND, TEST-FR-ADDRESS-DISABLED, TEST-FR-TEMPORARY]
                remotePaOutcome: { type: string, enum: [ACCEPTED, TEMPORARY_FAILURE, TIMEOUT, REJECTED] }
                buyerOutcome: { type: string, enum: [DELIVERED, TEMPORARY_FAILURE] }
                interruptAfter: { type: string, enum: [DIRECTORY_RESOLVED, PAR_ACCEPTED] }
                resumeFromExecutionRunId: { type: string, format: uuid }
            examples:
              happyPath:
                value: { directoryScheme: '0225', directoryIdentifier: TEST-FR-BUYER-001, remotePaOutcome: ACCEPTED, buyerOutcome: DELIVERED }
      responses:
        '200': { description: Idempotent replay of the same execution request }
        '202': { description: Synthetic execution persisted as completed, blocked, retryable, rejected or interrupted }
        '400': { description: Invalid idempotency key }
        '404': { description: Feature disabled or simulation transaction not found }
        '409': { description: Idempotency conflict }
        '422': { description: Invalid deterministic scenario option }
  /sandbox/v1/scenarios:
    get:
      summary: List deterministic final regulatory simulation scenarios
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: DEMO-FR-001 through DEMO-FR-010 plus the isolated MATIC-DEMO fixture }
        '401': { description: Enterprise authentication required }
  /sandbox/v1/scenarios/{scenarioId}/executions:
    post:
      summary: Execute one deterministic final demonstration scenario
      description: Runs only synthetic sandbox fixtures and returns links to the unified trace and technical evidence report. Payment/212 remains an explicit boundary while the shared contract is unavailable.
      parameters:
        - { name: scenarioId, in: path, required: true, schema: { type: string, enum: [DEMO-FR-001, DEMO-FR-002, DEMO-FR-003, DEMO-FR-004, DEMO-FR-005, DEMO-FR-006, DEMO-FR-007, DEMO-FR-008, DEMO-FR-009, DEMO-FR-010, MATIC-DEMO] } }
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
        - { $ref: '#/components/parameters/correlationId' }
      responses:
        '202': { description: Scenario executed with deterministic actions and trace links }
        '400': { description: Invalid idempotency key }
        '401': { description: Enterprise authentication required }
        '404': { description: Scenario or required simulator feature disabled }
  /sandbox/v1/transactions/{transactionId}:
    get:
      summary: Retrieve a connection-isolated regulatory simulation trace
      description: Returns sanitized transaction metadata, execution runs and persisted messages. Canonical payloads, secrets, bindings and Cloudflare internals are not exposed.
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: PAE, Directory, PAR and Buyer trace with transactionId, correlationId and executionRunId }
        '401': { description: Enterprise authentication required }
        '404': { description: Feature disabled or transaction not found in the connection scope }
  /sandbox/v1/transactions/{transactionId}/trace:
    get:
      summary: Retrieve the unified end-to-end regulatory simulation trace
      description: Aggregates INPUT, CBM, PAE, validation, directory, routing, PAR, buyer, lifecycle, e-reporting, PPF and evidence without exposing raw documents or secrets.
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: Sanitized trace with message IDs, UTC timestamps, hashes, provenance and evidence references }
        '401': { description: Enterprise authentication required }
        '404': { description: Transaction not found in the connection scope }
  /sandbox/v1/transactions/{transactionId}/evidence-report:
    get:
      summary: Generate the technical regulatory simulation evidence report
      description: Clearly distinguishes real regulatory validation from simulated external interoperability and is not legal proof.
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: Versioned technical evidence report with hashes and mandatory simulation notices }
        '401': { description: Enterprise authentication required }
        '404': { description: Transaction not found in the connection scope }
  /sandbox/v1/transactions/{transactionId}/lifecycle-events:
    post:
      summary: Record or replay one technical sandbox lifecycle event
      description: Uses the existing PA lifecycle transition contract. Status 212 remains blocked by PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT. Evidence is technical sandbox evidence, not legal proof.
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                eventId: { type: string, format: uuid }
                actor: { type: string, enum: [BUYER, PAR, PAE] }
                previousState: { type: string }
                nextState: { type: string }
                eventType: { type: string }
                payload: { type: object }
                interruptAfter: { type: string, enum: [PAR_RECEIVED] }
                resumeFromExecutionRunId: { type: string, format: uuid }
            examples:
              madeAvailable:
                value: { actor: PAR, previousState: DELIVERED, nextState: MADE_AVAILABLE, eventType: InvoiceMadeAvailable }
              buyerApproved:
                value: { actor: BUYER, previousState: MADE_AVAILABLE, nextState: APPROVED, eventType: InvoiceApproved }
      responses:
        '200': { description: Idempotent request replay or duplicate event }
        '202': { description: Lifecycle event and relay messages persisted }
        '400': { description: Invalid JSON or idempotency key }
        '404': { description: Feature disabled, transaction or replay run not found }
        '409': { description: Idempotency or duplicate event conflict }
        '422': { description: Transition unavailable, wrong actor, out of sequence, final state or simulation boundary }
  /sandbox/v1/transactions/{transactionId}/ppf-submissions:
    post:
      summary: Generate or submit regulatory data to the isolated PPF Simulator
      description: The PPF Simulator is only a simulated regulatory-data collector. It never routes invoices to a buyer or PAR, never calls AIFE/PPF, and distinguishes real DGFiP v3.2 XSD/Annex 7 validation from simulated interoperability.
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                mode: { type: string, enum: [GENERATE, PROVIDED_PAYLOAD] }
                flow: { type: string, enum: ['10.1', '10.2', '10.3', '10.4'] }
                canonicalBatch: { type: object, description: Explicitly classified synthetic D2F_REGULATORY_BATCH_V1 source }
                payload: { type: string, description: Explicit DGFiP Flux 10 XML payload }
                simulatedTransportOutcome: { type: string, enum: [RECEIVED, TEMPORARY_ERROR] }
                interruptAfter: { type: string, enum: [BEFORE_SUBMISSION, AFTER_SUBMISSION, AFTER_RECEIPT] }
                resumeFromExecutionRunId: { type: string, format: uuid }
            examples:
              generatedCrossBorder:
                value: { mode: GENERATE, flow: '10.1', canonicalBatch: { type: DOCUMENT } }
              providedPaymentPayload:
                value: { mode: PROVIDED_PAYLOAD, flow: '10.2', payload: '<Report>...</Report>' }
      responses:
        '200': { description: Idempotent replay or duplicate submission response }
        '202': { description: Persisted accepted, rejected, interrupted or retryable technical PPF submission }
        '400': { description: Invalid JSON or idempotency key }
        '401': { description: Enterprise authentication required }
        '404': { description: PPF feature disabled, transaction or replay run not found }
        '409': { description: Idempotency conflict }
        '413': { description: Payload exceeds the sandbox request limit }
        '422': { description: Invalid request, generation failure or explicit Payment/Country Runtime simulation boundary }
    get:
      summary: List connection-isolated technical PPF transmissions for one transaction
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: Deduplicated PPF submission metadata, validation and evidence references }
        '401': { description: Enterprise authentication required }
        '404': { description: PPF feature disabled or transaction not found in the connection scope }
  /sandbox/v1/transactions/{transactionId}/lifecycle:
    get:
      summary: Retrieve the technical lifecycle trace and final simulated state
      parameters:
        - { name: transactionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { $ref: '#/components/parameters/connectionId' }
      responses:
        '200': { description: Deduplicated lifecycle events, current state and payment boundary }
        '401': { description: Enterprise authentication required }
        '404': { description: Feature disabled or transaction not found in the connection scope }
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
  /sandbox/v1/ingest/ereporting:
    post:
      summary: Ingest canonical source records and let the PA aggregate, generate and validate Flux 10
      description: Accepts D2F_REGULATORY_BATCH_V1 source data. The PA, not the compatible solution, owns the regulatory aggregation and generated Flux 10 documents.
      parameters:
        - { $ref: '#/components/parameters/connectionId' }
        - { $ref: '#/components/parameters/idempotencyKey' }
      requestBody:
        required: true
        content:
          application/json: { schema: { type: object } }
      responses:
        '200': { description: PA aggregation, Flux 10 validation and simulated PPF result }
        '409': { description: Idempotency conflict }
        '422': { description: Canonical source data cannot produce a compliant report }
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
  /sandbox/v1/invoices/{id}/lifecycle:
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
