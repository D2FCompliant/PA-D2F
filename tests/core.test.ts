import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../src/crypto";
import { canTransition, REGULATORY_CODES } from "../src/lifecycle";
import { detectInvoiceFormat, validateTransport, validateXmlStructure } from "../src/validation";

describe("invoice format detection", () => {
  it("detects UBL invoices", () => expect(detectInvoiceFormat("application/xml", '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>')).toBe("UBL"));
  it("detects UBL credit notes", () => expect(detectInvoiceFormat("application/xml", "<CreditNote/>")).toBe("UBL"));
  it("detects CII", () => expect(detectInvoiceFormat("application/xml", "<rsm:CrossIndustryInvoice/>")).toBe("CII"));
  it("rejects unknown XML", () => expect(detectInvoiceFormat("application/xml", "<foo/>")).toBe("UNKNOWN"));
});

describe("transport and XML safety", () => {
  it("accepts XML media types", () => expect(validateTransport("application/xml", "<Invoice/>")).toEqual([]));
  it("rejects empty bodies", () => expect(validateTransport("application/xml", "")[0]?.code).toBe("EMPTY_DOCUMENT"));
  it("rejects non XML media types", () => expect(validateTransport("application/json", "{}")[0]?.code).toBe("UNSUPPORTED_MEDIA_TYPE"));
  it("forbids DTD declarations", () => expect(validateXmlStructure("<!DOCTYPE x><Invoice/>", "UBL")[0]?.code).toBe("XML_DTD_FORBIDDEN"));
});

describe("lifecycle", () => {
  it("allows the nominal route", () => expect(canTransition("RECEIVED", "ROUTED")).toBe(true));
  it("blocks out-of-order payment", () => expect(canTransition("RECEIVED", "PAID")).toBe(false));
  it("maps collection to French code 212", () => expect(REGULATORY_CODES.PAID).toBe("212"));
});

describe("constant-time comparison", () => {
  it("accepts equal values", () => expect(timingSafeEqual("d2f_sbx_a", "d2f_sbx_a")).toBe(true));
  it("rejects different values", () => expect(timingSafeEqual("d2f_sbx_a", "d2f_sbx_b")).toBe(false));
});
