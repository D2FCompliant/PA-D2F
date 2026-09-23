import type { InvoiceFormat, ValidationIssue } from "./types";

const UBL_NAMESPACE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";

export function detectInvoiceFormat(contentType: string, payload: string): InvoiceFormat {
  if (contentType.toLowerCase().includes("pdf")) return payload.includes("factur-x.xml") ? "FACTUR-X" : "UNKNOWN";
  if (payload.includes(UBL_NAMESPACE) || /<([\w-]+:)?(Invoice|CreditNote)(?:\s|>)/.test(payload)) return "UBL";
  if (payload.includes("CrossIndustryInvoice")) return "CII";
  return "UNKNOWN";
}

export function validateTransport(contentType: string, payload: string, maxBytes = 20 * 1024 * 1024): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!payload.trim()) issues.push(issue("EMPTY_DOCUMENT", "transport", "TRANSPORT-001", "The document body is empty.", "HTTP", "1.1"));
  if (new TextEncoder().encode(payload).byteLength > maxBytes) issues.push(issue("DOCUMENT_TOO_LARGE", "transport", "TRANSPORT-002", `The document exceeds ${maxBytes} bytes.`, "HTTP", "1.1"));
  if (!/(application|text)\/(xml|[^;]+\+xml)/i.test(contentType)) issues.push(issue("UNSUPPORTED_MEDIA_TYPE", "mime", "MIME-001", "Legacy invoice submission requires an XML media type.", "D2F Legacy PA Contract", "1.0"));
  return issues;
}

export function validateXmlStructure(payload: string, format: InvoiceFormat): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!payload.trim().startsWith("<") || !payload.trim().endsWith(">")) return [issue("MALFORMED_XML", "xml", "XML-001", "The payload is not a complete XML document.", "XML", "1.0")];
  if (/<!DOCTYPE|<!ENTITY/i.test(payload)) issues.push(issue("XML_DTD_FORBIDDEN", "xml", "XML-SEC-001", "DTD and entity declarations are forbidden.", "XML Security", "1.0"));
  if (format === "UNKNOWN") issues.push(issue("UNSUPPORTED_INVOICE_FORMAT", "xml", "FORMAT-001", "The XML is neither a recognizable UBL invoice nor a CII invoice.", "XP Z12-012", "1.4"));
  return issues;
}

export function baselineNotices(format: InvoiceFormat): ValidationIssue[] {
  return format === "UNKNOWN" ? [] : [{ code: "FORMAL_RULESET_PENDING", severity: "information", source: "schematron", rule: "BASELINE-001", message: "Formal XSD and Schematron artefacts are retained but are not yet connected to this submission route.", path: "/", standard: "DGFiP/FNFE", standardVersion: "3.2/1.4.0.04" }];
}

function issue(code: string, source: ValidationIssue["source"], rule: string, message: string, standard: string, standardVersion: string): ValidationIssue {
  return { code, severity: "error", source, rule, message, path: "/", standard, standardVersion };
}
