import { describe, expect, it } from "vitest";
import { validateAnnuaire } from "../src/annuaire";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "../src/crypto";
import { detectEReportingFlow, validateEReporting } from "../src/e-reporting";
import { resolveSandboxDirectory } from "../src/directory-resolution";
import { classifyCbmUseCase, preflightCanonicalTransaction } from "../src/cbm-preflight";
import { REGULATORY_FLOWS, regulatoryCoverage } from "../src/regulatory-coverage";
import { buildDispatchPlan } from "../src/routing-plan";
import { assertTransition, canTransition, nextInvoiceStates, REGULATORY_CODES } from "../src/lifecycle";
import { extractFlux1, simulatePpf } from "../src/flux1";
import { emscriptenCallbackModuleKey, validateFormalInvoice } from "../src/formal-validation";
import { baselineNotices, detectInvoiceFormat, validateTransport, validateXmlStructure } from "../src/validation";

const validUbl = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>INV-1</ID></Invoice>`;
const validCii = `<?xml version="1.0"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"></rsm:CrossIndustryInvoice>`;

describe("document detection and transport validation", () => {
  it("detects a UBL invoice", () => expect(detectInvoiceFormat("application/xml", validUbl)).toBe("UBL"));
  it("detects a CII invoice", () => expect(detectInvoiceFormat("application/xml", validCii)).toBe("CII"));
  it("rejects an unknown XML format", () => expect(validateXmlStructure("<unknown/>", "UNKNOWN")[0]?.code).toBe("UNSUPPORTED_INVOICE_FORMAT"));
  it("rejects an empty body", () => expect(validateTransport("application/xml", "")[0]?.code).toBe("EMPTY_DOCUMENT"));
  it("rejects a non-XML media type on the legacy route", () => expect(validateTransport("application/json", "{}").some((issue) => issue.code === "UNSUPPORTED_MEDIA_TYPE")).toBe(true));
  it("rejects DTD and entity declarations", () => expect(validateXmlStructure("<!DOCTYPE x [<!ENTITY y 'z'>]><x>&y;</x>", "UNKNOWN").some((issue) => issue.code === "XML_DTD_FORBIDDEN")).toBe(true));
  it("does not overstate formal regulatory validation", () => expect(baselineNotices("UBL")[0]?.code).toBe("FORMAL_RULESET_PENDING"));
});

