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
