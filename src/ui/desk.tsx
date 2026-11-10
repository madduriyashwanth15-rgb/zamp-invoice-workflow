"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, BadgeCheck, ChevronRight, FileSpreadsheet, FileUp, Inbox, Mail, Search, Upload, UserRound } from "lucide-react";
import type { RunSummary } from "@/server/views";
import { formatDate, formatInr, formatTime, istDate, sumRupees } from "@/lib/format";
import { TIER_ORDER, TIER_TEXT, type IssueTier } from "@/lib/issue-tier";
import { api, errorText, type Listing } from "./api";
import { SHORT_STATE, SlipStrip, SlipSwatch, StateChip, TierBadge } from "./chips";
import { useIdentity } from "./identity";
import { Button, Dialog, EmptyState, Notice, Skeleton, btn, cx, inputCls } from "./kit";
import { SORTS, VIEWS, ageText, defaultSort, dueInDays, dueText, exportable, isReading, sortRuns, viewOf, type SortId, type ViewId } from "./queue";
import { deskMetrics } from "./desk-metrics";
import { useRuns } from "./runs-context";
import { PageHeader } from "./shell";

// The AP desk: what needs a person, what is safe to approve, what is ready for finance, and the queue itself.
// Every count and amount here is summed from the listed invoices; nothing is estimated.

const invoices = (n: number) => `${n} invoice${n === 1 ? "" : "s"}`;
const sumOf = (rs: RunSummary[]) => formatInr(sumRupees(rs.map((r) => r.total_rupees)));
const anyUnread = (rs: RunSummary[]) => rs.some((r) => r.total_rupees == null);

export function Desk() {
  const params = useSearchParams();
  const view = viewOf(params.get("view"));
  const { data, error, loading, refresh } = useRuns();
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const upload = useUpload(refresh);
  const [exporting, setExporting] = useState(0);
  const openExport = () => setExporting((n) => Math.abs(n) + 1);

  return (
    <div>
      <PageHeader
        title="Invoices"
        meta={
          <span>
            Every invoice from email or upload, checked by code against the vendor master and purchase orders. Nothing reaches the payment list without a person. Drop a file on the
            list to add it.
          </span>
        }
        actions={<UploadButton upload={upload} />}
      />
      {/* When the list failed to load there is nothing to count: the queue below says so, with a retry. */}
      {data && <MetricsStrip runs={runs} />}
      {!(error && !data) && <Attention runs={runs} loaded={Boolean(data)} listing={data} onExport={openExport} />}
      <Queue key={view.id} view={view.id} runs={runs} listing={data} loading={loading && !data} error={error} onChanged={refresh} onDrop={upload.send} onExport={openExport} />
      {exporting > 0 && <ExportDialog key={exporting} open onClose={() => setExporting((n) => -n)} listing={data} onChanged={refresh} />}
    </div>
  );
}

// ---- the four lanes: what needs attention now, with real counts and sums

function Lane({
  href,
  label,
  count,
  amount,
  unread,
  children,
  tone,
  active,
}: {
  href: string;
  label: string;
  count: number;
  amount: string | null;
  unread?: boolean;
  children?: ReactNode;
  tone: "hold" | "ok" | "approved" | "wait";
  active: boolean;
}) {
  const bar = { hold: "bg-hold-edge", ok: "bg-stamp-ok", approved: "bg-approved-bg", wait: "bg-wait-edge" }[tone];
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cx("group relative block min-w-0 px-4 py-3 transition-colors hover:bg-surface-2", active && "bg-surface-2")}
    >
      <span aria-hidden className={cx("absolute inset-x-0 top-0 h-[3px]", count > 0 ? bar : "bg-transparent")} />
      <span className="flex items-center justify-between gap-2 text-[13px] font-semibold text-ink-2">
        {label}
        <ChevronRight aria-hidden size={14} className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
      </span>
      <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="num text-[26px] font-semibold leading-none text-ink">{count}</span>
        <span className="num text-[13px] font-medium text-ink-2">
          {count > 0 ? amount : ""}
          {count > 0 && unread ? " + totals not read" : ""}
        </span>
      </span>
      <span className="mt-1.5 block text-[12px] leading-snug text-ink-3">{children}</span>
    </Link>
  );
}