describe("formal France validation and Flux 1", () => {
  const routedUbl = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cbc:ID>INV-1</cbc:ID><cbc:IssueDate>2026-09-23</cbc:IssueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="0225">FR123456789</cbc:EndpointID><cac:PartyLegalEntity><cbc:RegistrationName>Buyer</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty></Invoice>`;

  it("executes the official DGFiP XSD and both Schematron stages", async () => {
    const report = await validateFormalInvoice(routedUbl, "UBL");
    expect(report.stages.map((stage) => stage.id)).toEqual(["xml", "xsd", "en16931", "schematron"]);
    expect(report.issues.some((issue) => issue.code.endsWith("ENGINE-ERROR"))).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("selects precompiled Worker callback modules from the Emscripten signature byte", () => {
    const vii = new Uint8Array(35);
    vii[13] = 130;
    const ii = new Uint8Array(35);
    ii[13] = 129;
    const iiii = new Uint8Array(37);
    iiii[13] = 131;
    expect([vii, ii, iiii].map(emscriptenCallbackModuleKey)).toEqual(["35:130", "35:129", "37:131"]);
  });

  it("extracts BT-49 for the PPF simulation without inventing it", () => {
    const flux1 = extractFlux1(routedUbl);
    expect(flux1.fields["BT-49"]).toEqual({ scheme: "0225", value: "FR123456789" });
    expect(simulatePpf(flux1, false).status).toBe("ACCEPTED");
    const withoutBt49 = extractFlux1(validUbl);
    expect(simulatePpf(withoutBt49, false).issues[0]?.code).toBe("PPF_SIM_BT49_REQUIRED");
  });
});

describe("official DGFiP e-reporting and Annuaire controls", () => {
  const flux103 = `<?xml version="1.0"?><Report><ReportDocument><Id>D2F-ER-20260922</Id><IssueDateTime><DateTimeString>20260923090000</DateTimeString></IssueDateTime><TypeCode>IN</TypeCode><Sender><Id schemeId="0238">1234</Id><Name>D2F PA Sandbox</Name><RoleCode>WK</RoleCode></Sender><Issuer><Id schemeId="0002">123456789</Id><Name>Sandbox issuer</Name><RoleCode>SE</RoleCode></Issuer></ReportDocument><TransactionsReport><ReportPeriod><StartDate>20260901</StartDate><EndDate>20260922</EndDate></ReportPeriod><Transactions><Date>20260922</Date><TransactionsCurrency>EUR</TransactionsCurrency><CategoryCode>TLB1</CategoryCode><TaxExclusiveAmount>100.00</TaxExclusiveAmount><TaxTotal>20.00</TaxTotal><TransactionsCount>1</TransactionsCount><TaxSubtotal><TaxPercent>20</TaxPercent><TaxableAmount>100.00</TaxableAmount><TaxTotal>20.00</TaxTotal></TaxSubtotal></Transactions></TransactionsReport></Report>`;

  it("classifies Flux 10.3 and executes the official XSD plus Annex 7 controls", async () => {
    const result = await validateEReporting(flux103, new Date("2026-09-23T12:00:00Z"));
    expect(result.flow).toBe("10.3");
    expect(result.stages.find((stage) => stage.id === "xsd")?.status).toBe("PASS");
    expect(result.stages.find((stage) => stage.id === "business-rules")?.status).toBe("PASS");
    expect(result.stages.find((stage) => stage.id === "schematron")?.status).toBe("NOT_APPLICABLE");
    expect(result.issues.some((issue) => issue.code.endsWith("ENGINE-ERROR"))).toBe(false);
  });

  it("distinguishes all four Flux 10 payload shapes", () => {
    expect(detectEReportingFlow({ TransactionsReport: { Invoice: {} } })).toBe("10.1");
    expect(detectEReportingFlow({ PaymentsReport: { Invoice: {} } })).toBe("10.2");
    expect(detectEReportingFlow({ TransactionsReport: { Transactions: {} } })).toBe("10.3");
    expect(detectEReportingFlow({ PaymentsReport: { Transactions: {} } })).toBe("10.4");
  });

  it("rejects a mixed transaction and payment transmission under G6.29", async () => {
    const mixed = flux103.replace("</Report>", "<PaymentsReport><ReportPeriod><StartDate>20260901</StartDate><EndDate>20260922</EndDate></ReportPeriod><Transactions><Payment><Date>20260922</Date><SubTotals><TaxPercent>20</TaxPercent><CurrencyCode>EUR</CurrencyCode><Amount>120</Amount></SubTotals></Payment></Transactions></PaymentsReport></Report>");
    const result = await validateEReporting(mixed, new Date("2026-09-23T12:00:00Z"));
    expect(result.flow).toBe("UNKNOWN");
    expect(result.issues.some((issue) => issue.rule === "G6.29")).toBe(true);
  });

  it("runs the official Annuaire Flux 12 schema without an engine failure", async () => {
    const result = await validateAnnuaire("<AnnuaireActualisation><BlocCodesRoutage/></AnnuaireActualisation>", "12");
    expect(result.stages.map((stage) => stage.id)).toEqual(["xml", "xsd", "business-rules", "schematron"]);
    expect(result.issues.some((issue) => issue.code.endsWith("ENGINE-ERROR"))).toBe(false);
  });
});

describe("PPF directory sandbox resolution", () => {
  const base = { id: "dir-1", siren: "123456789", siret: "12345678900012", electronicAddress: "FR12345678900012", receptionPa: "PA-D2F-SANDBOX", activeFrom: "2026-01-01", activeTo: null, metadata: { electronicAddressScheme: "0225", sourceReference: "FLUX13-TEST-42", directoryVersion: "2026-09-24", synchronizedAt: "2026-09-24T09:00:00Z" } };

  it("resolves an active SIRET before SIREN and returns source evidence", () => {
    const result = resolveSandboxDirectory([base], { siren: "123456789", siret: "12345678900012" }, "2026-09-24");
    expect(result.status).toBe("RESOLVED");
    expect(result.matchedBy).toBe("SIRET");
    expect(result.electronicAddress).toEqual({ scheme: "0225", value: "FR12345678900012" });
    expect(result.sourceReference).toBe("FLUX13-TEST-42");
  });

  it("never invents an address for an unknown recipient", () => {
    const result = resolveSandboxDirectory([], { siren: "987654321" }, "2026-09-24");
    expect(result.status).toBe("NOT_FOUND");
    expect(result.electronicAddress).toBeNull();
    expect(result.issues[0]?.code).toBe("D2F_DIRECTORY_NOT_FOUND");
  });

  it("blocks different active routes instead of selecting one arbitrarily", () => {
    const result = resolveSandboxDirectory([base, { ...base, id: "dir-2", electronicAddress: "FRDIFFERENT" }], { siren: "123456789" }, "2026-09-24");
    expect(result.status).toBe("AMBIGUOUS");
    expect(result.electronicAddress).toBeNull();
  });
});

describe("regulatory flow coverage and CBM preflight", () => {
  const canonical = {
    type: "INVOICE", externalId: "ERP-42", source: { system: "ORACLE" },
    seller: { name: "D2F", country: "FR", identifiers: [{ scheme: "SIREN", value: "123456789" }] },
    buyer: { name: "Client", country: "FR", identifiers: [{ scheme: "SIRET", value: "98765432100012" }] },
    document: { number: "F-42", issueDate: "2026-09-24", currency: "EUR" }, lines: [{ description: "Service" }],
  };

  it("declares every reform flow including conditional Flux 7 without claiming unsupported parity", () => {
    expect(REGULATORY_FLOWS.map((item) => item.flow)).toEqual(expect.arrayContaining(["1", "2", "3", "6", "7", "8", "9", "10.1", "10.2", "10.3", "10.4", "11", "12", "13", "14"]));
    expect(REGULATORY_FLOWS.find((item) => item.flow === "7")?.status).toBe("BLOCKED_OFFICIAL_ARTIFACT");
    expect(regulatoryCoverage("0.5.0", "3.2").productionParityClaim).toBe(false);
  });

  it("classifies domestic B2B and assigns missing BT-49 resolution to the PA", () => {
    expect(classifyCbmUseCase(canonical)).toBe("FR_DOMESTIC_B2B");
    const report = preflightCanonicalTransaction(canonical);
    expect(report.accepted).toBe(true);
    expect(report.issues.find((item) => item.code === "FR_ROUTING_PA_RESOLUTION_PENDING")?.severity).toBe("information");
    expect(report.nextActions.find((item) => item.code === "FR_ROUTING_PA_RESOLUTION_PENDING")?.owner).toBe("PA");
  });

  it("returns exact source-owned omissions", () => {
    const report = preflightCanonicalTransaction({ type: "INVOICE" });
    expect(report.accepted).toBe(false);
    expect(report.issues.map((item) => item.code)).toContain("CBM_SOURCE_SYSTEM_REQUIRED");
    expect(report.issues.map((item) => item.code)).toContain("CBM_LINE_REQUIRED");
  });

  it("selects Flux 2 for a domestic UBL and keeps dispatch blocked until PA interop is proven", () => {
    const plan = buildDispatchPlan({ ...canonical, document: { ...canonical.document, syntax: "UBL" }, routing: { electronicAddress: { scheme: "0225", value: "FR98765432100012" }, receiverPa: "PA-RECEIVER" } }, "FR_DOMESTIC_B2B");
    expect(plan.invoiceFlow).toBe("2");
    expect(plan.reportingFlows).toEqual(["1"]);
    expect(plan.lifecycleFlows).toEqual(["6"]);
    expect(plan.route).toMatchObject({ sender: "SOURCE_SI", senderPa: "D2F_PA_SANDBOX", receiverPa: "PA-RECEIVER" });
    expect(plan.dispatchable).toBe(false);
    expect(plan.sandboxExecutable).toBe(true);
    expect(plan.productionReady).toBe(false);
    expect(plan.sandboxSimulation).toEqual({ receiverPa: true, ppf: true, directory: true, externalNetworkCalled: false });
    expect(plan.blockers.map((item) => item.code)).toContain("FLOW_2_NOT_OPERATIONAL");
  });

  it("never selects Flux 3 without a bilateral versioned profile", () => {
    const blocked = buildDispatchPlan({ ...canonical, document: { ...canonical.document, syntax: "EDIFACT" } }, "FR_DOMESTIC_B2B");
    expect(blocked.invoiceFlow).toBe("3");
    expect(blocked.blockers.map((item) => item.code)).toContain("FLUX3_BILATERAL_PROFILE_REQUIRED");
    const agreed = buildDispatchPlan({ ...canonical, document: { ...canonical.document, syntax: "EDIFACT" }, routing: { customProfile: { bilateralAgreement: true, profileId: "GALIA-INVOIC", profileVersion: "D96A" } } }, "FR_DOMESTIC_B2B");
    expect(agreed.blockers.map((item) => item.code)).not.toContain("FLUX3_BILATERAL_PROFILE_REQUIRED");
    expect(agreed.blockers.map((item) => item.code)).toContain("FLOW_3_NOT_OPERATIONAL");
  });
});

describe("lifecycle state machine", () => {
  it("allows the nominal route and delivery transition", () => {
    expect(canTransition("RECEIVED", "ROUTED")).toBe(true);
    expect(canTransition("ROUTED", "DELIVERED")).toBe(true);
  });
  it("rejects an out-of-order paid status", () => expect(() => assertTransition("RECEIVED", "PAID")).toThrow(/OUT_OF_ORDER_LIFECYCLE/));
  it("maps paid to French lifecycle code 212", () => expect(REGULATORY_CODES.PAID).toBe("212"));
  it("exposes only the next legal sandbox states", () => {
    expect(nextInvoiceStates("ROUTED")).toEqual(["DELIVERED"]);
    expect(nextInvoiceStates("APPROVED")).toEqual(["PROCESSING", "PAID"]);
    expect(nextInvoiceStates("PAID")).toEqual([]);
  });
});

describe("security primitives", () => {
  it("hashes deterministically", async () => expect(await sha256Hex("same")).toBe(await sha256Hex("same")));
  it("compares credentials without early length rejection", () => {
    expect(constantTimeEqual("d2f_sbx_value", "d2f_sbx_value")).toBe(true);
    expect(constantTimeEqual("d2f_sbx_value", "d2f_sbx_other")).toBe(false);
  });
  it("signs the exact raw bytes for Business Suite callbacks", async () => {
    const signature = await hmacSha256Hex("secret", new TextEncoder().encode("<Invoice/>"));
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });
});
