import { XMLParser } from "fast-xml-parser";
import SaxonJS from "saxon-js";
import { XSD_TEXT_BY_PATH } from "./generated/xsd-bundle";
import en16931Ubl from "./generated/schematron/en16931-ubl.sef.json";
import brFrUbl from "./generated/schematron/br-fr-ubl.sef.json";
import type { InvoiceFormat, ValidationIssue } from "./types";

export type ValidationStage = {
  id: "xml" | "xsd" | "en16931" | "schematron";
  status: "PASS" | "FAIL" | "NOT_APPLICABLE";
  standard: string;
  version: string;
  issueCount: number;
};

const XSD_BASE = "memory:///";
const encoder = new TextEncoder();
const xsdBuffers = Object.fromEntries(
  Object.entries(XSD_TEXT_BY_PATH).map(([path, source]) => [`${XSD_BASE}${path}`, encoder.encode(source)]),
);
type Libxml = typeof import("libxml2-wasm");
let libxmlPromise: Promise<Libxml> | undefined;
let inputProviderRegistered = false;

async function getLibxml(): Promise<Libxml> {
  libxmlPromise ??= import("libxml2-wasm");
  const libxml = await libxmlPromise;
  if (!inputProviderRegistered) {
    libxml.xmlRegisterInputProvider(new libxml.XmlBufferInputProvider(xsdBuffers));
    inputProviderRegistered = true;
  }
  return libxml;
}

const schemaRoots: Partial<Record<InvoiceFormat, string>> = {
  UBL: "F1_BASE_UBL_2.1/F1BASE_UBL-invoice-2.1.xsd",
  CII: "F1_BASE_CII_D22B/uncefact/data/standard/F1BASE_CrossIndustryInvoice_100pD22B.xsd",
};

function validationIssue(input: Partial<ValidationIssue> & Pick<ValidationIssue, "code" | "source" | "rule" | "message">): ValidationIssue {
  return {
    code: input.code,
    severity: input.severity || "error",
    source: input.source,
    rule: input.rule,
    message: input.message,
    path: input.path || "/",
    standard: input.standard || "DGFiP external specifications",
    standardVersion: input.standardVersion || "3.2",
  };
}

function xsdIssues(error: unknown, libxml: Libxml): ValidationIssue[] {
  if (error instanceof libxml.XmlLibError && error.details.length) {
    return error.details.map((detail, index) => validationIssue({
      code: `XSD-${String(index + 1).padStart(3, "0")}`,
      source: "xsd",
      rule: "DGFiP-FLUX1-XSD",
      message: detail.message.trim(),
      path: detail.xpath || (detail.line ? `line:${detail.line}${detail.col ? `:${detail.col}` : ""}` : "/"),
      standard: "DGFiP Flux 1 XSD",
    }));
  }
  return [validationIssue({ code: "XSD-ENGINE-ERROR", source: "xsd", rule: "DGFiP-FLUX1-XSD", message: error instanceof Error ? error.message : "XSD validation failed", standard: "DGFiP Flux 1 XSD" })];
}

async function validateXsd(payload: string, format: InvoiceFormat): Promise<ValidationIssue[]> {
  const root = schemaRoots[format];
  if (!root) return [validationIssue({ code: "XSD-FORMAT-NOT-SUPPORTED", source: "xsd", rule: "DGFiP-FLUX1-XSD", message: `No DGFiP Flux 1 XSD root is configured for ${format}.` })];
  const libxml = await getLibxml();
  const schema = libxml.XmlDocument.fromString(XSD_TEXT_BY_PATH[root] || "", { url: `${XSD_BASE}${root}`, option: libxml.ParseOption.XML_PARSE_NONET | libxml.ParseOption.XML_PARSE_NO_XXE });
  let validator: InstanceType<Libxml["XsdValidator"]> | null = null;
  let document: InstanceType<Libxml["XmlDocument"]> | null = null;
  try {
    validator = libxml.XsdValidator.fromDoc(schema);
    document = libxml.XmlDocument.fromString(payload, { url: "memory:///submitted-invoice.xml", option: libxml.ParseOption.XML_PARSE_NONET | libxml.ParseOption.XML_PARSE_NO_XXE });
    validator.validate(document);
    return [];
  } catch (error) {
    return xsdIssues(error, libxml);
  } finally {
    document?.dispose();
    validator?.dispose();
    schema.dispose();
  }
}

