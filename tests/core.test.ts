import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { validateAnnuaire } from "../src/annuaire";
import { constantTimeEqual, hmacSha256Hex, sha256Hex } from "../src/crypto";
import { detectEReportingFlow, validateEReporting } from "../src/e-reporting";
import { generateEReportingDocuments } from "../src/e-reporting-ingest";
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
  const compliantFranceUbl = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID><cbc:ProfileID>B1</cbc:ProfileID><cbc:ID>F2026-TEST</cbc:ID><cbc:IssueDate>2026-09-25</cbc:IssueDate><cbc:DueDate>2026-10-25</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
<cbc:Note>#PMT#Indemnité forfaitaire pour frais de recouvrement : 40 EUR.</cbc:Note><cbc:Note>#PMD#Pénalités de retard exigibles au taux légal en vigueur.</cbc:Note><cbc:Note>#AAB#Aucun escompte pour paiement anticipé.</cbc:Note><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0225">987654321</cbc:EndpointID><cac:PartyIdentification><cbc:ID schemeID="0002">987654321</cbc:ID></cac:PartyIdentification><cac:PartyIdentification><cbc:ID schemeID="0009">98765432100019</cbc:ID></cac:PartyIdentification><cac:PostalAddress><cbc:StreetName>1 rue D2F</cbc:StreetName><cbc:CityName>Paris</cbc:CityName><cbc:PostalZone>75001</cbc:PostalZone><cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>FR00123456789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>D2F Seller</cbc:RegistrationName><cbc:CompanyID schemeID="0002">987654321</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="0225">123456789</cbc:EndpointID><cac:PartyIdentification><cbc:ID schemeID="0002">123456789</cbc:ID></cac:PartyIdentification><cac:PostalAddress><cbc:StreetName>2 rue Client</cbc:StreetName><cbc:CityName>Paris</cbc:CityName><cbc:PostalZone>75002</cbc:PostalZone><cac:Country><cbc:IdentificationCode>FR</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>Client</cbc:RegistrationName><cbc:CompanyID schemeID="0002">123456789</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cac:PayeeFinancialAccount><cbc:ID>FR1420041010050500013M02606</cbc:ID></cac:PayeeFinancialAccount></cac:PaymentMeans><cac:PaymentTerms><cbc:Note>30 jours</cbc:Note></cac:PaymentTerms>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">20.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">20.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">120.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">120.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Service</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>20.00</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine></Invoice>`;

  it("executes the official DGFiP XSD and both Schematron stages", async () => {
    const report = await validateFormalInvoice(routedUbl, "UBL");
    expect(report.stages.map((stage) => stage.id)).toEqual(["xml", "xsd", "en16931", "schematron"]);
    expect(report.issues.some((issue) => issue.code.endsWith("ENGINE-ERROR"))).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it("accepts a complete France Flux 2 against OASIS UBL, EN 16931 and FNFE controls", async () => {
    const report = await validateFormalInvoice(compliantFranceUbl, "UBL");
    expect(report.stages.every((stage) => stage.status === "PASS")).toBe(true);
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
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

  it("keeps canonical source ingestion at the PA boundary and aggregates B2C records into Flux 10.3", async () => {
    const canonical = {
      type: "DOCUMENT",
      externalId: "FR-REPORT-20260910",
      document: {
        kind: "REGULATORY_REPORTING_BATCH",
        number: "FR-REPORT-20260910",
        payload: {
          schema: "D2F_REGULATORY_BATCH_V1",
          profile: "FR_PA",
          company: { legal_name: "D2F Test", siren: "123456789" },
          period: { start: "2026-09-01", end: "2026-09-10" },
          obligations: [{ id: "fr_b2c_transactions_10_3", candidate_ids: ["inv-1", "inv-2"] }],
          records: {
            invoices: [
              { id: "inv-1", number: "F1", date: "2026-09-09", customer_type: "B2C", customer_country: "FR", currency: "EUR", operation_category: "goods", total_ht: 100, total_tva: 20, total_ttc: 120, tax_breakdown: [{ rate: 20, taxable_amount: 100, tax_amount: 20 }] },
              { id: "inv-2", number: "F2", date: "2026-09-09", customer_type: "B2C", customer_country: "FR", currency: "EUR", operation_category: "goods", total_ht: 50, total_tva: 10, total_ttc: 60, tax_breakdown: [{ rate: 20, taxable_amount: 50, tax_amount: 10 }] },
            ],
            payments: [],
          },
        },
      },
    };
    const documents = generateEReportingDocuments(canonical);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.flow).toBe("10.3");
    expect(documents[0]?.xml).toContain("<TransactionsCount>2</TransactionsCount>");
    expect(documents[0]?.xml).toContain("<TaxExclusiveAmount>150.00</TaxExclusiveAmount>");
    const validation = await validateEReporting(documents[0]!.xml, new Date("2026-09-26T12:00:00Z"));
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("generates PA-owned Flux 10.2 and 10.4 from collected-payment source records", async () => {
    const canonical = {
      type: "DOCUMENT",
      externalId: "FR-PAY-20260910",
      document: {
        kind: "REGULATORY_REPORTING_BATCH",
        number: "FR-PAY-20260910",
        payload: {
          schema: "D2F_REGULATORY_BATCH_V1",
          profile: "FR_PA",
          company: { legal_name: "D2F Test", siren: "123456789" },
          period: { start: "2026-09-01", end: "2026-09-10" },
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
    const documents = generateEReportingDocuments(canonical);
    expect(documents.map((item) => item.flow)).toEqual(["10.2", "10.4"]);
    for (const document of documents) {
      const validation = await validateEReporting(document.xml, new Date("2026-09-26T12:00:00Z"));
      expect(validation.issues.filter((issue) => issue.severity === "error"), document.flow).toEqual([]);
    }
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

describe("tenant and company scoped sandbox directory API", () => {
  it("publishes the Platform directory registration and resolution contracts", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const repository = await readFile(new URL("../src/repository.ts", import.meta.url), "utf8");
    expect(source).toContain('url.pathname === "/sandbox/v1/directory/entries"');
    expect(source).toContain('url.pathname === "/sandbox/v1/directory/resolve"');
    expect(source).toContain("tenantId: auth.tenantId, connectionId: auth.connectionId");
    expect(source).toContain('item.scheme === "SIREN"');
    expect(source).toContain('item.scheme === "SIRET"');
    expect(repository).toContain("tenant_id = ? AND connection_id = ?");
  });
});
