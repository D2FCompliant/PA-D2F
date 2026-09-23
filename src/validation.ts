import type { InvoiceFormat, ValidationIssue } from "./types";

const UBL_INVOICE_NAMESPACE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
const CII_MARKERS = ["CrossIndustryInvoice", "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice"];

export function detectInvoiceFormat(contentType: string, payload: string): InvoiceFormat {
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("pdf")) return payload.includes("factur-x.xml") ? "FACTUR-X" : "UNKNOWN";
  if (payload.includes(UBL_INVOICE_NAMESPACE) || /<([\w-]+:)?Invoice(?:\s|>)/.test(payload)) return "UBL";
  if (CII_MARKERS.some((marker) => payload.includes(marker))) return "CII";
  return "UNKNOWN";
}

export function validateTransport(contentType: string, payload: string, maxBytes = 20 * 1024 * 1024): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (!payload.trim()) issues.push(issue("EMPTY_DOCUMENT", "transport", "TRANSPORT-001", "The document body is empty.", "/", "HTTP", "1.1"));
  if (bytes > maxBytes) issues.push(issue("DOCUMENT_TOO_LARGE", "transport", "TRANSPORT-002", `The document exceeds ${maxBytes} bytes.`, "/", "HTTP", "1.1"));
  if (!/(application|text)\/(xml|[^;]+\+xml)/i.test(contentType)) issues.push(issue("UNSUPPORTED_MEDIA_TYPE", "mime", "MIME-001", "Legacy invoice submission requires an XML media type.", "/", "D2F Legacy PA Contract", "1.0"));
  return issues;
}

export function validateXmlStructure(payload: string, format: InvoiceFormat): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!payload.trim().startsWith("<") || !payload.trim().endsWith(">")) {
    issues.push(issue("MALFORMED_XML", "xml", "XML-001", "The payload is not a complete XML document.", "/", "XML", "1.0"));
    return issues;
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(payload)) issues.push(issue("XML_DTD_FORBIDDEN", "xml", "XML-SEC-001", "DTD and entity declarations are forbidden.", "/", "XML Security", "1.0"));
  if (format === "UNKNOWN") issues.push(issue("UNSUPPORTED_INVOICE_FORMAT", "xml", "FORMAT-001", "The XML is neither a recognizable UBL invoice nor a CII invoice.", "/", "XP Z12-012", "2026"));
  return issues;
}

export function baselineNotices(format: InvoiceFormat): ValidationIssue[] {
  if (format === "UNKNOWN") return [];
  return [
    {
      code: "FORMAL_RULESET_PENDING",
      severity: "information",
      source: "schematron",
      rule: "BASELINE-001",
      message: "Structural acceptance does not yet assert EN 16931, CIUS France or EXTENDED-CTC-FR conformance. Official rulesets must pass before qualification.",
      path: "/",
      standard: "DGFiP external specifications",
      standardVersion: "3.2"
    }
  ];
}

function issue(code: string, source: ValidationIssue["source"], rule: string, message: string, path: string, standard: string, standardVersion: string): ValidationIssue {
  return { code, severity: "error", source, rule, message, path, standard, standardVersion };
}