type SaxonResult = { principalResult?: unknown };

function attribute(value: unknown, name: string) {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return String(record[`@_${name}`] || "").trim();
}

function content(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return Object.entries(record).filter(([key]) => !key.startsWith("@_")).map(([, item]) => content(item)).filter(Boolean).join(" ").trim();
}

function collectFailedAssertions(value: unknown, source: "en16931" | "schematron", output: ValidationIssue[] = []): ValidationIssue[] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFailedAssertions(item, source, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith(":failed-assert") || key === "failed-assert") {
      const assertions = Array.isArray(child) ? child : [child];
      for (const assertion of assertions) {
        const flag = attribute(assertion, "flag").toLowerCase();
        output.push(validationIssue({
          code: attribute(assertion, "id") || `${source.toUpperCase()}-RULE`,
          severity: flag === "warning" ? "warning" : flag === "info" || flag === "information" ? "information" : "error",
          source,
          rule: attribute(assertion, "test") || attribute(assertion, "id") || "Schematron assertion",
          message: content(assertion) || "Schematron assertion failed",
          path: attribute(assertion, "location") || "/",
          standard: source === "en16931" ? "EN 16931" : "FNFE France Schematron",
          standardVersion: source === "en16931" ? "2017" : "1.4.0.04",
        }));
      }
    } else collectFailedAssertions(child, source, output);
  }
  return output;
}

function runSchematron(payload: string, stylesheetInternal: unknown, source: "en16931" | "schematron") {
  try {
    const result = (SaxonJS as unknown as { transform(options: Record<string, unknown>, mode: "sync"): SaxonResult }).transform({
      stylesheetInternal,
      sourceText: payload,
      destination: "serialized",
    }, "sync");
    const svrl = String(result.principalResult || "");
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", trimValues: true }).parse(svrl) as unknown;
    return collectFailedAssertions(parsed, source);
  } catch (error) {
    return [validationIssue({ code: `${source.toUpperCase()}-ENGINE-ERROR`, source, rule: "SCHEMATRON-ENGINE", message: error instanceof Error ? error.message : "Schematron execution failed", standard: source === "en16931" ? "EN 16931" : "FNFE France Schematron", standardVersion: source === "en16931" ? "2017" : "1.4.0.04" })];
  }
}

export async function validateFormalInvoice(payload: string, format: InvoiceFormat): Promise<{ stages: ValidationStage[]; issues: ValidationIssue[] }> {
  const xsd = await validateXsd(payload, format);
  const stages: ValidationStage[] = [{ id: "xml", status: "PASS", standard: "XML", version: "1.0", issueCount: 0 }];
  stages.push({ id: "xsd", status: xsd.some((item) => item.severity === "error") ? "FAIL" : "PASS", standard: "DGFiP Flux 1 XSD", version: "3.2", issueCount: xsd.length });
  if (format !== "UBL") {
    stages.push({ id: "en16931", status: "NOT_APPLICABLE", standard: "EN 16931", version: "2017", issueCount: 0 });
    stages.push({ id: "schematron", status: "NOT_APPLICABLE", standard: "FNFE France Schematron", version: "1.4.0.04", issueCount: 0 });
    return { stages, issues: xsd };
  }
  const en16931 = runSchematron(payload, en16931Ubl, "en16931");
  const france = runSchematron(payload, brFrUbl, "schematron");
  stages.push({ id: "en16931", status: en16931.some((item) => item.severity === "error") ? "FAIL" : "PASS", standard: "EN 16931", version: "2017", issueCount: en16931.length });
  stages.push({ id: "schematron", status: france.some((item) => item.severity === "error") ? "FAIL" : "PASS", standard: "FNFE France Schematron", version: "1.4.0.04", issueCount: france.length });
  return { stages, issues: [...xsd, ...en16931, ...france] };
}