function Attention({ runs, loaded, listing, onExport }: { runs: RunSummary[]; loaded: boolean; listing: Listing | null; onExport: () => void }) {
  const params = useSearchParams();
  const current = params.get("view") ?? "review";
  if (!loaded) {
    return (
      <div className="mb-5 grid grid-cols-2 divide-x divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface lg:grid-cols-4 lg:divide-y-0" aria-busy>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2 px-4 py-3">
            <Skeleton className="w-24" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="w-32" />
          </div>
        ))}
      </div>
    );
  }
  const review = runs.filter((r) => r.state === "ON_HOLD" || r.state === "FAILED");
  const reading = runs.filter(isReading).length;
  const cleared = runs.filter((r) => r.state === "CLEARED");
  const repeats = cleared.filter((r) => r.approve_blocked).length;
  const approved = runs.filter((r) => r.state === "APPROVED" && !r.exported);
  const ready = approved.filter(exportable);
  const disputed = approved.length - ready.length;
  const waiting = runs.filter((r) => r.state === "AWAITING_VENDOR");
  // Each held invoice counted once, under its most serious kind of risk.
  const byTier = TIER_ORDER.map((t) => ({ t, n: review.filter((r) => r.tiers[0] === t).length })).filter((x) => x.n > 0);

  return (
    <section aria-label="What needs attention" className="mb-5">
      <div className="grid grid-cols-2 divide-x divide-y divide-rule overflow-hidden rounded-lg border border-rule bg-surface lg:grid-cols-4 lg:divide-y-0">
        <Lane href="/" label="Needs a decision" count={review.length} amount={sumOf(review)} unread={anyUnread(review)} tone="hold" active={current === "review"}>
          {review.length === 0
            ? reading
              ? `${reading} being read`
              : "Nothing is held"
            : byTier.map((x, i) => (
                <span key={x.t}>
                  {i > 0 && ", "}
                  <span className={x.t === "identity" || x.t === "twice" ? "font-semibold text-bad-fg" : ""}>
                    {x.n} {TIER_TEXT[x.t].noun[x.n === 1 ? 0 : 1]}
                  </span>
                </span>
              ))}
          {review.length > 0 && reading > 0 && `; ${reading} being read`}
        </Lane>
        <Lane href="/?view=cleared" label="Ready to approve" count={cleared.length} amount={sumOf(cleared)} tone="ok" active={current === "cleared"}>
          {cleared.length === 0 ? "No cleared invoices waiting" : repeats ? `${repeats} looks like a repeat; open it to decide` : "Every check passed; a reviewer approves"}
        </Lane>
        <Lane href="/?view=approved" label="Approved, not exported" count={approved.length} amount={sumOf(approved)} tone="approved" active={current === "approved"}>
          {approved.length === 0
            ? "Nothing waiting for export"
            : disputed
              ? `${disputed} held back by a dispute`
              : `${invoices(ready.length)} ${ready.length === 1 ? "goes" : "go"} out with the next export`}
        </Lane>
        <Lane href="/?view=waiting" label="Waiting for vendor" count={waiting.length} amount={sumOf(waiting)} tone="wait" active={current === "waiting"}>
          {waiting.length === 0 ? "No corrections pending" : "Replies are matched by their reference"}
        </Lane>
      </div>
      {ready.length > 0 && current !== "approved" && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-[13px] text-ink-2">
          <span>
            {invoices(ready.length)}, <span className="num font-semibold text-ink">{sumOf(ready)}</span>, ready for the payment list.
          </span>
          <ExportButton listing={listing} onExport={onExport} size="sm" />
        </div>
      )}
    </section>
  );
}

// ---- the metrics strip: across every invoice in the workspace, not only what needs doing now (review gaps 2 and 3)

