import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEReportingDocuments } from "../src/e-reporting-ingest";
import { validateCanonical } from "../src/index";
import { SimulatedPpfReportingAdapter } from "../src/simulation/adapters";
import type { SimulationExecution } from "../src/simulation/contracts";
import { b2cEReportingFixture, crossBorderEReportingFixture } from "../src/simulation/fixtures";
import {
  collectPpfSubmissions,
  executePpfSubmission,
  getPpfSubmissionView,
  PpfServiceError,
  type PpfSubmissionRequest,
} from "../src/simulation/ppf-service";
import {
  executePhaseTwoScenario,
  type ScenarioStore,
  type ScenarioTrace,
  type ScenarioTransactionRecord,
} from "../src/simulation/service";
import type { StoredResponse } from "../src/types";

const baseEnv = {
  DB: {} as D1Database,
  APP_VERSION: "1.0.0",
  ENVIRONMENT: "sandbox",
  EXTERNAL_NETWORK_DISABLED: "true",
  API_KEY_HEADER: "x-api-key",
  DGFiP_BASELINE: "3.2",
  CBM_VERSION: "2.1.0",
  PA_DUAL_NODE_SIMULATION: "true",
  DIRECTORY_SIMULATOR: "true",
  PPF_SIMULATOR: "true",
  LIFECYCLE_SIMULATION: "false",
} satisfies Env;

const disabledEnv = { ...baseEnv, PPF_SIMULATOR: "false" } as Env;
const lifecycleEnv = { ...disabledEnv, LIFECYCLE_SIMULATION: "true" } as Env;
const validationNow = () => new Date("2026-09-26T12:00:00Z");

class MemoryScenarioStore implements ScenarioStore {
  readonly idempotency = new Map<string, { fingerprint: string; response: StoredResponse }>();
  readonly transactions = new Map<string, ScenarioTransactionRecord>();
  readonly runs: SimulationExecution[] = [];

  async findIdempotency(connectionId: string, operation: string, key: string) {
    return this.idempotency.get(`${connectionId}:${operation}:${key}`) ?? null;
  }

  async saveIdempotency(connectionId: string, operation: string, key: string, fingerprint: string, response: StoredResponse) {
    this.idempotency.set(`${connectionId}:${operation}:${key}`, { fingerprint, response });
  }

  async getTransaction(transactionId: string, connectionId: string) {
    const transaction = this.transactions.get(transactionId);
    return transaction?.connectionId === connectionId ? transaction : null;
  }

  async createTransactionIfAbsent(transaction: ScenarioTransactionRecord) {
    const stored = this.transactions.get(transaction.transactionId) ?? transaction;
    this.transactions.set(transaction.transactionId, stored);
    return stored;
  }

  async getExecutionRun(executionRunId: string, connectionId: string) {
    const execution = this.runs.find((item) => item.executionRunId === executionRunId);
    const transaction = execution ? this.transactions.get(execution.transactionId) : undefined;
    return transaction?.connectionId === connectionId ? execution ?? null : null;
  }

  async createRun(execution: SimulationExecution) {
    if (!this.runs.some((item) => item.executionRunId === execution.executionRunId)) this.runs.push(execution);
  }

