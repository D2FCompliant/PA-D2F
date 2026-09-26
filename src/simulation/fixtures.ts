export const SYNTHETIC_SELLER_ID = "TEST-FR-SELLER-001" as const;
export const SYNTHETIC_BUYER_ID = "TEST-FR-BUYER-001" as const;

export function canonicalHappyPathFixture(): Record<string, unknown> {
  return {
    type: "INVOICE",
    externalId: "DEMO-FR-PIPELINE-001-INVOICE",
    source: { system: "D2F_PA_SANDBOX", entity: "synthetic-fixture", recordId: "DEMO-FR-PIPELINE-001", synthetic: true },
    context: { jurisdictions: ["FR"], sellerCountry: "FR", buyerCountry: "FR", placeOfSupplyCountry: "FR" },
    seller: {
      organizationId: SYNTHETIC_SELLER_ID,
      legalName: "Synthetic Test Seller",
      identifiers: [{ scheme: "SIREN", value: "987654321", synthetic: true }],
      address: { street: "1 rue de Test", postalCode: "75001", city: "Paris", countryCode: "FR" },
      provenance: "USER_INPUT",
      synthetic: true,
    },
    buyer: {
      organizationId: SYNTHETIC_BUYER_ID,
      legalName: "Synthetic Test Buyer",
      customerType: "B2B",
      identifiers: [{ scheme: "SIREN", value: "123456789", synthetic: true }],
      address: { street: "2 rue de Test", postalCode: "75002", city: "Paris", countryCode: "FR" },
      provenance: "USER_INPUT",
      synthetic: true,
    },
    routing: { electronicAddress: { scheme: "0225", value: SYNTHETIC_BUYER_ID, provenance: "DIRECTORY_SIMULATED" } },
    document: {
      invoice: {
        number: "DEMO-FR-PIPELINE-001",
        issueDate: "2026-09-26",
        dueDate: "2026-10-26",
        currency: "EUR",
        billingMode: "B1",
        operationCategory: "SERVICES",
        monetaryTotals: { netAmount: 100, taxAmount: 20, grossAmount: 120, amountDue: 120 },
        paymentMeans: { code: "30", accountId: "FR1420041010050500013M02606" },
        legalNotices: {
          recoveryCosts: "Synthetic fixture — recovery costs notice",
          latePayment: "Synthetic fixture — late-payment notice",
          earlyPaymentDiscount: "Synthetic fixture — no early-payment discount",
        },
        lines: [{ description: "Synthetic compliance service", quantity: 1, unitPrice: 100, taxRate: 20, taxCategory: "S" }],
      },
    },
    metadata: { syntheticTestEntity: true, fixture: "DEMO-FR-PIPELINE-001", provenance: "USER_INPUT" },
  };
}

export function assertSyntheticFixture(value: Record<string, unknown>): void {
  const serialized = JSON.stringify(value).toLowerCase();
  if (!serialized.includes("synthetic") || serialized.includes("d2f compliant d.o.o")) {
    throw new Error("NON_SYNTHETIC_FIXTURE_FORBIDDEN");
  }
}

export function crossBorderEReportingFixture(): Record<string, unknown> {
  return regulatoryReportingBatch({
    externalId: "DEMO-FR-FOREIGN-REPORT-001",
    number: "DEMO-FR-FOREIGN-REPORT-001",
    obligation: "fr_transaction_data_10_1",
    recordId: "cross-border-invoice-001",
    invoice: {
      id: "cross-border-invoice-001",
      number: "FR-DE-2026-001",
      date: "2026-09-24",
      due_date: "2026-10-24",
      type: "invoice",
      customer_type: "B2B",
      customer_country: "DE",
      buyer_identifier_scheme: "VAT",
      buyer_identifier: "DE123456789",
      currency: "EUR",
      billing_mode: "B1",
      operation_category: "services",
      total_ht: 100,
      total_tva: 20,
      total_ttc: 120,
      tax_breakdown: [{ rate: 20, taxable_amount: 100, tax_amount: 20 }],
    },
  });
}

export function b2cEReportingFixture(): Record<string, unknown> {
  return regulatoryReportingBatch({
    externalId: "DEMO-FR-B2C-REPORT-001",
    number: "DEMO-FR-B2C-REPORT-001",
    obligation: "fr_b2c_transactions_10_3",
    recordId: "b2c-invoice-001",
    invoice: {
      id: "b2c-invoice-001",
      number: "FR-B2C-2026-001",
      date: "2026-09-24",
      customer_type: "B2C",
      customer_country: "FR",
      currency: "EUR",
      operation_category: "goods",
      total_ht: 50,
      total_tva: 10,
      total_ttc: 60,
      tax_breakdown: [{ rate: 20, taxable_amount: 50, tax_amount: 10 }],
    },
  });
}

function regulatoryReportingBatch(input: {
  externalId: string;
  number: string;
  obligation: "fr_transaction_data_10_1" | "fr_b2c_transactions_10_3";
  recordId: string;
  invoice: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: "DOCUMENT",
    externalId: input.externalId,
    source: { system: "D2F_PA_SANDBOX", entity: "synthetic-fixture", recordId: input.recordId, synthetic: true },
    document: {
      kind: "REGULATORY_REPORTING_BATCH",
      number: input.number,
      payload: {
        schema: "D2F_REGULATORY_BATCH_V1",
        profile: "FR_PA",
        classificationSource: "EXPLICIT_SYNTHETIC_SCENARIO",
        company: { legal_name: "Synthetic French Seller", siren: "987654321", synthetic: true },
        period: { start: "2026-09-01", end: "2026-09-25" },
        obligations: [{ id: input.obligation, candidate_ids: [input.recordId] }],
        records: { invoices: [input.invoice], payments: [] },
      },
    },
    metadata: { syntheticTestEntity: true, fixture: input.externalId, provenance: "USER_INPUT" },
  };
}
