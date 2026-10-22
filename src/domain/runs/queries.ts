import type { ReasonCode } from "../codes";
import { normInvoiceNumber, normText } from "../normalise";
import type { Finding, ReferenceData } from "../engine/types";
import type { RunRecord, StoreState } from "./types";

// Read-side helpers shared by the app and tests. Pure: they only look at state.

/** Next human reference "A0001", "A0002", ... (unique because receive runs under the store's write lock). */
export function nextRef(tx: StoreState): string {
  let max = 0;
  for (const r of tx.runs.values()) {
    const m = /^A(\d+)$/.exec(r.ref);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `A${String(max + 1).padStart(4, "0")}`;
}

export type ReviewAction =
  | "approve" | "manual_hold" | "override_approve" | "reject" | "request_correction" | "stop_waiting"
  | "confirm_link" | "replace_approved" | "retry" | "process_as_invoice";

export interface ActionOption {
  action: ReviewAction;
  /** Section 11 row the action applies. */
  row: number;
  needsNote: boolean;
  /** Override of a known vendor's invoice with no PO found: the reviewer must name one of these open POs (C4b). */
  po_choices?: string[];
  /** Override of a bank, vendor or sender hold: a callback record is required (spec v1.4 row 9, Q9). */
  callback?: CallbackRequirement;
}

export interface CallbackRequirement {
  codes: ReasonCode[];
  /** The number the call must use; null when the vendor is not in the master (there is no trusted number). */
  master_phone: string | null;
}

/** Holds whose override needs a recorded phone call (spec v1.4 row 9, Q9): identity, sender and bank account. */
export const CALLBACK_CODES: readonly ReasonCode[] = ["VENDOR_UNKNOWN", "VENDOR_GSTIN_MISMATCH", "SENDER_UNVERIFIED", "BANK_DETAILS_CHANGED"];

export function callbackRequirement(run: RunRecord, ref?: ReferenceData): CallbackRequirement | undefined {
  const codes = run.blocking_codes.filter((c) => CALLBACK_CODES.includes(c));
  // An unread bank account (K4b) is a bank hold too: approving it pays an account nobody compared with the master.
  if ((run.engine?.blocking ?? []).some((f) => f.code === "MISSING_REQUIRED_FIELD" && f.evidence.field === "bank account")) codes.push("MISSING_REQUIRED_FIELD");
  if (!codes.length) return undefined;
  const vendor = run.vendor_id ? ref?.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  return { codes, master_phone: vendor?.phone ?? null };
}

/** Same phone number: the last 10 digits agree (so "+91 80 0000 1002" and "080 0000 1002" match). */
export function samePhone(a: string, b: string): boolean {
  const d = (s: string) => s.replace(/\D/g, "").slice(-10);
  return d(a).length >= 8 && d(a) === d(b);
}

/**
 * Holds a vendor can fix by sending a corrected invoice (spec v1.4, audit U03). The others are checks on our side
 * (our reading, our records, a fraud signal to verify by phone): emailing the vendor about them is wrong, and for a
 * changed bank account it would ask the possibly compromised sender to confirm their own change.
 */
const VENDOR_FIXABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "PRICE_OVER_TOLERANCE", "QTY_EXCEEDS_PO", "PO_AMOUNT_EXCEEDED", "ARITHMETIC_MISMATCH", "TAX_BASIS_UNCLEAR", "TAX_RATE_MISMATCH",
  "MISSING_REQUIRED_FIELD", "PO_NOT_FOUND", "PO_AMBIGUOUS", "PO_VENDOR_MISMATCH", "PO_CLOSED", "UNAPPROVED_CHARGE", "DATE_INVALID",
  "SCAN_UNVERIFIED", "BUNDLED_QUANTITY_UNVERIFIED", "LINE_UNMAPPED", "UOM_UNSUPPORTED", "CLASSIFICATION_CONFLICT",
]);

/**
 * A finding the vendor can fix. Not theirs: a bank account we failed to read (K4b); our reader disagreeing with a
 * printed invoice title (G2; only G1b, a document that calls itself a quotation, is); and a rejected AI line
 * proposal (it always comes with LINE_UNMAPPED or UOM_UNSUPPORTED on the same line, which are).
 */
export function vendorFixable(f: Pick<Finding, "code" | "evidence">): boolean {
  if (f.code === "MISSING_REQUIRED_FIELD" && f.evidence.field === "bank account") return false;
  if (f.code === "CLASSIFICATION_CONFLICT" && f.evidence.word == null) return false;
  return VENDOR_FIXABLE.has(f.code);
}

/** True when a correction request makes sense: something the vendor can fix, an unreadable file, or a reviewer's hold. */
export function vendorCanFix(run: RunRecord): boolean {
  if (run.blocking_codes.includes("EXTRACTION_FAILED") || run.blocking_codes.includes("MANUAL_HOLD")) return true;
  return (run.engine?.blocking ?? []).some(vendorFixable);
}

/** Why an override is not offered at all (spec v1.4): a credit note, or an invoice whose total was never read. */
export function overrideBlockedReason(run: RunRecord): string | null {
  if (run.blocking_codes.includes("CREDIT_NOTE_UNSUPPORTED")) return "Credit notes are not approved for the payment list; they go through the company's credit-note process (G3)";
  if (run.total_paise == null) return "The total was never read, so there is nothing to approve; request a corrected invoice or reject it";
  return null;
}