  async getTrace(transactionId: string, connectionId: string): Promise<ScenarioTrace | null> {
    const transaction = await this.getTransaction(transactionId, connectionId);
    if (!transaction) return null;
    const { canonicalTransaction: _canonicalTransaction, ...safeTransaction } = transaction;
    const runs = this.runs.filter((item) => item.transactionId === transactionId);
    return { transaction: safeTransaction, runs, messages: runs.flatMap((item) => item.steps) };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T10:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function createPipeline(store: MemoryScenarioStore, key: string, env: Env = baseEnv) {
  return executePhaseTwoScenario({
    env,
    store,
    connectionId: "phase-4-connection",
    initiatingTenantId: "REAL-BUSINESS-TENANT-MUST-NOT-BE-USED",
    idempotencyKey: key,
    validateCanonical,
  });
}

async function submit(
  store: MemoryScenarioStore,
  transactionId: string,
  key: string,
  request: PpfSubmissionRequest,
  env: Env = baseEnv,
) {
  return executePpfSubmission({
    env,
    store,
    connectionId: "phase-4-connection",
    transactionId,
    idempotencyKey: key,
    request,
    now: validationNow,
  });
}

async function transactionId(store: MemoryScenarioStore, key: string, env: Env = baseEnv): Promise<string> {
  const pipeline = await createPipeline(store, key, env);
  return String(pipeline.body.transactionId);
}

function paymentFixture(): Record<string, unknown> {
  return {
    type: "DOCUMENT",
    externalId: "DEMO-FR-PAYMENT-REPORT-001",
    document: {
      kind: "REGULATORY_REPORTING_BATCH",
      number: "DEMO-FR-PAYMENT-REPORT-001",
      payload: {
        schema: "D2F_REGULATORY_BATCH_V1",
        profile: "FR_PA",
        classificationSource: "EXPLICIT_SYNTHETIC_SCENARIO",
        company: { legal_name: "Synthetic French Seller", siren: "987654321", synthetic: true },
        period: { start: "2026-09-01", end: "2026-09-25" },
        obligations: [
          { id: "fr_payment_data_10_2", candidate_ids: ["pay-b2bi"] },
          { id: "fr_b2c_payments_10_4", candidate_ids: ["pay-b2c"] },
        ],
        records: {
          invoices: [
            { id: "inv-b2bi", number: "FI-1", date: "2026-08-20", total_ht: 100, total_tva: 20, total_ttc: 120, tax_breakdown: [{ rate: 20, taxable_amount: 100, tax_amount: 20 }] },
            { id: "inv-b2c", number: "FC-1", date: "2026-08-21", total_ht: 50, total_tva: 10, total_ttc: 60, tax_breakdown: [{ rate: 20, taxable_amount: 50, tax_amount: 10 }] },
          ],
          payments: [
            { id: "pay-b2bi", invoice_id: "inv-b2bi", date: "2026-09-05", amount: 120 },
            { id: "pay-b2c", invoice_id: "inv-b2c", date: "2026-09-06", amount: 60 },
          ],
        },
      },
    },
  };
}

describe("Phase 4 PPF regulatory-data simulator", () => {
  it("runs the complete generated Flux 10.1 path without routing the invoice through the PPF", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-101-pipeline");
    const response = await submit(store, id, "ppf-101-submit", {
      mode: "GENERATE",
      flow: "10.1",
      canonicalBatch: crossBorderEReportingFixture(),
    });

    expect(response.body).toMatchObject({
      ok: true,
      transactionId: id,
      status: "COMPLETED",
      outcome: { code: "D2F_PPF_ACCEPTED", retryable: false },
      ppfRole: "REGULATORY_DATA_COLLECTOR",
      invoiceRoutingRole: false,
      technicalEvidenceOnly: true,
      submission: {
        flow: "10.1",
        sourceMode: "GENERATED",
        outcome: "ACCEPTED",
        provenance: "PPF_SIMULATED",
        validationCategory: "REAL_REGULATORY_VALIDATION",
        interoperabilityCategory: "SIMULATED_EXTERNAL_INTEROPERABILITY",
        target: "sim://ppf-reporting",
        externalNetworkCalled: false,
      },
    });
    const messages = response.body.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.event)).toEqual([
      "PPF_SUBMISSION_CREATED",
      "PPF_SUBMISSION_SENT",
      "PPF_SUBMISSION_RECEIVED",
      "PPF_VALIDATION_COMPLETED",
      "PPF_SUBMISSION_ACCEPTED",
    ]);
    expect(messages.every((message) => message.provenance === "PPF_SIMULATED")).toBe(true);
    expect(messages.filter((message) => message.actor === "PAR")).toEqual([]);
    const trace = await store.getTrace(id, "phase-4-connection");
    expect(collectPpfSubmissions(trace!)).toHaveLength(1);
    expect(JSON.stringify(trace)).not.toContain("<?xml");
  });

