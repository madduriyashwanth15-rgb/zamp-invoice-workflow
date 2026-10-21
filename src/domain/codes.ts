// Reason codes exactly as spec sections 9-10. Never add or rename one here without a spec change.

export type CodeKind = "blocking" | "info" | "skip" | "reject" | "failed";
export type Priority = "P0" | "P1" | "P2";

export const REASON_CODES = {
  NO_ATTACHMENT: { kind: "skip", priority: "P0" },
  UNSUPPORTED_FILE: { kind: "skip", priority: "P0" },
  NOT_INVOICE: { kind: "skip", priority: "P0" },
  DUPLICATE_INVOICE: { kind: "reject", priority: "P0" },
  VENDOR_UNKNOWN: { kind: "blocking", priority: "P0" },
  SENDER_UNVERIFIED: { kind: "blocking", priority: "P0" },
  BANK_DETAILS_CHANGED: { kind: "blocking", priority: "P0" },
  VENDOR_GSTIN_MISMATCH: { kind: "blocking", priority: "P1" },
  POSSIBLE_DOUBLE_BILLING: { kind: "blocking", priority: "P0" },
  RELATED_INVOICE_DISPUTE: { kind: "blocking", priority: "P0" },
  CORRECTION_UNCONFIRMED: { kind: "blocking", priority: "P0" },
  POSSIBLE_DUPLICATE: { kind: "blocking", priority: "P2" },
  CLASSIFICATION_CONFLICT: { kind: "blocking", priority: "P0" },
  EXTRACTION_FAILED: { kind: "blocking", priority: "P0" },
  MISSING_REQUIRED_FIELD: { kind: "blocking", priority: "P0" },
  EVIDENCE_NOT_FOUND: { kind: "blocking", priority: "P0" },
  ARITHMETIC_MISMATCH: { kind: "blocking", priority: "P0" },
  SCAN_UNVERIFIED: { kind: "blocking", priority: "P0" },
  CREDIT_NOTE_UNSUPPORTED: { kind: "blocking", priority: "P1" },
  TAX_BASIS_UNCLEAR: { kind: "blocking", priority: "P0" },
  TAX_RATE_MISMATCH: { kind: "blocking", priority: "P1" },
  PO_NOT_FOUND: { kind: "blocking", priority: "P0" },
  PO_AMBIGUOUS: { kind: "blocking", priority: "P0" },
  PO_VENDOR_MISMATCH: { kind: "blocking", priority: "P1" },
  PO_CLOSED: { kind: "blocking", priority: "P1" },
  UNAPPROVED_CHARGE: { kind: "blocking", priority: "P0" },
  LINE_UNMAPPED: { kind: "blocking", priority: "P0" },
  UOM_UNSUPPORTED: { kind: "blocking", priority: "P0" },
  AI_PROPOSAL_REJECTED: { kind: "blocking", priority: "P0" },
  QTY_EXCEEDS_PO: { kind: "blocking", priority: "P0" },
  PO_AMOUNT_EXCEEDED: { kind: "blocking", priority: "P0" },
  PRICE_OVER_TOLERANCE: { kind: "blocking", priority: "P0" },
  BUNDLED_QUANTITY_UNVERIFIED: { kind: "blocking", priority: "P0" },
  DATE_INVALID: { kind: "blocking", priority: "P2" },
  APPROVAL_LIMIT_EXCEEDED: { kind: "blocking", priority: "P2" },
  MANUAL_HOLD: { kind: "blocking", priority: "P0" },
  ATTACHMENT_FETCH_FAILED: { kind: "failed", priority: "P0" },
  PROCESSING_ERROR: { kind: "failed", priority: "P0" },
  // Info codes carry no priority in section 10.
  PO_INFERRED: { kind: "info", priority: null },
  PRICE_WITHIN_TOLERANCE: { kind: "info", priority: null },
  PRICE_BELOW_PO: { kind: "info", priority: null },
  BANK_NOT_SHOWN: { kind: "info", priority: null },
  LINE_MAPPED_AI_VERIFIED: { kind: "info", priority: null },
  CORRECTION_OF: { kind: "info", priority: null },
  CORRECTION_CANDIDATE_OF: { kind: "info", priority: null },
} as const satisfies Record<string, { kind: CodeKind; priority: Priority | null }>;

export type ReasonCode = keyof typeof REASON_CODES;

/** Section 9 severity order of hold codes, most severe first (drives primary_reason). */
export const SEVERITY: readonly ReasonCode[] = [
  "MANUAL_HOLD", "VENDOR_UNKNOWN", "VENDOR_GSTIN_MISMATCH", "SENDER_UNVERIFIED", "BANK_DETAILS_CHANGED",
  "POSSIBLE_DOUBLE_BILLING", "RELATED_INVOICE_DISPUTE", "POSSIBLE_DUPLICATE", "CORRECTION_UNCONFIRMED",
  "CLASSIFICATION_CONFLICT", "CREDIT_NOTE_UNSUPPORTED", "EXTRACTION_FAILED", "MISSING_REQUIRED_FIELD",
  "EVIDENCE_NOT_FOUND", "ARITHMETIC_MISMATCH", "SCAN_UNVERIFIED", "TAX_BASIS_UNCLEAR", "PO_NOT_FOUND",
  "PO_VENDOR_MISMATCH", "PO_CLOSED", "PO_AMBIGUOUS", "UNAPPROVED_CHARGE", "LINE_UNMAPPED", "UOM_UNSUPPORTED",
  "AI_PROPOSAL_REJECTED", "TAX_RATE_MISMATCH", "QTY_EXCEEDS_PO", "PO_AMOUNT_EXCEEDED", "PRICE_OVER_TOLERANCE",
  "BUNDLED_QUANTITY_UNVERIFIED", "DATE_INVALID", "APPROVAL_LIMIT_EXCEEDED",
];

/** Audit event codes (section 11), not reason codes. */
export const EVENT_CODES = ["DELIVERY_REPEAT_IGNORED", "ACTION_REPEAT_IGNORED", "INVALID_TRANSITION_BLOCKED"] as const;
export type EventCode = (typeof EVENT_CODES)[number];
