import type { InvoiceState } from "./types";

const ALLOWED_TRANSITIONS: Record<InvoiceState, readonly InvoiceState[]> = {
  RECEIVED: ["REJECTED", "ROUTED"],
  REJECTED: [],
  ROUTED: ["DELIVERED"],
  DELIVERED: ["MADE_AVAILABLE", "REFUSED", "DISPUTED"],
  MADE_AVAILABLE: ["APPROVED", "REFUSED", "DISPUTED", "SUSPENDED", "PROCESSING"],
  APPROVED: ["PROCESSING", "PAID"],
  REFUSED: [],
  DISPUTED: ["SUSPENDED", "PROCESSING", "REFUSED"],
  SUSPENDED: ["PROCESSING", "REFUSED"],
  PROCESSING: ["PAID", "DISPUTED", "SUSPENDED"],
  PAID: []
};

export const REGULATORY_CODES: Partial<Record<InvoiceState, string>> = {
  PAID: "212"
};

export function canTransition(from: InvoiceState, to: InvoiceState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function nextInvoiceStates(from: InvoiceState): readonly InvoiceState[] {
  return ALLOWED_TRANSITIONS[from];
}

export function assertTransition(from: InvoiceState, to: InvoiceState): void {
  if (!canTransition(from, to)) throw new Error(`OUT_OF_ORDER_LIFECYCLE: ${from} cannot transition to ${to}`);
}
