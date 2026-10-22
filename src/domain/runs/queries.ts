import type { ReferenceData } from "../engine/types";
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
}

/** Why an override is not offered at all (spec v1.4): a credit note, or an invoice whose total was never read. */
export function overrideBlockedReason(run: RunRecord): string | null {
  if (run.blocking_codes.includes("CREDIT_NOTE_UNSUPPORTED")) return "Credit notes are not approved for the payment list; they go through the company's credit-note process (G3)";
  if (run.total_paise == null) return "The total was never read, so there is nothing to approve; request a corrected invoice or reject it";
  return null;
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
export function availableActions(run: RunRecord, s: Pick<StoreState, "runs">, ref?: ReferenceData): ActionOption[] {
  const out: ActionOption[] = [];
  const canOverride = overrideBlockedReason(run) === null;
  const override = (row: number): ActionOption => ({ action: "override_approve", row, needsNote: true, ...(poChoices(run, ref) ? { po_choices: poChoices(run, ref) } : {}) });
  const only = (code: string) => run.blocking_codes.length === 1 && run.blocking_codes[0] === code;
  switch (run.state) {
    case "CLEARED":
      if (!run.export_blocked) out.push({ action: "approve", row: 6, needsNote: false });
      out.push({ action: "manual_hold", row: 7, needsNote: true });
      break;
    case "ON_HOLD": {
      if (only("CORRECTION_UNCONFIRMED")) out.push({ action: "confirm_link", row: 16, needsNote: true });
      const d = run.engine?.dispute;
      const counterpart = d ? s.runs.get(d.counterpart_run_id) : undefined;
      if (only("POSSIBLE_DOUBLE_BILLING") && counterpart?.state === "APPROVED" && !counterpart.exported) {
        out.push({ action: "replace_approved", row: 17, needsNote: true });
      }
      out.push({ action: "request_correction", row: 11, needsNote: false });
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