  it("supports a generated Flux 10.3 B2C happy path from an explicitly classified fixture", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-103-pipeline");
    const response = await submit(store, id, "ppf-103-submit", {
      mode: "GENERATE",
      flow: "10.3",
      canonicalBatch: b2cEReportingFixture(),
    });
    expect(response.body).toMatchObject({
      ok: true,
      outcome: { code: "D2F_PPF_ACCEPTED" },
      submission: { flow: "10.3", outcome: "ACCEPTED" },
    });
  });

  it("distinguishes XSD and Annex 7 rejections using the real V3.2 validator", async () => {
    const valid = generateEReportingDocuments(crossBorderEReportingFixture())[0]!.xml;

    const xsdStore = new MemoryScenarioStore();
    const xsdId = await transactionId(xsdStore, "ppf-xsd-pipeline");
    const xsd = await submit(xsdStore, xsdId, "ppf-xsd-submit", {
      mode: "PROVIDED_PAYLOAD",
      flow: "10.1",
      payload: valid.replace("<CurrencyCode>EUR</CurrencyCode>", ""),
    });
    expect(xsd.body).toMatchObject({ ok: false, outcome: { code: "D2F_PPF_REJECTED_XSD" }, submission: { outcome: "REJECTED_XSD" } });

    const annexStore = new MemoryScenarioStore();
    const annexId = await transactionId(annexStore, "ppf-annex-pipeline");
    const annex = await submit(annexStore, annexId, "ppf-annex-submit", {
      mode: "PROVIDED_PAYLOAD",
      flow: "10.1",
      payload: valid.replace("<DateTimeString>20260926100000</DateTimeString>", "<DateTimeString>20260926130000</DateTimeString>"),
    });
    expect(annex.body).toMatchObject({ ok: false, outcome: { code: "D2F_PPF_REJECTED_BUSINESS_RULE" }, submission: { outcome: "REJECTED_BUSINESS_RULE" } });
    expect(JSON.stringify(annex.body)).toContain("F10-G7.43-FUTURE");
  });

  it("rejects an invalid payload in the D2F sandbox namespace", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-invalid-pipeline");
    const response = await submit(store, id, "ppf-invalid-submit", { mode: "PROVIDED_PAYLOAD", payload: "<not-a-report/>" });
    expect(response.body).toMatchObject({
      ok: false,
      outcome: { code: "D2F_PPF_INVALID_PAYLOAD" },
      submission: { outcome: "INVALID_PAYLOAD" },
    });
  });

  it("deduplicates payload submissions and idempotently replays the same request", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-duplicate-pipeline");
    const request: PpfSubmissionRequest = { mode: "GENERATE", flow: "10.1", canonicalBatch: crossBorderEReportingFixture() };
    const first = await submit(store, id, "ppf-duplicate-submit-1", request);
    const replay = await submit(store, id, "ppf-duplicate-submit-1", request);
    const duplicate = await submit(store, id, "ppf-duplicate-submit-2", request);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotentReplay: true, executionRunId: first.body.executionRunId });
    expect(duplicate.body).toMatchObject({
      ok: false,
      transactionId: id,
      outcome: { code: "D2F_PPF_DUPLICATE_SUBMISSION", status: "DUPLICATE_SUBMISSION" },
      duplicateOfSubmissionId: (first.body.submission as Record<string, unknown>).submissionId,
    });
    const view = await getPpfSubmissionView(store, id, "phase-4-connection");
    expect(view).toMatchObject({ count: 1, invoiceRoutingRole: false, externalNetworkCalled: false });
  });

  it("retries a deterministic temporary transport failure without changing transaction or correlation IDs", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-temporary-pipeline");
    const first = await submit(store, id, "ppf-temporary-submit", {
      mode: "GENERATE",
      flow: "10.1",
      canonicalBatch: crossBorderEReportingFixture(),
      simulatedTransportOutcome: "TEMPORARY_ERROR",
    });
    expect(first.body).toMatchObject({ status: "RETRYABLE", outcome: { code: "D2F_PPF_TEMPORARY_ERROR", retryable: true } });

    const resumed = await submit(store, id, "ppf-temporary-retry", { resumeFromExecutionRunId: String(first.body.executionRunId) });
    expect(resumed.body).toMatchObject({
      ok: true,
      transactionId: first.body.transactionId,
      correlationId: first.body.correlationId,
      resumedFromExecutionRunId: first.body.executionRunId,
      outcome: { code: "D2F_PPF_ACCEPTED" },
    });
    expect((resumed.body.submission as Record<string, unknown>).submissionId).toBe((first.body.submission as Record<string, unknown>).submissionId);
  });

  it.each(["BEFORE_SUBMISSION", "AFTER_SUBMISSION", "AFTER_RECEIPT"] as const)(
    "resumes after %s while preserving history and prior evidence",
    async (interruptAfter) => {
      const store = new MemoryScenarioStore();
      const id = await transactionId(store, `ppf-interrupt-${interruptAfter}`);
      const interrupted = await submit(store, id, `ppf-interrupt-submit-${interruptAfter}`, {
        mode: "GENERATE",
        flow: "10.1",
        canonicalBatch: crossBorderEReportingFixture(),
        interruptAfter,
      });
      expect(interrupted.body).toMatchObject({ status: "INTERRUPTED", outcome: { retryable: true } });
      const resumed = await submit(store, id, `ppf-interrupt-resume-${interruptAfter}`, {
        resumeFromExecutionRunId: String(interrupted.body.executionRunId),
      });
      expect(resumed.body).toMatchObject({ ok: true, transactionId: id, resumedFromExecutionRunId: interrupted.body.executionRunId });
      const trace = await store.getTrace(id, "phase-4-connection");
      expect(trace!.runs).toHaveLength(3);
      expect(collectPpfSubmissions(trace!)).toHaveLength(1);
      expect(trace!.messages.at(-1)?.event).toBe("PPF_SUBMISSION_ACCEPTED");
    },
  );

  it("blocks generation of Flux 10.2/10.4 but accepts explicitly supplied, already formed payloads", async () => {
    const generatedPayments = generateEReportingDocuments(paymentFixture());
    expect(generatedPayments.map((document) => document.flow)).toEqual(["10.2", "10.4"]);

    for (const flow of ["10.2", "10.4"] as const) {
      const store = new MemoryScenarioStore();
      const id = await transactionId(store, `ppf-payment-${flow}`);
      await expect(submit(store, id, `ppf-payment-generation-${flow}`, {
        mode: "GENERATE",
        flow,
        canonicalBatch: paymentFixture(),
      })).rejects.toMatchObject({
        code: "SIMULATION_BOUNDARY",
        blockedBy: "PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT",
      } satisfies Partial<PpfServiceError>);
      expect(store.runs).toHaveLength(1);

      const payload = generatedPayments.find((document) => document.flow === flow)!.xml;
      const supplied = await submit(store, id, `ppf-payment-supplied-${flow}`, { mode: "PROVIDED_PAYLOAD", flow, payload });
      expect(supplied.body).toMatchObject({ ok: true, submission: { flow, sourceMode: "PROVIDED_PAYLOAD", outcome: "ACCEPTED" } });
    }
  });

  it("fails closed when the PPF flag is OFF and preserves the 0.9.0 lifecycle-only pipeline", async () => {
    const store = new MemoryScenarioStore();
    const id = await transactionId(store, "ppf-disabled-pipeline", lifecycleEnv);
    await expect(submit(store, id, "ppf-disabled-submit", {
      mode: "GENERATE",
      flow: "10.1",
      canonicalBatch: crossBorderEReportingFixture(),
    }, disabledEnv)).rejects.toMatchObject({ code: "PPF_FEATURE_DISABLED" } satisfies Partial<PpfServiceError>);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.steps).toHaveLength(13);
    expect(store.runs[0]!.steps.some((step) => step.event.startsWith("PPF_"))).toBe(false);
  });

  it("blocks an accidental external adapter target before any network call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = new SimulatedPpfReportingAdapter(true);
    await expect(adapter.submit({
      transactionId: "transaction",
      correlationId: "correlation",
      executionRunId: "run",
      endpoint: "https://external-ppf.invalid",
      payloadSha256: "a".repeat(64),
      validationOutcome: "ACCEPTED",
    })).rejects.toMatchObject({ code: "EXTERNAL_NETWORK_BLOCKED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