function MetricsStrip({ runs }: { runs: RunSummary[] }) {
  const m = useMemo(() => deskMetrics(runs), [runs]);
  if (m.decided === 0) {
    return (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-dashed border-rule-strong bg-surface px-4 py-3">
        <p className="min-w-0 text-[13px] text-ink-2">
          <span className="font-semibold text-ink">No invoice has been checked in this workspace yet.</span> Send the recorded vendor emails (S1 to S14) from the Demo
          inbox, or add an invoice, to see the straight-through rate and why invoices are held.
        </p>
        <Link href="/demo" className={btn("secondary", "sm")}>
          <Mail aria-hidden size={14} />
          Open the Demo inbox
        </Link>
      </div>
    );
  }
  const notStraight = m.decided - m.straightThrough;
  const moreReasons = notStraight - m.topReasons.reduce((n, x) => n + x.count, 0);
  return (
    <section aria-labelledby="metrics-h" className="mb-3 overflow-hidden rounded-lg border border-rule bg-surface">
      <h2 id="metrics-h" className="border-b border-rule bg-surface-2 px-4 py-1.5 text-[12px] font-semibold text-ink-3">
        Across the {invoices(m.decided)} checked in this workspace
      </h2>
      <div className="grid grid-cols-1 divide-y divide-rule sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="min-w-0 px-4 py-3">
          <span className="block text-[13px] font-semibold text-ink-2">Straight through</span>
          <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="num text-[26px] font-semibold leading-none text-ink">{m.ratePct}%</span>
            <span className="num text-[13px] font-medium text-ink-2">
              {m.straightThrough} of {m.decided}
            </span>
          </span>
          <span aria-hidden className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-hold-bg">
            <span className="h-full rounded-full bg-stamp-ok transition-[width] duration-500" style={{ width: `${m.ratePct}%` }} />
          </span>
          <span className="mt-1.5 block text-[12px] leading-snug text-ink-3">Cleared by the checks with no hold; a person still approves each one</span>
        </div>
        <div className="min-w-0 px-4 py-3">
          <span className="block text-[13px] font-semibold text-ink-2">Value on hold now</span>
          <span className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="num text-[26px] font-semibold leading-none text-ink">{formatInr(m.heldValue)}</span>
          </span>
          <span className="mt-1.5 block text-[12px] leading-snug text-ink-3">
            {m.heldNow === 0 ? "Nothing is on hold or waiting for a vendor" : `${invoices(m.heldNow)} on hold or waiting for the vendor`}
            {m.heldUnread > 0 && `; ${m.heldUnread} with no total read, not included`}
          </span>
        </div>
        <div className="min-w-0 px-4 py-3">
          <span className="block text-[13px] font-semibold text-ink-2">What held up the rest</span>
          {notStraight === 0 ? (
            <span className="mt-1.5 block text-[12px] leading-snug text-ink-3">Every checked invoice went straight through</span>
          ) : (
            <ol className="mt-1 space-y-0.5 text-[13px]">
              {m.topReasons.map((x) => (
                <li key={x.code} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-ink" title={x.title}>
                    {x.title}
                  </span>
                  <span className="num shrink-0 font-medium text-ink-2">{x.count}</span>
                </li>
              ))}
              {moreReasons > 0 && <li className="text-[12px] text-ink-3">and {moreReasons} more for other reasons</li>}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- upload

type UploadState = { kind: "idle" } | { kind: "sending"; file: string } | { kind: "error"; text: string };

/** Sends a file through the same intake as an emailed invoice, then opens it. Used by the button and by drop. */
function useUpload(onUploaded: () => void) {
  const { name } = useIdentity();
  const router = useRouter();
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  async function send(file: File | undefined) {
    if (!file) return;
    if (!name) {
      setState({ kind: "error", text: "Choose who you are acting as (in the side menu) before uploading." });
      return;
    }
    setState({ kind: "sending", file: file.name });
    try {
      const r = await api.upload(file, name);
      onUploaded();
      router.push(`/runs/${r.run_id}${r.repeat ? "?repeat=1" : ""}`);
    } catch (e) {
      setState({ kind: "error", text: errorText(e) });
    }
  }
  return { state, send };
}

function UploadButton({ upload }: { upload: ReturnType<typeof useUpload> }) {
  const input = useRef<HTMLInputElement>(null);
  const { state, send } = upload;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => send(e.target.files?.[0] ?? undefined)}
      />
      <Button variant="primary" icon={FileUp} onClick={() => input.current?.click()} disabled={state.kind === "sending"} busy={state.kind === "sending"}>
        {state.kind === "sending" ? "Uploading" : "Add invoice"}
      </Button>
      <span className="text-[12px] text-ink-3">PDF, PNG or JPEG, up to 4 MB</span>
      {state.kind === "sending" && (
        <span role="status" className="text-[12px] text-carbon-deep">
          Uploading {state.file}
        </span>
      )}
      {state.kind === "error" && (
        <span role="alert" className="max-w-xs text-[12px] font-medium text-bad-fg sm:text-right">
          {state.text}
        </span>
      )}
    </div>
  );
}

// ---- export

function ExportButton({ listing, onExport, size = "md" }: { listing: Listing | null; onExport: () => void; size?: "sm" | "md" }) {
  const ready = (listing?.runs ?? []).filter(exportable);
  return (
    <Button variant="primary" size={size} icon={FileSpreadsheet} disabled={!ready.length} aria-haspopup="dialog" onClick={onExport}>
      Export payment list
    </Button>
  );
}

/**
 * The export confirmation. Mounted once on the desk (not inside the bar that opened it), so it stays open to show
 * the result after the export empties the list it was opened from. Remounted (fresh) each time it opens.
 */
function ExportDialog({ open, onClose, listing, onChanged }: { open: boolean; onClose: () => void; listing: Listing | null; onChanged: () => void }) {
  const { name } = useIdentity();
  const setOpen = (v: boolean) => {
    if (!v) onClose();
  };
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; id?: string } | null>(null);
  const runs = listing?.runs ?? [];
  const ready = runs.filter(exportable);
  const held = runs.filter((r) => r.state === "APPROVED" && !r.exported && r.export_blocked);

  async function doExport() {
    if (!name) return setMsg({ ok: false, text: "Choose who you are acting as (in the side menu) before exporting." });
    setPending(true);
    try {
      const r = await api.exportNow(name);
      setMsg({ ok: true, text: `Exported ${invoices(r.count)} to payment list ${r.export_id.slice(0, 12)}.`, id: r.export_id });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Export the payment list"
        description="Creates a CSV of every approved invoice for finance. Payment happens in finance's own process, not here, and an exported invoice cannot be changed in this tool."
        footer={
          msg?.ok ? (
            <>
              {msg.id && (
                <a href={`/api/exports/${msg.id}`} className={btn("secondary")}>
                  <ArrowDownToLine aria-hidden size={16} />
                  Download CSV
                </a>
              )}
              <Button variant="primary" onClick={() => setOpen(false)}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" icon={FileSpreadsheet} disabled={!ready.length || pending} busy={pending} onClick={doExport}>
                {pending ? "Exporting" : `Export ${invoices(ready.length)}`}
              </Button>
            </>
          )
        }
      >
        {msg ? (
          <Notice tone={msg.ok ? "success" : "error"} live>
            {msg.text}
          </Notice>
        ) : (
          <div className="space-y-4">
            <div className="flex items-baseline justify-between rounded-md border border-rule bg-surface-2 px-3 py-2.5">
              <span className="font-semibold">{invoices(ready.length)}</span>
              <span className="num text-[17px] font-semibold">{sumOf(ready)}</span>
            </div>
            <ul className="divide-y divide-rule rounded-md border border-rule text-[13px]">
              {ready.map((r) => (
                <li key={r.run_id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{r.vendor ?? r.filename}</span>
                    <span className="num text-ink-3"> {r.invoice_number}</span>
                    {r.due_date && <span className="block text-[12px] text-ink-3">Due (per terms) {formatDate(r.due_date)}</span>}
                  </span>
                  <span className="num font-medium">{r.total}</span>
                </li>
              ))}
            </ul>
            {held.length > 0 && (
              <Notice tone="warn" title={`${invoices(held.length)} held back`}>
                Approved, but a later invoice with the same number disputes {held.length === 1 ? "it" : "them"}, so {held.length === 1 ? "it is" : "they are"} not exported until
                that is resolved: {held.map((r) => r.ref).join(", ")}.
              </Notice>
            )}
            {!name && <Notice tone="warn">Choose who you are acting as (in the side menu). The export records that name.</Notice>}
          </div>
        )}
      </Dialog>
    </>
  );
}

// ---- the queue

function matches(r: RunSummary, q: string): boolean {
  if (!q) return true;
  const hay = [r.vendor, r.invoice_number, r.ref, r.po_number, r.filename, r.received_from, r.total].filter(Boolean).join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

function Queue({
  view,
  runs,
  listing,
  loading,
  error,
  onChanged,
  onDrop,
  onExport,
}: {
  view: ViewId;
  runs: RunSummary[];
  listing: Listing | null;
  loading: boolean;
  error: unknown;
  onChanged: () => void;
  onDrop: (f: File | undefined) => void;
  onExport: () => void;
}) {
  const v = viewOf(view);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortId>(defaultSort(view));
  const [tier, setTier] = useState<IssueTier | null>(null);
  const [over, setOver] = useState(false);
  const inView = runs.filter(v.test);
  const tiersHere = TIER_ORDER.map((t) => ({ t, n: inView.filter((r) => r.tiers.includes(t)).length })).filter((x) => x.n > 0);
  const shown = sortRuns(
    inView.filter((r) => matches(r, q) && (!tier || r.tiers.includes(tier))),
    sort,
  );

  return (
    <section aria-labelledby="queue-h" className="rounded-lg border border-rule bg-surface">
      <h2 id="queue-h" className="sr-only">
        {v.label}
      </h2>
      <nav aria-label="Invoice views" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-rule px-2">
        {VIEWS.map((x) => {
          const n = runs.filter(x.test).length;
          const on = x.id === view;
          return (
            <Link
              key={x.id}
              href={x.id === "review" ? "/" : `/?view=${x.id}`}
              aria-current={on ? "page" : undefined}
              title={x.hint}
              className={cx(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-[13px] whitespace-nowrap",
                on ? "border-carbon font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink",
              )}
            >
              {x.label}
              <span className={cx("num rounded px-1.5 text-[12px]", on ? "bg-carbon-wash text-carbon-deep" : "bg-muted-bg text-ink-2")}>{listing ? n : "–"}</span>
            </Link>
          );
        })}
      </nav>
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2.5">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span className="sr-only">Search invoices</span>
          <Search aria-hidden size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vendor, invoice no., PO or ref" className={cx(inputCls, "h-8 pl-8 text-[13px]")} />
        </label>
        {tiersHere.length > 0 && (
          <div role="group" aria-label="Filter by kind of risk" className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-pressed={tier === null}
              onClick={() => setTier(null)}
              className={cx(
                "h-7 rounded-full border px-2.5 text-[12px] font-medium",
                tier === null ? "border-ink bg-ink text-white" : "border-rule-strong text-ink-2 hover:border-ink-3",
              )}
            >
              All
            </button>
            {tiersHere.map(({ t, n }) => (
              <button
                key={t}
                type="button"
                aria-pressed={tier === t}
                onClick={() => setTier(tier === t ? null : t)}
                className={cx(
                  "h-7 rounded-full border px-2.5 text-[12px] font-medium",
                  tier === t ? "border-ink bg-ink text-white" : "border-rule-strong text-ink-2 hover:border-ink-3",
                )}
              >
                {TIER_TEXT[t].short} <span className="num opacity-70">{n}</span>
              </button>
            ))}
          </div>
        )}
        <label className="ml-auto flex items-center gap-2 text-[12px] text-ink-2">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortId)} className="h-8 rounded-md border border-rule-strong bg-surface px-2 text-[13px] text-ink">
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {view === "approved" && listing && <ApprovedBar listing={listing} onExport={onExport} />}
      {view === "exported" && listing && listing.exports.length > 0 && <ExportHistory listing={listing} />}
      <div
        className="relative"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setOver(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setOver(false);
          onDrop(e.dataTransfer.files[0]);
        }}
      >
        {over && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-b-lg border-2 border-dashed border-carbon bg-carbon-wash/90">
            <p className="flex items-center gap-2 font-semibold text-carbon-deep">
              <Upload aria-hidden size={18} />
              Drop to add this invoice
            </p>
          </div>
        )}
        {loading ? (
          <TableSkeleton />
        ) : error && !listing ? (
          <div className="p-6">
            <Notice tone="error" title="The invoice list did not load" live>
              {errorText(error)}{" "}
              <button type="button" onClick={() => onChanged()} className="font-semibold underline">
                Try again
              </button>
            </Notice>
          </div>
        ) : (
          <RunTable view={view} runs={shown} total={inView.length} filtered={Boolean(q || tier)} onChanged={onChanged} />
        )}
      </div>
      {Boolean(error) && listing && <p className="border-t border-rule px-4 py-2 text-[12px] text-bad-fg">Showing the last loaded list: {errorText(error)}</p>}
    </section>
  );
}

