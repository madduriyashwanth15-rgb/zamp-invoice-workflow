import type { ReasonCode } from "@/domain/codes";

// What kind of risk a hold is, so a reviewer can see at a glance where money could go wrong. Presentation only:
// the tier never changes a decision, an action or a state; the reason codes (spec sections 9-10) stay the source.

export type IssueTier = "identity" | "twice" | "po" | "document" | "check";

/** Most serious first: money to the wrong party, then paying twice, then paying more than agreed. */
export const TIER_ORDER: readonly IssueTier[] = ["identity", "twice", "po", "document", "check"];

export const TIER_TEXT: Record<IssueTier, { label: string; short: string; why: string; noun: [string, string] }> = {
  identity: {
    label: "Identity or bank check",
    short: "Identity or bank",
    noun: ["identity or bank check", "identity or bank checks"],
    why: "Money could go to the wrong party. Settle it by phone, on the number in the vendor master.",
  },
  twice: {
    label: "Could be billed twice",
    short: "Could be billed twice",
    noun: ["possible repeat bill", "possible repeat bills"],
    why: "Another invoice looks like the same bill. Compare the two before anything goes on the payment list.",
  },
  po: {
    label: "PO discrepancy",
    short: "PO discrepancy",
    noun: ["PO discrepancy", "PO discrepancies"],
    why: "The invoice bills more, or differently, than the purchase order allows.",
  },
  document: {
    label: "Document problem",
    short: "Document",
    noun: ["document problem", "document problems"],
    why: "The invoice itself is incomplete, inconsistent or not a tax invoice.",
  },
  check: {
    label: "Needs a person's check",
    short: "Person's check",
    noun: ["needs a person's check", "need a person's check"],
    why: "Code cannot verify this on its own; a reviewer has to look.",
  },
};

const BY_CODE: Partial<Record<ReasonCode, IssueTier>> = {
  VENDOR_UNKNOWN: "identity",
  VENDOR_GSTIN_MISMATCH: "identity",
  SENDER_UNVERIFIED: "identity",
  BANK_DETAILS_CHANGED: "identity",
  POSSIBLE_DOUBLE_BILLING: "twice",
  RELATED_INVOICE_DISPUTE: "twice",
  POSSIBLE_DUPLICATE: "twice",
  CORRECTION_UNCONFIRMED: "twice",
  DUPLICATE_INVOICE: "twice",
  PRICE_OVER_TOLERANCE: "po",
  QTY_EXCEEDS_PO: "po",
  PO_AMOUNT_EXCEEDED: "po",
  UNAPPROVED_CHARGE: "po",
  TAX_RATE_MISMATCH: "po",
  PO_NOT_FOUND: "po",
  PO_AMBIGUOUS: "po",
  PO_VENDOR_MISMATCH: "po",
  PO_CLOSED: "po",
  LINE_UNMAPPED: "po",
  UOM_UNSUPPORTED: "po",
  AI_PROPOSAL_REJECTED: "po",
  ARITHMETIC_MISMATCH: "document",
  MISSING_REQUIRED_FIELD: "document",
  EVIDENCE_NOT_FOUND: "document",
  TAX_BASIS_UNCLEAR: "document",
  CLASSIFICATION_CONFLICT: "document",
  CREDIT_NOTE_UNSUPPORTED: "document",
  DATE_INVALID: "document",
  EXTRACTION_FAILED: "document",
  NOT_INVOICE: "document",
  NO_ATTACHMENT: "document",
  UNSUPPORTED_FILE: "document",
  ATTACHMENT_FETCH_FAILED: "document",
  PROCESSING_ERROR: "document",
  SCAN_UNVERIFIED: "check",
  BUNDLED_QUANTITY_UNVERIFIED: "check",
  MANUAL_HOLD: "check",
  APPROVAL_LIMIT_EXCEEDED: "check",
};

/**
 * The tier of one hold. A bank account that is printed but was not read (K4b, MISSING_REQUIRED_FIELD on the bank
 * account) is a bank check, not a document problem: approving it pays an account nobody compared with the master.
 * Info codes have no tier.
 */
export function tierOf(code: ReasonCode, field?: unknown): IssueTier | null {
  if (code === "MISSING_REQUIRED_FIELD" && field === "bank account") return "identity";
  return BY_CODE[code] ?? null;
}

/** Distinct tiers, most serious first. */
export function sortTiers(tiers: Iterable<IssueTier | null>): IssueTier[] {
  const set = new Set([...tiers].filter((t): t is IssueTier => t != null));
  return TIER_ORDER.filter((t) => set.has(t));
}
