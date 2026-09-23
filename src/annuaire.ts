import { XMLParser } from "fast-xml-parser";
import { validateXsdDocument, type ValidationStage } from "./formal-validation";
import type { ValidationIssue } from "./types";

export type AnnuaireFlow = "12" | "13" | "14";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true, parseTagValue: false, trimValues: true });

export async function validateAnnuaire(payload: string, flow: AnnuaireFlow): Promise<{ flow: AnnuaireFlow; stages: ValidationStage[]; issues: ValidationIssue[] }> {
  const actualisation = flow === "12" || flow === "13";
  const root = actualisation
    ? "annuaire/actualisation/Annuaire_Actualisation_F12-F13.xsd"
    : "annuaire/consultation/Annuaire_Consultation_F14.xsd";
  const xsd = await validateXsdDocument(payload, {
    root,
    rule: `DGFiP-FLUX${flow}-XSD`,
    standard: `DGFiP Annuaire Flux ${flow} XSD`,
    standardVersion: "3.2",
    documentUrl: `memory:///submitted-annuaire-flux-${flow}.xml`,
  });
  const business: ValidationIssue[] = [];
  try {
    const parsed = record(parser.parse(payload));
    const expectedRoot = actualisation ? "AnnuaireActualisation" : "AnnuaireConsultationF14";
    const document = record(parsed[expectedRoot]);
    if (!Object.keys(document).length) business.push(issue(flow, "ANNUAIRE-ROOT", `The root element for Flux ${flow} must be ${expectedRoot}.`, `/${expectedRoot}`));
    if (flow === "12" && !Object.keys(record(document.BlocCodesRoutage)).length) business.push(issue(flow, "ANNUAIRE-F12-SHAPE", "Flux 12 must contain BlocCodesRoutage.", `/${expectedRoot}/BlocCodesRoutage`));
    if (flow === "13" && !Object.keys(record(document.BlocLignesAnnuaire)).length) business.push(issue(flow, "ANNUAIRE-F13-SHAPE", "Flux 13 must contain BlocLignesAnnuaire.", `/${expectedRoot}/BlocLignesAnnuaire`));
    validatePeriods(document, flow, business, `/${expectedRoot}`);
  } catch (error) {
    business.push(issue(flow, "XML-001", error instanceof Error ? error.message : "The Annuaire XML is malformed.", "/"));
  }
  const stages: ValidationStage[] = [
    { id: "xml", status: business.some((item) => item.rule === "XML-001") ? "FAIL" : "PASS", standard: "XML", version: "1.0", issueCount: business.filter((item) => item.rule === "XML-001").length },
    { id: "xsd", status: xsd.some(isError) ? "FAIL" : "PASS", standard: `DGFiP Annuaire Flux ${flow} XSD`, version: "3.2", issueCount: xsd.length },
    { id: "business-rules", status: business.some(isError) ? "FAIL" : "PASS", standard: "DGFiP Annex 7 management rules", version: "1.9", issueCount: business.length },
    { id: "schematron", status: "NOT_APPLICABLE", standard: "Official Annuaire Schematron", version: "not published in DGFiP v3.2 archive", issueCount: 0 },
  ];
  return { flow, stages, issues: [...xsd, ...business] };
}

function validatePeriods(value: unknown, flow: AnnuaireFlow, output: ValidationIssue[], path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validatePeriods(child, flow, output, `${path}[${index + 1}]`));
    return;
  }
  const object = record(value);
  if (!Object.keys(object).length) return;
  const start = parseDate(text(object.DateDebut));
  const end = parseDate(text(object.DateFin));
  if (text(object.DateDebut) && !start) output.push(issue(flow, "G1.09/G1.36", "DateDebut must be a valid AAAAMMJJ date between years 2000 and 2099.", `${path}/DateDebut`));
  if (text(object.DateFin) && !end) output.push(issue(flow, "G1.09/G1.36", "DateFin must be a valid AAAAMMJJ date between years 2000 and 2099.", `${path}/DateFin`));
  if (start && end && end <= start) output.push(issue(flow, "G1.113", "DateFin must be later than DateDebut.", path));
  for (const [key, child] of Object.entries(object)) {
    if (key === "DateDebut" || key === "DateFin" || key.startsWith("@_")) continue;
    validatePeriods(child, flow, output, `${path}/${key}`);
  }
}

function issue(flow: AnnuaireFlow, rule: string, message: string, path: string): ValidationIssue {
  return { code: `F${flow}-${rule.replace(/[^A-Za-z0-9.]+/g, "-")}`, severity: "error", source: "business", rule, message, path, standard: "DGFiP Annex 7 management rules", standardVersion: "1.9" };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return String(record(value)["#text"] ?? "").trim();
}

function parseDate(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 2000 || year > 2099) return null;
  const result = new Date(Date.UTC(year, month - 1, day));
  return result.getUTCFullYear() === year && result.getUTCMonth() === month - 1 && result.getUTCDate() === day ? result : null;
}

function isError(value: ValidationIssue): boolean {
  return value.severity === "error";
}
