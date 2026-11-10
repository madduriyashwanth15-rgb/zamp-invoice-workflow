import type { RunSummary } from "@/server/views";
import type { ReasonCode } from "@/domain/codes";
import { SEVERITY } from "@/domain/codes";
import { sumRupees } from "@/lib/format";

// The desk's metrics strip (review gaps 2 and 3): numbers across every run in the workspace, worked out from the
// listed runs only. Presentation, not a business rule: nothing here decides, holds or changes an invoice.
//
// Straight through means the code checks cleared the invoice and nothing has held it since: no hold code on the
// run. This holds across the run's history because a person's action never removes hold codes: an override approval
// keeps them (review.ts, row 9), a manual hold adds MANUAL_HOLD (row 7), a D3 dispute on a cleared counterpart adds
// RELATED_INVOICE_DISPUTE (row 8). Codes are rewritten only when the checks run again: a retry after a system
// failure (row 4), which counts as the checks' own decision, and "process as invoice" (row 5), where a person
// overrode the invoice check, so it is never counted as straight through (forced_as_invoice).
// A D3 dispute against an approved, unexported counterpart blocks its export without a hold code; that counterpart
// was handled straight through and stays counted so.

/** States in which the checks have made a decision on an invoice. Skipped (not an invoice), failed and still-reading runs are left out. */
const DECIDED: ReadonlySet<RunSummary["state"]> = new Set(["CLEARED", "APPROVED", "ON_HOLD", "AWAITING_VENDOR", "REJECTED", "SUPERSEDED"]);

/** States a straight-through invoice can be in: cleared, approved, or (rarely, row 17) an approved one later replaced. */
const CLEAN: ReadonlySet<RunSummary["state"]> = new Set(["CLEARED", "APPROVED", "SUPERSEDED"]);

/** Money held up right now: waiting on a reviewer or on the vendor. */
const HELD_NOW: ReadonlySet<RunSummary["state"]> = new Set(["ON_HOLD", "AWAITING_VENDOR"]);

export const isDecided = (r: RunSummary) => DECIDED.has(r.state);

export const isStraightThrough = (r: RunSummary) => isDecided(r) && CLEAN.has(r.state) && r.blocking_count === 0 && !r.forced_as_invoice;

export interface ReasonCount {
  code: ReasonCode;
  title: string;
  count: number;
}

export interface DeskMetrics {
  /** Invoices the checks decided on (the rate's denominator). */
  decided: number;
  straightThrough: number;
  /** Whole percent, rounded; null when nothing has been decided (never shown as 0%). */
  ratePct: number | null;
  /** On hold or waiting for the vendor now. */
  heldNow: number;
  /** Exact decimal rupee sum of the held invoices whose total was read. */
  heldValue: string;
  /** Held invoices whose total was not read, so are not in heldValue. */
  heldUnread: number;
  /** Why decided invoices did not go straight through: each counted once, by its main reason; most common first. */
  topReasons: ReasonCount[];
  /** Decided, not straight through, with no main reason recorded (counted so the reasons add up honestly). */
  otherReasons: number;
}

const rank = (c: ReasonCode) => {
  const i = SEVERITY.indexOf(c);
  return i < 0 ? SEVERITY.length : i;
};

export function deskMetrics(runs: RunSummary[], top = 3): DeskMetrics {
  const decided = runs.filter(isDecided);
  const straight = decided.filter(isStraightThrough);
  const held = runs.filter((r) => HELD_NOW.has(r.state));

  const counts = new Map<ReasonCode, ReasonCount>();
  let otherReasons = 0;
  for (const r of decided) {
    if (isStraightThrough(r)) continue;
    const reason = r.hold_reason;
    if (!reason) {
      otherReasons += 1;
      continue;
    }
    const c = counts.get(reason.code) ?? { code: reason.code, title: reason.title, count: 0 };
    c.count += 1;
    counts.set(reason.code, c);
  }
  // Most common first; ties by the spec's severity order (section 9), then by code, so the order never flickers.
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));

  return {
    decided: decided.length,
    straightThrough: straight.length,
    ratePct: decided.length === 0 ? null : Math.round((straight.length * 100) / decided.length),
    heldNow: held.length,
    heldValue: sumRupees(held.map((r) => r.total_rupees)),
    heldUnread: held.filter((r) => r.total_rupees == null).length,
    topReasons: sorted.slice(0, top),
    otherReasons,
  };
}
