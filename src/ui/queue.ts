import type { RunSummary } from "@/server/views";
import { TIER_ORDER } from "@/lib/issue-tier";

// The desk's saved views: each one answers "what needs doing next" for one group of invoices. Pure functions of
// the listed runs, shared by the side navigation (counts) and the queue (rows).

export type ViewId = "review" | "cleared" | "waiting" | "approved" | "exported" | "closed" | "all";

export interface QueueView {
  id: ViewId;
  label: string;
  /** What the view holds, for the page header and tooltips. */
  hint: string;
  test: (r: RunSummary) => boolean;
}

export const VIEWS: QueueView[] = [
  {
    id: "review",
    label: "Needs a decision",
    hint: "Held by a check or not read; a reviewer decides what happens next",
    test: (r) => r.state === "ON_HOLD" || r.state === "FAILED" || r.state === "RECEIVED" || r.state === "PROCESSING",
  },
  { id: "cleared", label: "Ready to approve", hint: "Every check passed; waiting for a reviewer's approval", test: (r) => r.state === "CLEARED" },
  { id: "waiting", label: "Waiting for vendor", hint: "A correction was requested; the vendor's reply is linked by its reference", test: (r) => r.state === "AWAITING_VENDOR" },
  { id: "approved", label: "Approved", hint: "Approved for the payment list and not exported yet", test: (r) => r.state === "APPROVED" && !r.exported },
  { id: "exported", label: "Exported", hint: "Handed to finance on a payment list", test: (r) => r.exported },
  {
    id: "closed",
    label: "Closed",
    hint: "Rejected, replaced by a correction, or not an invoice",
    test: (r) => r.state === "REJECTED" || r.state === "SUPERSEDED" || r.state === "SKIPPED",
  },
  { id: "all", label: "All invoices", hint: "Every invoice received", test: () => true },
];

export const viewOf = (id: string | null | undefined): QueueView => VIEWS.find((v) => v.id === id) ?? VIEWS[0];

export const isViewId = (id: string | null | undefined): id is ViewId => VIEWS.some((v) => v.id === id);

/** The view an invoice belongs to (the first that holds it), for breadcrumbs and next/previous on the review screen. */
export const homeView = (r: RunSummary): QueueView => VIEWS.find((v) => v.id !== "all" && v.test(r)) ?? VIEWS.at(-1)!;

export const isReading = (r: RunSummary) => r.state === "RECEIVED" || r.state === "PROCESSING";

/** Ready for the next export: approved, not exported, not blocked by a dispute. */
export const exportable = (r: RunSummary) => r.state === "APPROVED" && !r.exported && !r.export_blocked;

/** The total in paise, for sorting by amount without floating point; null when the total was not read. */
const paiseOf = (r: RunSummary) => {
  const m = r.total_rupees ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(r.total_rupees) : null;
  if (!m) return null;
  const p = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -p : p;
};

// ---- ageing (review gap 12): display only, from dates already on the run; nothing is sent or escalated.

/** Whole calendar days from one ISO date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const day = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** Still to be paid by finance's process: the due date (per terms) matters on the desk. Exported or closed: it does not. */
const awaitingPayment = (r: RunSummary) =>
  r.state === "CLEARED" || r.state === "ON_HOLD" || r.state === "AWAITING_VENDOR" || (r.state === "APPROVED" && !r.exported);

/** Days until the due date (per terms) from `today` (both India dates); null when not tracked for this invoice. */
export function dueInDays(r: RunSummary, today: string): number | null {
  return r.due_per_terms && awaitingPayment(r) ? daysBetween(today, r.due_per_terms) : null;
}

export type DueTone = "overdue" | "soon" | "later";

/** "due today", "due in 3 days", "overdue by 2 days"; soon is within 3 days. */
export function dueText(days: number): { text: string; tone: DueTone } {
  const d = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (days < 0) return { text: `overdue by ${d(-days)}`, tone: "overdue" };
  if (days === 0) return { text: "due today", tone: "soon" };
  if (days === 1) return { text: "due tomorrow", tone: "soon" };
  return { text: `due in ${d(days)}`, tone: days <= 3 ? "soon" : "later" };
}

/** "today", "yesterday", "5 days ago": how long ago an invoice arrived, by India calendar dates. */
export function ageText(receivedOn: string, today: string): string {
  const n = daysBetween(receivedOn, today);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

export type SortId = "serious" | "due" | "newest" | "oldest" | "amount" | "vendor";
export const SORTS: { id: SortId; label: string }[] = [
  { id: "serious", label: "Most serious first" },
  { id: "due", label: "Due soonest (per terms)" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "amount", label: "Amount, highest first" },
  { id: "vendor", label: "Vendor, A to Z" },
];

const tierRank = (r: RunSummary) => (r.tiers.length ? TIER_ORDER.indexOf(r.tiers[0]) : TIER_ORDER.length);

export function sortRuns(rs: RunSummary[], by: SortId): RunSummary[] {
  const time = (r: RunSummary) => r.created_at;
  const copy = [...rs];
  switch (by) {
    case "due":
      // Earliest due date first; invoices with no due date (not read, or exported or closed) last, newest first.
      return copy.sort((a, b) => {
        const x = awaitingPayment(a) ? a.due_per_terms : null;
        const y = awaitingPayment(b) ? b.due_per_terms : null;
        if (x == null || y == null) return x == null ? (y == null ? time(b).localeCompare(time(a)) : 1) : -1;
        return x.localeCompare(y) || time(b).localeCompare(time(a));
      });
    case "serious":
      return copy.sort((a, b) => tierRank(a) - tierRank(b) || time(b).localeCompare(time(a)));
    case "newest":
      return copy.sort((a, b) => time(b).localeCompare(time(a)));
    case "oldest":
      return copy.sort((a, b) => time(a).localeCompare(time(b)));
    case "amount":
      return copy.sort((a, b) => {
        const x = paiseOf(a);
        const y = paiseOf(b);
        if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
        return y > x ? 1 : y < x ? -1 : 0;
      });
    case "vendor":
      return copy.sort((a, b) => (a.vendor ?? a.filename ?? "").localeCompare(b.vendor ?? b.filename ?? ""));
  }
}

/** The order a view opens in: the most serious holds first where a decision is needed, otherwise newest first. */
export const defaultSort = (view: ViewId): SortId => (view === "review" ? "serious" : "newest");
