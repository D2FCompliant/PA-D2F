import { XMLParser } from "fast-xml-parser";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function local(record: JsonObject, name: string): unknown {
  const entry = Object.entries(record).find(([key]) => key.split(":").at(-1) === name);
  return entry?.[1];
}

function child(value: unknown, ...path: string[]): unknown {
  return path.reduce((current, name) => local(object(Array.isArray(current) ? current[0] : current), name), value);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).trim() || null;
  const record = object(Array.isArray(value) ? value[0] : value);
  return text(record["#text"]);
}

function scheme(value: unknown) {
  const record = object(Array.isArray(value) ? value[0] : value);
  return String(record["@_schemeID"] || "").trim() || null;
}

export function extractFlux1(payload: string) {
  const parsed = object(new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true }).parse(payload));
  const rootEntry = Object.entries(parsed).find(([key]) => ["Invoice", "CreditNote"].includes(key.split(":").at(-1) || ""));
  const root = object(rootEntry?.[1]);
  const sellerParty = child(root, "AccountingSupplierParty", "Party");
  const buyerParty = child(root, "AccountingCustomerParty", "Party");
  const sellerEndpoint = child(sellerParty, "EndpointID");
  const buyerEndpoint = child(buyerParty, "EndpointID");
  const monetary = child(root, "LegalMonetaryTotal");
  const tax = child(root, "TaxTotal", "TaxAmount");
  return {
    standard: "DGFiP Flux 1",
    version: "1.2",
    syntax: "UBL",
    fields: {
      "BT-1": text(child(root, "ID")),
      "BT-2": text(child(root, "IssueDate")),
      "BT-3": text(child(root, "InvoiceTypeCode")),
      "BT-5": text(child(root, "DocumentCurrencyCode")),
      "BT-34": { scheme: scheme(sellerEndpoint), value: text(sellerEndpoint) },
      "BT-49": { scheme: scheme(buyerEndpoint), value: text(buyerEndpoint) },
      "BT-27": text(child(sellerParty, "PartyLegalEntity", "RegistrationName")) || text(child(sellerParty, "PartyName", "Name")),
      "BT-44": text(child(buyerParty, "PartyLegalEntity", "RegistrationName")) || text(child(buyerParty, "PartyName", "Name")),
      "BT-106": text(child(monetary, "LineExtensionAmount")),
      "BT-109": text(child(monetary, "TaxExclusiveAmount")),
      "BT-110": text(tax),
      "BT-112": text(child(monetary, "TaxInclusiveAmount")),
      "BT-115": text(child(monetary, "PayableAmount")),
    },
    source: "20260430_Annexe-1-Flux-1-v1.2.xlsx",
  };
}

export function simulateDirectoryRouting(flux1: ReturnType<typeof extractFlux1>, hasErrors: boolean) {
  const bt49 = object(flux1.fields["BT-49"]);
  const address = String(bt49.value || "").trim();
  const issues = address ? [] : [{ code: "DIRECTORY_SIM_BT49_REQUIRED", severity: "error", source: "routing", rule: "BT-49", message: "Simulated PA routing requires a resolved buyer electronic address (BT-49).", path: "/Invoice/AccountingCustomerParty/Party/EndpointID" }];
  return {
    mode: "SIMULATION",
    role: "DIRECTORY_AND_PA_ROUTING",
    invoiceRoutedThroughPpf: false,
    externalNetworkCalled: false,
    status: hasErrors || issues.length ? "REJECTED" : "ACCEPTED",
    route: address ? { scheme: bt49.scheme || null, electronicAddress: address } : null,
    issues,
  };
}