const PAYABLE_STATES = new Set(["CLEARED", "APPROVED"]);

/**
 * P9b (spec v1.4): the chain invariant also when the code could not build a chain (unknown vendor, failed reading).
 * Another CLEARED or APPROVED run is the same invoice when it has the same file, or the same invoice number and
 * either the same vendor (master id, or the printed name when unknown) or, when either run was not matched to the
 * vendor master, the same total: a re-scan whose vendor was misread must not be paid a second time.
 */
export function sameInvoicePayable(
  run: RunRecord, s: Pick<StoreState, "runs"> & Partial<Pick<StoreState, "documents">>, exclude: Set<string> = new Set(),
): { other: RunRecord; why: string } | undefined {
  const sha = s.documents?.get(run.run_id)?.sha256 ?? null;
  const number = run.extraction?.invoice_number ? normInvoiceNumber(run.extraction.invoice_number) : null;
  const vendorKey = (r: RunRecord) => r.vendor_id ?? (r.extraction?.vendor_name ? `name:${normText(r.extraction.vendor_name)}` : null);
  for (const r of s.runs.values()) {
    if (r.run_id === run.run_id || exclude.has(r.run_id) || !PAYABLE_STATES.has(r.state)) continue;
    if (sha && s.documents?.get(r.run_id)?.sha256 === sha) return { other: r, why: "the same file" };
    if (!number || !r.extraction?.invoice_number || normInvoiceNumber(r.extraction.invoice_number) !== number) continue;
    if (vendorKey(run) && vendorKey(r) === vendorKey(run)) return { other: r, why: `invoice number ${run.extraction!.invoice_number} from the same vendor` };
    if ((!run.vendor_id || !r.vendor_id) && run.total_paise != null && run.total_paise === r.total_paise) {
      return { other: r, why: `invoice number ${run.extraction!.invoice_number} with the same total (one of them is not matched to the vendor master)` };
    }
  }
  return undefined;
}

/** Open POs of the run's vendor, when the code found none for it (the reviewer names one at override). */
export function poChoices(run: RunRecord, ref?: ReferenceData): string[] | undefined {
  if (!ref || run.po_number || !run.vendor_id) return undefined;
  return ref.purchaseOrders.filter((p) => p.vendor_id === run.vendor_id && p.status === "open").map((p) => p.po_number).sort();
}

/**
 * Actions a reviewer may attempt on a run in its current state (section 11, user rows). This only decides what
 * to offer; the review functions re-check every guard inside the transaction and refuse with a logged reason.
 */
export function availableActions(run: RunRecord, s: Pick<StoreState, "runs"> & Partial<Pick<StoreState, "documents">>, ref?: ReferenceData): ActionOption[] {
  const out: ActionOption[] = [];
  // A known vendor with no open PO cannot be approved against one (C4b), so the override is not offered at all.
  const noOpenPo = poChoices(run, ref)?.length === 0;
  const canOverride = overrideBlockedReason(run) === null && !noOpenPo && !sameInvoicePayable(run, s);
  const callback = callbackRequirement(run, ref);
  const override = (row: number): ActionOption => ({
    action: "override_approve", row, needsNote: true, ...(poChoices(run, ref) ? { po_choices: poChoices(run, ref) } : {}), ...(callback ? { callback } : {}),
  });
  const only = (code: string) => run.blocking_codes.length === 1 && run.blocking_codes[0] === code;
  switch (run.state) {
    case "CLEARED":
      if (!run.export_blocked && !sameInvoicePayable(run, s)) out.push({ action: "approve", row: 6, needsNote: false });
      out.push({ action: "manual_hold", row: 7, needsNote: true });
      break;
    case "ON_HOLD": {
      if (only("CORRECTION_UNCONFIRMED")) out.push({ action: "confirm_link", row: 16, needsNote: true });
      const d = run.engine?.dispute;
      const counterpart = d ? s.runs.get(d.counterpart_run_id) : undefined;
      if (only("POSSIBLE_DOUBLE_BILLING") && counterpart?.state === "APPROVED" && !counterpart.exported) {
        out.push({ action: "replace_approved", row: 17, needsNote: true });
      }
      if (vendorCanFix(run)) out.push({ action: "request_correction", row: 11, needsNote: false });
      if (!d?.counterpart_exported && canOverride) out.push(override(9));
      out.push({ action: "reject", row: 10, needsNote: true });
      break;
    }
    case "AWAITING_VENDOR":
      out.push({ action: "stop_waiting", row: 13, needsNote: true });
      if (canOverride) out.push(override(14));
      out.push({ action: "reject", row: 14, needsNote: true });
      break;
    case "FAILED":
      // A failed attachment fetch left no document to retry with; the vendor has to send it again.
      if (run.primary_reason !== "ATTACHMENT_FETCH_FAILED") out.push({ action: "retry", row: 4, needsNote: false });
      break;
    case "SKIPPED":
      if (run.extraction) out.push({ action: "process_as_invoice", row: 5, needsNote: true });
      break;
  }
  return out;
}