function TableSkeleton() {
  return (
    <div aria-busy aria-label="Loading invoices" className="divide-y divide-rule">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-6 px-4 py-3.5">
          <div className="flex-1 space-y-2">
            <Skeleton className="w-48" />
            <Skeleton className="w-32" />
          </div>
          <Skeleton className="w-20" />
          <Skeleton className="w-24" />
          <Skeleton className="hidden w-56 md:block" />
        </div>
      ))}
    </div>
  );
}

function ApprovedBar({ listing, onExport }: { listing: Listing; onExport: () => void }) {
  const ready = listing.runs.filter(exportable);
  if (!ready.length) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-surface-2 px-4 py-2.5 text-[13px]">
      <span className="text-ink-2">
        <span className="font-semibold text-ink">{invoices(ready.length)}</span>, <span className="num font-semibold text-ink">{sumOf(ready)}</span>, ready for the payment list.
        Exporting hands the CSV to finance.
      </span>
      <ExportButton listing={listing} onExport={onExport} size="sm" />
    </div>
  );
}

function ExportHistory({ listing }: { listing: Listing }) {
  return (
    <div className="border-b border-rule px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Payment lists exported</h3>
        <a href="/api/audit" className="inline-flex items-center gap-1 text-[13px] font-semibold text-carbon-deep hover:underline">
          <ArrowDownToLine aria-hidden size={14} />
          Audit log (CSV, every event)
        </a>
      </div>
      <ul className="mt-2 divide-y divide-rule rounded-md border border-rule text-[13px]">
        {listing.exports.map((x) => {
          const rs = listing.runs.filter((r) => r.export_id === x.export_id);
          return (
            <li key={x.export_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <FileSpreadsheet aria-hidden size={15} className="shrink-0 text-carbon" />
                <span className="num font-medium">{x.export_id.slice(0, 12)}</span>
                <span className="text-ink-3">
                  {invoices(x.count)}
                  {rs.length === x.count ? `, ${sumOf(rs)}` : ""}, by {x.created_by} (demo identity), {formatTime(x.created_at)}
                </span>
              </span>
              <a href={`/api/exports/${x.export_id}`} className="inline-flex items-center gap-1 font-semibold text-carbon-deep hover:underline">
                <ArrowDownToLine aria-hidden size={14} />
                CSV<span className="sr-only"> for {x.export_id.slice(0, 12)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const EMPTY: Record<ViewId, { title: string; body: string }> = {
  review: { title: "Nothing needs a decision", body: "Invoices appear here when a check holds them or a document cannot be read." },
  cleared: { title: "No invoices waiting for approval", body: "Invoices that pass every check land here for a reviewer to approve." },
  waiting: { title: "No corrections pending", body: "When you request a correction, the invoice waits here until the vendor replies with the reference." },
  approved: { title: "Nothing approved is waiting for export", body: "Approved invoices collect here until the next payment list export." },
  exported: { title: "No payment lists exported yet", body: "Exported invoices are listed here with a link to each CSV." },
  closed: { title: "No closed invoices", body: "Rejected invoices, invoices replaced by a correction and documents that are not invoices are kept here." },
  all: { title: "No invoices yet", body: "Add one with the button above, or send a recorded vendor email from the demo inbox." },
};

function RunTable({ view, runs, total, filtered, onChanged }: { view: ViewId; runs: RunSummary[]; total: number; filtered: boolean; onChanged: () => void }) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<string | null>(null);
  const selectable = view === "cleared";
  const approvable = runs.filter((r) => !r.approve_blocked && !r.export_blocked);
  const selected = approvable.filter((r) => picked.has(r.run_id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const allOn = selected.length > 0 && selected.length === approvable.length;
  const setAll = (on: boolean) => setPicked(on ? new Set(approvable.map((r) => r.run_id)) : new Set());

  const open = (r: RunSummary) => router.push(`/runs/${r.run_id}`);
  const e = EMPTY[view];
  // Ageing and due dates are counted in India calendar days (gap 12); read once per mount.
  const [today] = useState(() => istDate());

  return (
    <div>
      {selectable && runs.length > 0 && (
        <BatchBar
          selected={selected}
          approvable={approvable.length}
          allOn={allOn}
          setAll={setAll}
          onDone={(text) => {
            setPicked(new Set());
            setDone(text);
            onChanged();
          }}
        />
      )}
      {/* Kept here, not in the batch bar, so it stays on screen when the last row has been approved. */}
      {done && (
        <div className="border-b border-rule px-4 py-2.5">
          <Notice tone="success" live>
            {done}{" "}
            <Link href="/?view=approved" className="font-semibold underline">
              See approved invoices
            </Link>
          </Notice>
        </div>
      )}
      {runs.length === 0 &&
        (filtered && total > 0 ? (
          <EmptyState icon={Search} title="No invoices match">
            {total} in this view; none match the search or filter.
          </EmptyState>
        ) : (
          <EmptyState icon={view === "review" ? Inbox : view === "exported" ? FileSpreadsheet : BadgeCheck} title={e.title}>
            {e.body}
          </EmptyState>
        ))}
      {runs.length > 0 && (
        <>
          {/* Phones: one row per invoice, stacked. */}
          <ul className="divide-y divide-rule md:hidden">
            {runs.map((r) => (
              <li key={r.run_id} className="flex gap-3 px-4 py-3">
                {selectable && (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-carbon"
                    aria-label={`Select ${r.vendor ?? r.ref}`}
                    checked={picked.has(r.run_id)}
                    disabled={r.approve_blocked || r.export_blocked}
                    onChange={(e) => toggle(r.run_id, e.target.checked)}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/runs/${r.run_id}`} className="min-w-0 break-words font-semibold text-ink hover:text-carbon-deep hover:underline">
                      {r.vendor ?? r.filename ?? "Unread document"}
                    </Link>
                    <span className="shrink-0 text-right">
                      <span className="num font-semibold">{r.total ?? <span className="font-normal text-ink-3">not read</span>}</span>
                      <DueNote r={r} today={today} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-2">
                    <InvoiceLine r={r} />
                    <StateChip tone={r.tone} label={r.state_label} short={SHORT_STATE[r.state]} exported={r.exported} size="sm" />
                  </div>
                  <div className="mt-1.5 text-[13px]">
                    <NextStep r={r} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[46rem] text-left text-[13px]">
              <thead className="border-b border-rule bg-surface-2 text-[12px] text-ink-2">
                <tr>
                  {selectable && (
                    <th scope="col" className="w-10 py-2 pr-1 pl-4">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-carbon"
                        aria-label="Select every approvable invoice"
                        checked={allOn}
                        onChange={(e) => setAll(e.target.checked)}
                        disabled={!approvable.length}
                      />
                    </th>
                  )}
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Invoice
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">
                    Amount
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Status <span className="font-normal text-ink-3">and checks</span>
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    {view === "review" || view === "waiting" ? "Why it is held" : "Next"}
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-semibold xl:table-cell">
                    Received
                  </th>
                  <th scope="col" className="w-8 px-2 py-2">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.run_id}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button,input,label")) return;
                      open(r);
                    }}
                    className={cx("cursor-pointer border-b border-rule align-top last:border-b-0 hover:bg-surface-2", picked.has(r.run_id) && "bg-carbon-wash/50")}
                  >
                    {selectable && (
                      <td className="py-3 pr-1 pl-4">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-carbon"
                          aria-label={`Select ${r.vendor ?? r.ref}`}
                          checked={picked.has(r.run_id)}
                          disabled={r.approve_blocked || r.export_blocked}
                          title={r.approve_blocked ? "Looks like a repeat of a payable invoice: open it to decide" : r.export_blocked ? "Disputed by a later invoice" : undefined}
                          onChange={(e) => toggle(r.run_id, e.target.checked)}
                        />
                      </td>
                    )}
                    <td className="max-w-[22rem] px-4 py-3">
                      <Link href={`/runs/${r.run_id}`} className="font-semibold text-ink hover:text-carbon-deep hover:underline">
                        {r.vendor ?? r.filename ?? "Unread document"}
                      </Link>
                      <VendorNote r={r} />
                      <div className="mt-0.5 text-ink-2">
                        <InvoiceLine r={r} />
                      </div>
                    </td>
                    <td className="num px-4 py-3 text-right font-semibold whitespace-nowrap">
                      {r.total ?? <span className="font-normal text-ink-3">not read</span>}
                      <DueNote r={r} today={today} />
                    </td>
                    <td className="px-4 py-3">
                      <StateChip tone={r.tone} label={r.state_label} short={SHORT_STATE[r.state]} exported={r.exported} size="sm" />
                      <div className="mt-2">
                        <SlipStrip slip={r.slip} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <NextStep r={r} />
                    </td>
                    <td className="hidden px-4 py-3 whitespace-nowrap text-ink-2 xl:table-cell">
                      <span className="flex items-center gap-1.5">
                        {r.source === "email" ? <Mail aria-hidden size={13} className="text-ink-3" /> : <UserRound aria-hidden size={13} className="text-ink-3" />}
                        {formatTime(r.created_at)}
                        <Age r={r} today={today} />
                      </span>
                      <span className="block max-w-[12rem] truncate text-[12px] text-ink-3" title={r.received_from ?? undefined}>
                        {r.source === "email" ? r.received_from : `${r.received_from} (demo identity)`}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-ink-3">
                      <ChevronRight aria-hidden size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <SlipLegend />
        </>
      )}
    </div>
  );
}

function BatchBar({
  selected,
  approvable,
  allOn,
  setAll,
  onDone,
}: {
  selected: RunSummary[];
  approvable: number;
  allOn: boolean;
  setAll: (on: boolean) => void;
  onDone: (text: string) => void;
}) {
  const { name } = useIdentity();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function approve() {
    if (!name) return setMsg({ ok: false, text: "Choose who you are acting as (in the side menu) before approving." });
    setPending(true);
    try {
      const r = await api.approveBatch(
        selected.map((s) => s.run_id),
        name,
        Object.fromEntries(selected.map((s) => [s.run_id, s.version])),
      );
      setMsg(null);
      setOpen(false);
      onDone(`Approved ${invoices(r.count)} for the payment list as one batch.`);
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className={cx("flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-2.5 text-[13px]", selected.length ? "bg-carbon-wash/60" : "bg-surface-2")}>
        <label className="flex items-center gap-2 text-ink-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-carbon md:hidden"
            aria-label="Select every approvable invoice"
            checked={allOn}
            onChange={(e) => setAll(e.target.checked)}
            disabled={!approvable}
          />
          {selected.length ? (
            <span>
              <span className="font-semibold text-ink">{selected.length} selected</span>, <span className="num font-semibold text-ink">{sumOf(selected)}</span>
            </span>
          ) : (
            "Select cleared invoices to approve them together"
          )}
        </label>
        <Button
          variant="approve"
          size="sm"
          icon={BadgeCheck}
          disabled={!selected.length}
          onClick={() => {
            setMsg(null);
            setOpen(true);
          }}
        >
          Approve selected
        </Button>
      </div>
      {msg && (
        <div className="border-b border-rule px-4 py-2">
          <Notice tone={msg.ok ? "success" : "error"} live>
            {msg.text}
          </Notice>
        </div>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Approve ${invoices(selected.length)} for the payment list`}
        description="Each one passed every check. Approving puts them on the next payment list export; finance pays from that list, not this tool."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="approve" icon={BadgeCheck} disabled={pending || !selected.length} busy={pending} onClick={approve}>
              {pending ? "Approving" : `Approve ${sumOf(selected)}`}
            </Button>
          </>
        }
      >
        <ul className="divide-y divide-rule rounded-md border border-rule text-[13px]">
          {selected.map((r) => (
            <li key={r.run_id} className="flex items-baseline justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="font-medium">{r.vendor ?? r.filename}</span>
                <span className="num text-ink-3"> {r.invoice_number}</span>
              </span>
              <span className="num font-medium">{r.total}</span>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 bg-surface-2 px-3 py-2 font-semibold">
            <span>Total</span>
            <span className="num">{sumOf(selected)}</span>
          </li>
        </ul>
        {msg && !msg.ok && (
          <Notice tone="error" live className="mt-3">
            {msg.text}
          </Notice>
        )}
        <p className="mt-3 text-[12px] text-ink-3">Recorded as one batch approval by {name || "(no name chosen)"} (demo identity).</p>
      </Dialog>
    </>
  );
}

/** The due date (per terms) as a distance from today, while the invoice still waits for payment (gap 12). */
function DueNote({ r, today }: { r: RunSummary; today: string }) {
  const days = dueInDays(r, today);
  if (days == null) return null;
  const { text, tone } = dueText(days);
  return (
    <span
      title={`Due (per terms) ${formatDate(r.due_per_terms)}`}
      className={cx("block text-[12px]", tone === "overdue" ? "font-semibold text-bad-fg" : tone === "soon" ? "font-medium text-hold-fg" : "font-normal text-ink-3")}
    >
      {text}
    </span>
  );
}

/** How long ago it arrived, from the day after it arrived ("2 days ago"). */
function Age({ r, today }: { r: RunSummary; today: string }) {
  const text = ageText(istDate(new Date(r.created_at)), today);
  return text === "today" ? null : <span className="text-ink-3">· {text}</span>;
}

function InvoiceLine({ r }: { r: RunSummary }) {
  return (
    <span>
      {r.invoice_number ? <span className="num">{r.invoice_number}</span> : <span className="text-ink-3">no number read</span>}
      {r.invoice_date && <span className="text-ink-3"> · {formatDate(r.invoice_date)}</span>}
      <span className="num text-ink-3"> · {r.ref}</span>
    </span>
  );
}

/** "Not in vendor master" only when the vendor check ran; a skipped document was never checked. */
function VendorNote({ r }: { r: RunSummary }) {
  if (!r.vendor || r.vendor_known) return null;
  return r.vendor_checked ? (
    <span className="ml-2 text-[12px] font-medium text-bad-fg">not in vendor master</span>
  ) : (
    <span className="ml-2 text-[12px] text-ink-3">vendor not checked</span>
  );
}

/** What the invoice needs next, or why it is where it is, in a line. */
function NextStep({ r }: { r: RunSummary }) {
  if (isReading(r)) return <span className="text-carbon-deep">Reading the document</span>;
  if (r.state === "SUPERSEDED") return <span className="text-ink-2">Replaced by the vendor&apos;s corrected invoice</span>;
  if (r.approve_blocked) return <span className="font-medium text-bad-fg">Looks like a repeat of a payable invoice; open it to decide</span>;
  if (r.state === "CLEARED")
    return <span className="text-ink-2">{r.export_blocked ? "Disputed by a later invoice" : "Every check passed; approve to add it to the payment list"}</span>;
  if (r.state === "APPROVED") {
    if (r.exported)
      return (
        <span className="text-ink-2">
          On payment list <span className="num">{r.export_id?.slice(0, 12)}</span>
        </span>
      );
    return (
      <span className="text-ink-2">
        {r.export_blocked
          ? "Held back from export by a dispute"
          : r.due_date
            ? `Due (per terms) ${formatDate(r.due_date)}; goes out with the next export`
            : "Goes out with the next export"}
      </span>
    );
  }
  if (r.primary) {
    return (
      <span className="block">
        {r.tiers[0] && <TierBadge tier={r.tiers[0]} short className="mb-1" />}
        <span className="block text-ink">
          {r.primary.title}
          {r.blocking_count > 1 && <span className="text-ink-3"> and {r.blocking_count - 1} more</span>}
        </span>
      </span>
    );
  }
  return null;
}

function SlipLegend() {
  return (
    <p className="hidden flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule px-4 py-2 text-[12px] text-ink-3 md:flex">
      <span>Checks, left to right: reading, eight code checks, the reviewer.</span>
      <span className="flex items-center gap-1">
        <SlipSwatch status="passed" /> passed
      </span>
      <span className="flex items-center gap-1">
        <SlipSwatch status="held" /> held
      </span>
      <span className="flex items-center gap-1">
        <SlipSwatch status="not_reached" /> not reached
      </span>
      <span className="flex items-center gap-1">
        <SlipSwatch status="waiting" /> waiting for a reviewer
      </span>
      <span className="flex items-center gap-1">
        <SlipSwatch status="done" /> decided
      </span>
    </p>
  );
}
