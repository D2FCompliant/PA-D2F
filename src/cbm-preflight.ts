import type { ValidationIssue } from "./types";
import { buildDispatchPlan } from "./routing-plan";

type Cbm = Record<string, unknown>;

export type CbmUseCase = "FR_DOMESTIC_B2B" | "FR_DOMESTIC_B2G" | "FR_B2C" | "FR_CROSS_BORDER" | "UNDETERMINED";

function object(value: unknown): Cbm {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Cbm : {};
}

function text(value: unknown): string { return String(value ?? "").trim(); }

function issue(code: string, message: string, path: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue {
  return { code, severity, source: "business", rule: code, message, path, standard: "d2f.cbm.v2", standardVersion: "2.1.0" };
}

function country(party: Cbm): string {
  return text(party.country || object(party.address).countryCode || object(party.postalAddress).countryCode).toUpperCase();
}

function hasIdentifier(party: Cbm, schemes: string[]): boolean {
  const direct = schemes.some((scheme) => text(party[scheme.toLowerCase()] || party[scheme]));
  const identifiers = Array.isArray(party.identifiers) ? party.identifiers : [];
  return direct || identifiers.some((entry) => schemes.includes(text(object(entry).scheme).toUpperCase()) && text(object(entry).value));
}

export function classifyCbmUseCase(body: Cbm): CbmUseCase {
  const seller = object(body.seller);
  const buyer = object(body.buyer);
  const sellerCountry = country(seller);
  const buyerCountry = country(buyer);
  if (!sellerCountry || !buyerCountry) return "UNDETERMINED";
  if (sellerCountry === "FR" && buyerCountry === "FR") {
    if (text(buyer.entityType).toUpperCase() === "PUBLIC" || hasIdentifier(buyer, ["SIRET_PUBLIC", "CHORUS_PRO"])) return "FR_DOMESTIC_B2G";
    if (text(buyer.entityType).toUpperCase() === "CONSUMER" || buyer.isConsumer === true) return "FR_B2C";
    return "FR_DOMESTIC_B2B";
  }
  if (sellerCountry === "FR" || buyerCountry === "FR") return "FR_CROSS_BORDER";
  return "UNDETERMINED";
}

export function preflightCanonicalTransaction(body: Cbm) {
  const issues: ValidationIssue[] = [];
  if (body.type !== "INVOICE") issues.push(issue("CBM_TYPE_UNSUPPORTED", "Only canonical INVOICE transactions are accepted.", "/type"));
  if (!text(body.externalId)) issues.push(issue("CBM_EXTERNAL_ID_REQUIRED", "externalId is required for idempotent source traceability.", "/externalId"));
  if (!text(object(body.source).system)) issues.push(issue("CBM_SOURCE_SYSTEM_REQUIRED", "source.system is required.", "/source/system"));
  const seller = object(body.seller);
  const buyer = object(body.buyer);
  if (!text(seller.name)) issues.push(issue("CBM_SELLER_NAME_REQUIRED", "seller.name is required.", "/seller/name"));
  if (!text(buyer.name)) issues.push(issue("CBM_BUYER_NAME_REQUIRED", "buyer.name is required.", "/buyer/name"));
  if (!country(seller)) issues.push(issue("CBM_SELLER_COUNTRY_REQUIRED", "The seller country is required for regulatory classification.", "/seller/address/countryCode"));
  if (!country(buyer)) issues.push(issue("CBM_BUYER_COUNTRY_REQUIRED", "The buyer country is required for regulatory classification.", "/buyer/address/countryCode"));
  const document = object(body.document);
  if (!text(document.number || body.invoiceNumber)) issues.push(issue("CBM_INVOICE_NUMBER_REQUIRED", "The invoice number is required.", "/document/number"));
  if (!text(document.issueDate || body.issueDate)) issues.push(issue("CBM_ISSUE_DATE_REQUIRED", "The invoice issue date is required.", "/document/issueDate"));
  if (!text(document.currency || body.currency)) issues.push(issue("CBM_CURRENCY_REQUIRED", "The invoice currency is required.", "/document/currency"));
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) issues.push(issue("CBM_LINE_REQUIRED", "At least one invoice line is required.", "/lines"));

  const useCase = classifyCbmUseCase(body);
  if (useCase === "FR_DOMESTIC_B2B" && !hasIdentifier(seller, ["SIREN", "SIRET", "VAT"])) issues.push(issue("FR_SELLER_IDENTIFIER_REQUIRED", "A French seller SIREN, SIRET or VAT identifier is required.", "/seller/identifiers"));
  if (useCase === "FR_DOMESTIC_B2B" && !hasIdentifier(buyer, ["SIREN", "SIRET", "VAT"])) issues.push(issue("FR_BUYER_IDENTIFIER_REQUIRED", "A French buyer SIREN, SIRET or VAT identifier is required for directory resolution.", "/buyer/identifiers"));
  const routing = object(body.routing);
  const electronicAddress = object(routing.electronicAddress);
  if (useCase === "FR_DOMESTIC_B2B" && !text(electronicAddress.value)) {
    issues.push({ ...issue("FR_ROUTING_PA_RESOLUTION_PENDING", "BT-49 is not supplied by the source: the PA must resolve it from the PPF directory mirror before transmission.", "/routing/electronicAddress", "information"), source: "routing", rule: "BT-49", standard: "DGFiP/AIFE + AFNOR", standardVersion: "3.2 / applicable XP" });
  }
  const blocking = issues.filter((item) => item.severity === "error");
  const dispatchPlan = buildDispatchPlan(body, useCase);
  return {
    accepted: blocking.length === 0,
    useCase,
    issues,
    phases: [
      { id: "cbm-contract", status: blocking.some((item) => item.code.startsWith("CBM_")) ? "FAIL" : "PASS" },
      { id: "regulatory-classification", status: useCase === "UNDETERMINED" ? "FAIL" : "PASS" },
      { id: "routing", status: issues.some((item) => item.code === "FR_ROUTING_PA_RESOLUTION_PENDING") ? "WAITING_PA" : "PASS" },
    ],
    nextActions: issues.map((item) => ({ code: item.code, owner: item.code === "FR_ROUTING_PA_RESOLUTION_PENDING" ? "PA" : "SOURCE_APPLICATION", path: item.path })),
    dispatchPlan,
  };
}
