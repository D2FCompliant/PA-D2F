import { XMLParser } from "fast-xml-parser";
import { validateXsdDocument, type ValidationStage } from "./formal-validation";
import type { ValidationIssue } from "./types";

export type EReportingFlow = "10.1" | "10.2" | "10.3" | "10.4" | "UNKNOWN";

export type EReportingIdentity = {
  transmissionId: string;
  issuerId: string;
  periodStart: string;
  periodEnd: string;
};

export type EReportingValidation = {
  flow: EReportingFlow;
  identity: EReportingIdentity;
  stages: ValidationStage[];
  issues: ValidationIssue[];
};

type XmlRecord = Record<string, unknown>;

const DATE_PATTERN = /^\d{8}$/;
const DATE_TIME_PATTERN = /^\d{14}$/;
const TRANSMISSION_ID_PATTERN = /^[A-Za-z0-9+_\-/](?:[A-Za-z0-9+_\-/ ]*[A-Za-z0-9+_\-/])?$/;
const CATEGORY_CODES = new Set(["TLB1", "TPS1", "TNT1", "TMA1"]);
const VAT_CATEGORY_CODES = new Set(["S", "E", "AE", "K", "G", "O", "Z"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export async function validateEReporting(payload: string, now = new Date()): Promise<EReportingValidation> {
  const xsd = await validateXsdDocument(payload, {
    root: "e-reporting/ereporting.xsd",
    rule: "DGFiP-FLUX10-XSD",
    standard: "DGFiP Flux 10 XSD",
    standardVersion: "3.2",
    documentUrl: "memory:///submitted-flux10.xml",
  });
  let report: XmlRecord = {};
  const parseIssues: ValidationIssue[] = [];
  try {
    const parsed = record(parser.parse(payload));
    report = record(parsed.Report);
    if (!Object.keys(report).length) parseIssues.push(issue("F10-ROOT-INVALID", "DGFiP-FLUX10-ROOT", "The root element must be Report.", "/Report"));
  } catch (error) {
    parseIssues.push(issue("F10-XML-MALFORMED", "XML-001", error instanceof Error ? error.message : "The Flux 10 XML is malformed.", "/"));
  }

  const flow = detectEReportingFlow(report);
  const business = Object.keys(report).length ? validateBusinessRules(report, flow, now) : [];
  const issues = [...xsd, ...parseIssues, ...business];
  const stages: ValidationStage[] = [
    { id: "xml", status: parseIssues.length ? "FAIL" : "PASS", standard: "XML", version: "1.0", issueCount: parseIssues.length },
    { id: "xsd", status: xsd.some(isError) ? "FAIL" : "PASS", standard: "DGFiP Flux 10 XSD", version: "3.2", issueCount: xsd.length },
    { id: "business-rules", status: business.some(isError) ? "FAIL" : "PASS", standard: "DGFiP Annex 7 management rules", version: "1.9", issueCount: business.length },
    { id: "schematron", status: "NOT_APPLICABLE", standard: "Official Flux 10 Schematron", version: "not published in DGFiP v3.2 archive", issueCount: 0 },
  ];
  const document = record(report.ReportDocument);
  const family = flow === "10.1" || flow === "10.3" ? record(report.TransactionsReport) : record(report.PaymentsReport);
  const period = record(family.ReportPeriod);
  return {
    flow,
    identity: {
      transmissionId: text(document.Id),
      issuerId: text(record(document.Issuer).Id),
      periodStart: text(period.StartDate),
      periodEnd: text(period.EndDate),
    },
    stages,
    issues,
  };
}

export function detectEReportingFlow(report: XmlRecord): EReportingFlow {
  const transactions = record(report.TransactionsReport);
  const payments = record(report.PaymentsReport);
  const candidates: EReportingFlow[] = [];
  if (items(transactions.Invoice).length) candidates.push("10.1");
  if (items(payments.Invoice).length) candidates.push("10.2");
  if (items(transactions.Transactions).length) candidates.push("10.3");
  if (items(payments.Transactions).length) candidates.push("10.4");
  return candidates.length === 1 ? candidates[0] : "UNKNOWN";
}

function validateBusinessRules(report: XmlRecord, flow: EReportingFlow, now: Date): ValidationIssue[] {
  const output: ValidationIssue[] = [];
  const document = record(report.ReportDocument);
  const transactions = record(report.TransactionsReport);
  const payments = record(report.PaymentsReport);
  const hasTransactions = Object.keys(transactions).length > 0;
  const hasPayments = Object.keys(payments).length > 0;

  if (hasTransactions === hasPayments) output.push(issue("F10-G6.29", "G6.29", "A transmission must contain either TransactionsReport or PaymentsReport, never both or neither.", "/Report"));
  if (flow === "UNKNOWN") output.push(issue("F10-FLOW-AMBIGUOUS", "DGFiP-FLUX10-SHAPE", "The payload must represent exactly one of Flux 10.1, 10.2, 10.3 or 10.4.", "/Report"));

  const transmissionId = text(document.Id);
  if (!transmissionId || transmissionId.length > 50 || !TRANSMISSION_ID_PATTERN.test(transmissionId) || transmissionId.includes("  ")) {
    output.push(issue("F10-G1.104", "G1.104", "TT-1 must be 1 to 50 characters, use only the authorized characters, and contain no leading, trailing or consecutive spaces.", "/Report/ReportDocument/Id"));
  }
  const dateTime = text(record(document.IssueDateTime).DateTimeString);
  if (!validDateTime(dateTime)) output.push(issue("F10-G7.53", "G7.53", "TT-3 must be a valid date-time formatted AAAAMMJJHHMMSS between years 2000 and 2099.", "/Report/ReportDocument/IssueDateTime/DateTimeString"));
  if (!new Set(["IN", "RE"]).has(text(document.TypeCode))) output.push(issue("F10-G8.01", "G8.01", "TT-4 must be IN or RE.", "/Report/ReportDocument/TypeCode"));

  const sender = record(document.Sender);
  const senderId = record(sender.Id);
  if (text(senderId) && (!/^\d{4}$/.test(text(senderId)) || attribute(senderId, "schemeId") !== "0238")) {
    output.push(issue("F10-G6.22", "G6.22", "TT-8 must be a four-digit PA matricule and TT-7 must be 0238.", "/Report/ReportDocument/Sender/Id"));
  }
  if (text(sender.RoleCode) !== "WK") output.push(issue("F10-G7.51", "G7.51", "The PA sender role TT-10 must be WK.", "/Report/ReportDocument/Sender/RoleCode"));

  const issuerId = record(record(document.Issuer).Id);
  if (!/^\d{9}$/.test(text(issuerId)) || attribute(issuerId, "schemeId") !== "0002") {
    output.push(issue("F10-G6.26", "G6.26", "From 1 September 2026, TT-13 must be a nine-digit SIREN and TT-12 must be 0002.", "/Report/ReportDocument/Issuer/Id"));
  }

  const family = hasTransactions ? transactions : payments;
  const period = record(family.ReportPeriod);
  const start = text(period.StartDate);
  const end = text(period.EndDate);
  checkDate(start, "/Report/*Report/ReportPeriod/StartDate", now, output);
  checkDate(end, "/Report/*Report/ReportPeriod/EndDate", now, output);
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  if (startDate && endDate && endDate <= startDate) output.push(issue("F10-G6.25", "G6.25", "The transmission period end date must be later than its start date.", "/Report/*Report/ReportPeriod"));
  if (endDate && endDate >= startOfUtcDay(now)) output.push(issue("F10-G7.43-END", "G7.43", "The transmission period end date must be earlier than the control date.", "/Report/*Report/ReportPeriod/EndDate"));
  const createdAt = parseDateTime(dateTime);
  if (createdAt && createdAt > now) output.push(issue("F10-G7.43-FUTURE", "G7.43", "The transmission creation time cannot be in the future.", "/Report/ReportDocument/IssueDateTime/DateTimeString"));
  if (createdAt && endDate && createdAt <= endDate) output.push(issue("F10-G7.43-ORDER", "G7.43", "The transmission creation time must be later than the declared period end date.", "/Report/ReportDocument/IssueDateTime/DateTimeString"));

  if (flow === "10.1") validateInvoices(items(transactions.Invoice), now, output);
  if (flow === "10.2") validatePayments(items(payments.Invoice), true, now, output);
  if (flow === "10.3") validateAggregates(items(transactions.Transactions), now, output);
  if (flow === "10.4") validatePayments(items(payments.Transactions), false, now, output);
  return output;
}

function validateInvoices(invoices: unknown[], now: Date, output: ValidationIssue[]): void {
  invoices.forEach((value, index) => {
    const invoice = record(value);
    const base = `/Report/TransactionsReport/Invoice[${index + 1}]`;
    checkDate(text(invoice.IssueDate), `${base}/IssueDate`, now, output);
    if (!record(invoice.Buyer).CompanyId) output.push(issue("F10-G6.28", "G6.28", "Flux 10.1 is reserved for B2B international invoices and requires buyer identifier TT-36.", `${base}/Buyer/CompanyId`));
    const currency = text(invoice.CurrencyCode);
    if (!/^[A-Z]{3}$/.test(currency)) output.push(issue("F10-G1.10", "G1.10", "TT-22 must be a three-letter ISO 4217 currency code.", `${base}/CurrencyCode`));
    const monetary = record(invoice.MonetaryTotal);
    const taxAmount = record(monetary.TaxAmount);
    if (attribute(taxAmount, "CurrencyCode") !== "EUR") output.push(issue("F10-G6.23", "G6.23", "TT-52, the VAT amount currency, must be EUR.", `${base}/MonetaryTotal/TaxAmount/@CurrencyCode`));
    const subtotals = items(invoice.TaxSubTotal).map(record);
    subtotals.forEach((subtotal, subtotalIndex) => {
      const category = text(record(subtotal.TaxCategory).Code);
      if (category && !VAT_CATEGORY_CODES.has(category)) output.push(issue("F10-G2.31", "G2.31", `Unsupported VAT category code ${category}.`, `${base}/TaxSubTotal[${subtotalIndex + 1}]/TaxCategory/Code`));
    });
    checkTotals(number(monetary.TaxExclusiveAmount), subtotals.map((item) => number(item.TaxableAmount)), "TT-51", "TT-54", `${base}/MonetaryTotal/TaxExclusiveAmount`, output);
    checkTotals(number(taxAmount), subtotals.map((item) => number(item.TaxAmount)), "TT-52", "TT-55", `${base}/MonetaryTotal/TaxAmount`, output);
  });
}

function validateAggregates(transactions: unknown[], now: Date, output: ValidationIssue[]): void {
  transactions.forEach((value, index) => {
    const transaction = record(value);
    const base = `/Report/TransactionsReport/Transactions[${index + 1}]`;
    checkDate(text(transaction.Date), `${base}/Date`, now, output);
    const category = text(transaction.CategoryCode);
    if (!CATEGORY_CODES.has(category)) output.push(issue("F10-G1.68", "G1.68", `TT-81 must be one of ${[...CATEGORY_CODES].join(", ")}.`, `${base}/CategoryCode`));
    if (!/^[A-Z]{3}$/.test(text(transaction.TransactionsCurrency))) output.push(issue("F10-G1.10", "G1.10", "TT-80 must be a three-letter ISO 4217 currency code.", `${base}/TransactionsCurrency`));
    const subtotals = items(transaction.TaxSubtotal).map(record);
    checkTotals(number(transaction.TaxExclusiveAmount), subtotals.map((item) => number(item.TaxableAmount)), "TT-82", "TT-87", `${base}/TaxExclusiveAmount`, output);
    checkTotals(number(transaction.TaxTotal), subtotals.map((item) => number(item.TaxTotal)), "TT-83", "TT-88", `${base}/TaxTotal`, output);
  });
}

function validatePayments(values: unknown[], invoiceLevel: boolean, now: Date, output: ValidationIssue[]): void {
  values.forEach((value, index) => {
    const item = record(value);
    const payment = record(item.Payment);
    const base = `/Report/PaymentsReport/${invoiceLevel ? "Invoice" : "Transactions"}[${index + 1}]`;
    if (invoiceLevel) checkDate(text(item.IssueDate), `${base}/IssueDate`, now, output);
    checkDate(text(payment.Date), `${base}/Payment/Date`, now, output);
    items(payment.SubTotals).map(record).forEach((subtotal, subtotalIndex) => {
      if (text(subtotal.CurrencyCode) !== "EUR") output.push(issue("F10-G6.27", "G6.27", "The collected amount currency TT-95/TT-99 must be EUR.", `${base}/Payment/SubTotals[${subtotalIndex + 1}]/CurrencyCode`));
    });
  });
}

function checkDate(value: string, path: string, now: Date, output: ValidationIssue[]): void {
  const parsed = parseDate(value);
  if (!parsed) output.push(issue("F10-G1.09", "G1.09/G1.36", "Dates must be valid and formatted AAAAMMJJ between years 2000 and 2099.", path));
  else if (parsed > startOfUtcDay(now)) output.push(issue("F10-G1.07", "G1.07", "The date cannot be later than the control date.", path));
}

function checkTotals(total: number | null, values: Array<number | null>, totalTerm: string, detailTerm: string, path: string, output: ValidationIssue[]): void {
  if (total === null || values.some((item) => item === null)) return;
  const sum = values.reduce<number>((accumulator, item) => accumulator + (item ?? 0), 0);
  if (Math.abs(total - sum) > 0.01) output.push(issue("F10-G1.53", "G1.53", `${totalTerm} must equal the sum of ${detailTerm} within a tolerance of 0.01.`, path));
}

function issue(code: string, rule: string, message: string, path: string): ValidationIssue {
  return { code, severity: "error", source: "business", rule, message, path, standard: "DGFiP Annex 7 management rules", standardVersion: "1.9" };
}

function record(value: unknown): XmlRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as XmlRecord : {};
}

function items(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return String(record(value)["#text"] ?? "").trim();
}

function attribute(value: unknown, name: string): string {
  return String(record(value)[`@_${name}`] ?? "").trim();
}

function number(value: unknown): number | null {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 2000 || year > 2099) return null;
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day ? result : null;
}

function parseDateTime(value: string): Date | null {
  if (!DATE_TIME_PATTERN.test(value)) return null;
  const date = parseDate(value.slice(0, 8));
  if (!date) return null;
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return new Date(date.getTime() + ((hour * 60 + minute) * 60 + second) * 1000);
}

function validDateTime(value: string): boolean {
  return parseDateTime(value) !== null;
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isError(value: ValidationIssue): boolean {
  return value.severity === "error";
}
