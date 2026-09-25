import type { EReportingFlow } from "./e-reporting";

type JsonRecord = Record<string, unknown>;

export type GeneratedEReportingDocument = {
  flow: Exclude<EReportingFlow, "UNKNOWN">;
  xml: string;
  recordIds: string[];
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function text(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function escapeXml(value: unknown): string {
  return text(value, 4000).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function compactDate(value: unknown): string {
  return text(value, 10).replace(/-/g, "");
}

function amount(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

function payload(batch: JsonRecord): JsonRecord {
  return record(record(batch.document).payload);
}

function obligationCandidates(batch: JsonRecord, obligationId: string): Set<string> {
  const obligations = Array.isArray(payload(batch).obligations) ? payload(batch).obligations as unknown[] : [];
  const obligation = obligations.map(record).find((item) => text(item.id, 100) === obligationId);
  return new Set(Array.isArray(obligation?.candidate_ids) ? obligation.candidate_ids.map((id) => text(id, 180)) : []);
}

function reportHeader(batch: JsonRecord, flow: Exclude<EReportingFlow, "UNKNOWN">): string {
  const company = record(payload(batch).company);
  const siren = text(company.siren || company.legal_id, 30).replace(/\D/g, "").slice(0, 9);
  if (!/^\d{9}$/.test(siren)) throw new Error("D2F_E_REPORTING_ISSUER_SIREN_REQUIRED");
  const created = new Date();
  const dateTime = created.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const transmissionId = `${text(record(batch.document).number || batch.externalId, 36)}-${flow.replace(".", "")}`.replace(/[^A-Za-z0-9+_\-/]/g, "-").slice(0, 50);
  return `<ReportDocument><Id>${escapeXml(transmissionId)}</Id><Name>D2F PA e-reporting Flux ${flow}</Name><IssueDateTime><DateTimeString>${dateTime}</DateTimeString></IssueDateTime><TypeCode>IN</TypeCode><Sender><Id schemeId="0238">1234</Id><Name>D2F PA Sandbox</Name><RoleCode>WK</RoleCode></Sender><Issuer><Id schemeId="0002">${siren}</Id><Name>${escapeXml(company.legal_name || "Déclarant")}</Name><RoleCode>SE</RoleCode></Issuer></ReportDocument>`;
}

function reportPeriod(batch: JsonRecord): string {
  const period = record(payload(batch).period);
  const start = compactDate(period.start);
  const end = compactDate(period.end);
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end) || start >= end) throw new Error("D2F_E_REPORTING_PERIOD_INVALID");
  return `<ReportPeriod><StartDate>${start}</StartDate><EndDate>${end}</EndDate></ReportPeriod>`;
}

function taxBreakdown(invoice: JsonRecord): JsonRecord[] {
  const provided = Array.isArray(invoice.tax_breakdown) ? invoice.tax_breakdown.map(record) : [];
  if (provided.length) return provided;
  const net = Number(invoice.total_ht);
  const tax = Number(invoice.total_tva);
  if (!Number.isFinite(net) || !Number.isFinite(tax)) throw new Error(`D2F_E_REPORTING_TAX_BREAKDOWN_REQUIRED:${text(invoice.number || invoice.id, 100)}`);
  return [{ rate: net === 0 ? 0 : Number(((tax / net) * 100).toFixed(4)), taxable_amount: net, tax_amount: tax }];
}

function invoiceTaxSubtotals(invoice: JsonRecord): string {
  return taxBreakdown(invoice).map((entry) => `<TaxSubTotal><TaxableAmount>${amount(entry.taxable_amount)}</TaxableAmount><TaxAmount>${amount(entry.tax_amount)}</TaxAmount><TaxCategory><Code>${Number(entry.rate) === 0 ? "Z" : "S"}</Code><Percent>${amount(entry.rate)}</Percent></TaxCategory></TaxSubTotal>`).join("");
}

function category(invoice: JsonRecord): string {
  const operation = text(invoice.operation_category, 40).toLowerCase();
  return operation.includes("service") ? "TPS1" : operation.includes("mix") ? "TMA1" : "TLB1";
}

function generateFlow101(batch: JsonRecord, invoices: JsonRecord[]): GeneratedEReportingDocument | null {
  const ids = obligationCandidates(batch, "fr_transaction_data_10_1");
  const selected = invoices.filter((invoice) => ids.has(text(invoice.id, 180)));
  if (!selected.length) return null;
  const rows = selected.map((invoice) => {
    const buyerId = text(invoice.buyer_identifier, 180);
    if (!buyerId) throw new Error(`D2F_E_REPORTING_BUYER_IDENTIFIER_REQUIRED:${text(invoice.number || invoice.id, 100)}`);
    const typeCode = text(invoice.type, 30).toLowerCase() === "credit_note" ? "381" : "380";
    return `<Invoice><ID>${escapeXml(invoice.number || invoice.id)}</ID><IssueDate>${compactDate(invoice.date)}</IssueDate><TypeCode>${typeCode}</TypeCode><CurrencyCode>${escapeXml(text(invoice.currency, 3).toUpperCase() || "EUR")}</CurrencyCode>${invoice.due_date ? `<DueDate>${compactDate(invoice.due_date)}</DueDate>` : ""}<BusinessProcess><ID>${escapeXml(invoice.billing_mode || "B1")}</ID><TypeID>E-REPORTING</TypeID></BusinessProcess><Seller><CompanyId schemeId="0002">${escapeXml(record(payload(batch).company).siren || record(payload(batch).company).legal_id)}</CompanyId><PostalAddress><CountryId>FR</CountryId></PostalAddress></Seller><Buyer><CompanyId schemeId="${escapeXml(invoice.buyer_identifier_scheme || "VAT")}">${escapeXml(buyerId)}</CompanyId><PostalAddress><CountryId>${escapeXml(text(invoice.customer_country, 2).toUpperCase())}</CountryId></PostalAddress></Buyer><MonetaryTotal><TaxExclusiveAmount>${amount(invoice.total_ht)}</TaxExclusiveAmount><TaxAmount CurrencyCode="EUR">${amount(invoice.total_tva)}</TaxAmount></MonetaryTotal>${invoiceTaxSubtotals(invoice)}</Invoice>`;
  }).join("");
  return { flow: "10.1", xml: `<?xml version="1.0" encoding="UTF-8"?><Report>${reportHeader(batch, "10.1")}<TransactionsReport>${reportPeriod(batch)}${rows}</TransactionsReport></Report>`, recordIds: selected.map((item) => text(item.id, 180)) };
}

function generateFlow103(batch: JsonRecord, invoices: JsonRecord[]): GeneratedEReportingDocument | null {
  const ids = obligationCandidates(batch, "fr_b2c_transactions_10_3");
  const selected = invoices.filter((invoice) => ids.has(text(invoice.id, 180)));
  if (!selected.length) return null;
  const aggregates = new Map<string, { date: string; currency: string; category: string; rate: number; net: number; tax: number; count: number; ids: string[] }>();
  for (const invoice of selected) {
    for (const tax of taxBreakdown(invoice)) {
      const date = text(invoice.date, 10);
      const currency = text(invoice.currency, 3).toUpperCase() || "EUR";
      const operation = category(invoice);
      const rate = Number(tax.rate) || 0;
      const key = `${date}|${currency}|${operation}|${rate}`;
      const current = aggregates.get(key) || { date, currency, category: operation, rate, net: 0, tax: 0, count: 0, ids: [] };
      current.net += Number(tax.taxable_amount) || 0;
      current.tax += Number(tax.tax_amount) || 0;
      current.count += 1;
      current.ids.push(text(invoice.id, 180));
      aggregates.set(key, current);
    }
  }
  const rows = [...aggregates.values()].map((item) => `<Transactions><Date>${compactDate(item.date)}</Date><TransactionsCurrency>${escapeXml(item.currency)}</TransactionsCurrency><CategoryCode>${item.category}</CategoryCode><TaxExclusiveAmount>${amount(item.net)}</TaxExclusiveAmount><TaxTotal>${amount(item.tax)}</TaxTotal><TransactionsCount>${item.count}</TransactionsCount><TaxSubtotal><TaxPercent>${amount(item.rate)}</TaxPercent><TaxableAmount>${amount(item.net)}</TaxableAmount><TaxTotal>${amount(item.tax)}</TaxTotal></TaxSubtotal></Transactions>`).join("");
  return { flow: "10.3", xml: `<?xml version="1.0" encoding="UTF-8"?><Report>${reportHeader(batch, "10.3")}<TransactionsReport>${reportPeriod(batch)}${rows}</TransactionsReport></Report>`, recordIds: [...new Set(selected.map((item) => text(item.id, 180)))] };
}

function paymentSubtotals(invoice: JsonRecord, paidAmount: number): string {
  const total = Number(invoice.total_ttc);
  const ratio = Number.isFinite(total) && Math.abs(total) > 0 ? paidAmount / total : 1;
  return taxBreakdown(invoice).map((entry) => `<SubTotals><TaxPercent>${amount(entry.rate)}</TaxPercent><CurrencyCode>EUR</CurrencyCode><Amount>${amount((Number(entry.taxable_amount) + Number(entry.tax_amount)) * ratio)}</Amount></SubTotals>`).join("");
}

function generatePaymentFlow(batch: JsonRecord, invoices: JsonRecord[], payments: JsonRecord[], flow: "10.2" | "10.4"): GeneratedEReportingDocument | null {
  const obligationId = flow === "10.2" ? "fr_payment_data_10_2" : "fr_b2c_payments_10_4";
  const ids = obligationCandidates(batch, obligationId);
  const selected = payments.filter((payment) => ids.has(text(payment.id, 180)));
  if (!selected.length) return null;
  const invoicesById = new Map(invoices.map((invoice) => [text(invoice.id, 180), invoice]));
  const rows = selected.map((payment) => {
    const invoice = invoicesById.get(text(payment.invoice_id, 180));
    if (!invoice) throw new Error(`D2F_E_REPORTING_PAYMENT_INVOICE_REQUIRED:${text(payment.id, 100)}`);
    const inner = `<Payment><Date>${compactDate(payment.date)}</Date>${paymentSubtotals(invoice, Number(payment.amount) || 0)}</Payment>`;
    return flow === "10.2" ? `<Invoice><InvoiceID>${escapeXml(invoice.number || invoice.id)}</InvoiceID><IssueDate>${compactDate(invoice.date)}</IssueDate>${inner}</Invoice>` : `<Transactions>${inner}</Transactions>`;
  }).join("");
  return { flow, xml: `<?xml version="1.0" encoding="UTF-8"?><Report>${reportHeader(batch, flow)}<PaymentsReport>${reportPeriod(batch)}${rows}</PaymentsReport></Report>`, recordIds: selected.map((item) => text(item.id, 180)) };
}

export function generateEReportingDocuments(value: unknown): GeneratedEReportingDocument[] {
  const batch = record(value);
  if (text(batch.type, 40).toUpperCase() !== "DOCUMENT" || text(record(batch.document).kind, 80) !== "REGULATORY_REPORTING_BATCH") throw new Error("D2F_E_REPORTING_BATCH_REQUIRED");
  if (text(payload(batch).schema, 80) !== "D2F_REGULATORY_BATCH_V1" || text(payload(batch).profile, 30) !== "FR_PA") throw new Error("D2F_E_REPORTING_FR_PROFILE_REQUIRED");
  const records = record(payload(batch).records);
  const invoices = Array.isArray(records.invoices) ? records.invoices.map(record) : [];
  const payments = Array.isArray(records.payments) ? records.payments.map(record) : [];
  const documents = [generateFlow101(batch, invoices), generateFlow103(batch, invoices), generatePaymentFlow(batch, invoices, payments, "10.2"), generatePaymentFlow(batch, invoices, payments, "10.4")].filter((item): item is GeneratedEReportingDocument => Boolean(item));
  if (!documents.length) throw new Error("D2F_E_REPORTING_NO_REPORTABLE_RECORDS");
  return documents;
}
