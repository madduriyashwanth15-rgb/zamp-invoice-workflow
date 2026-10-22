"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { RunSummary } from "@/server/views";
import { formatDate, formatInr, formatTime, sumRupees } from "@/lib/format";
import { api, errorText, type Listing } from "./api";
import { SlipStrip, SlipSwatch, StateChip } from "./chips";
import { useIdentity } from "./identity";
import { usePoll } from "./use-poll";

// The AP desk: upload, the queue split by what each invoice needs next, batch approval and the payment list.

type FilterId = "review" | "waiting" | "cleared" | "approved" | "exported" | "closed" | "all";

const FILTERS: { id: FilterId; label: string; hint: string; test: (r: RunSummary) => boolean }[] = [
  { id: "review", label: "Needs a decision", hint: "On hold or could not be read", test: (r) => r.state === "ON_HOLD" || r.state === "FAILED" || r.state === "RECEIVED" || r.state === "PROCESSING" },
  { id: "waiting", label: "Waiting for vendor", hint: "Correction requested", test: (r) => r.state === "AWAITING_VENDOR" },
  { id: "cleared", label: "Cleared by checks", hint: "Every check passed; not yet approved", test: (r) => r.state === "CLEARED" },
  { id: "approved", label: "Approved", hint: "On the next payment list", test: (r) => r.state === "APPROVED" && !r.exported },
  { id: "exported", label: "Exported", hint: "Handed to finance", test: (r) => r.exported },
  { id: "closed", label: "Closed", hint: "Rejected, replaced or skipped", test: (r) => r.state === "REJECTED" || r.state === "SUPERSEDED" || r.state === "SKIPPED" },
  { id: "all", label: "All", hint: "Every invoice received", test: () => true },
];

const busy = (l: Listing | null) => Boolean(l?.runs.some((r) => r.state === "RECEIVED" || r.state === "PROCESSING"));

export function Desk() {
  // Idle: every 5 s, so an emailed invoice shows up quickly; while anything is being read: every 2 s.
  const { data, error, loading, refresh } = usePoll(api.list, (d) => (busy(d) ? 2000 : 5000));
  const [filter, setFilter] = useState<FilterId>("review");
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const shown = runs.filter(FILTERS.find((f) => f.id === filter)!.test);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-labelledby="queue-h" className="min-w-0">
        <h1 id="queue-h" className="text-[2rem] font-[780] leading-tight tracking-[-0.015em]">Invoices</h1>
        <Ledger runs={runs} loaded={Boolean(data)} />
        <Upload onUploaded={refresh} />
        <nav aria-label="Filter invoices" className="mt-6 flex flex-wrap gap-1 border-b border-rule">
          {FILTERS.map((f) => {
            const n = runs.filter(f.test).length;
            const on = f.id === filter;
            return (
              <button
                key={f.id}
                type="button"
                title={f.hint}
                aria-pressed={on}
                onClick={() => setFilter(f.id)}
                className={`-mb-px rounded-t-md border px-3 py-2 text-sm ${on ? "border-rule border-b-surface bg-surface font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                {f.label} <span className="num ml-1 text-ink-3">{n}</span>
              </button>
            );
          })}
        </nav>
        <div className="rounded-b-md border border-t-0 border-rule bg-surface">
          {loading && !data ? (
            <p className="px-4 py-10 text-center text-ink-2">Loading invoices</p>
          ) : error && !data ? (
            <div className="px-4 py-10 text-center">
              <p className="text-bad-fg">{errorText(error)}</p>
              <button type="button" onClick={() => refresh()} className="mt-3 rounded-md border border-rule-strong px-3 py-1.5 text-sm hover:bg-paper">
                Try again
              </button>
            </div>
          ) : (
            <RunTable key={filter} runs={shown} filter={filter} onChanged={refresh} />
          )}
        </div>
        {error && data ? <p className="mt-2 text-sm text-bad-fg">Showing the last loaded list: {errorText(error)}</p> : null}
      </section>
      <aside className="space-y-6">
        <PaymentList listing={data} onChanged={refresh} />
        <HowItWorks />
      </aside>
    </div>
  );
}

/** The desk in one sentence, from the runs themselves: what needs a person, and what is ready for finance. */
function Ledger({ runs, loaded }: { runs: RunSummary[]; loaded: boolean }) {
  if (!loaded) return <p className="mt-2 mb-6 text-[1.1875rem] text-ink-3">Counting the desk</p>;
  const group = (test: (r: RunSummary) => boolean) => {
    const rs = runs.filter(test);
    return { n: rs.length, sum: formatInr(sumRupees(rs.map((r) => r.total_rupees))), unread: rs.some((r) => r.total_rupees == null) };
  };
  const review = group((r) => r.state === "ON_HOLD" || r.state === "FAILED");
  const reading = runs.filter((r) => r.state === "RECEIVED" || r.state === "PROCESSING").length;
  const cleared = group((r) => r.state === "CLEARED");
  const ready = group((r) => r.state === "APPROVED" && !r.exported && !r.export_blocked);
  const waiting = group((r) => r.state === "AWAITING_VENDOR");
  const amount = (g: ReturnType<typeof group>) => (
    <span className="num font-semibold text-ink">
      {g.sum}
      {g.unread ? " and some totals not read" : ""}
    </span>
  );
  const invoices = (n: number) => `${n} invoice${n === 1 ? "" : "s"}`;
  const parts: React.ReactNode[] = [];
  if (review.n) parts.push(<span key="r"><span className="font-semibold text-ink">{invoices(review.n)}</span> need{review.n === 1 ? "s" : ""} a decision, {amount(review)} in all.</span>);
  if (cleared.n) parts.push(<span key="c"> {cleared.n} cleared by the checks, {amount(cleared)}, wait{cleared.n === 1 ? "s" : ""} for approval.</span>);
  if (ready.n) parts.push(<span key="a"> {ready.n} approved, {amount(ready)}, {ready.n === 1 ? "is" : "are"} ready for the payment list.</span>);
  if (reading) parts.push(<span key="p"> {reading} {reading === 1 ? "is" : "are"} being read.</span>);
  if (waiting.n) parts.push(<span key="w"> {waiting.n} {waiting.n === 1 ? "is" : "are"} waiting for a vendor&apos;s correction.</span>);
  return (
    <p className="mt-2 mb-6 max-w-[62ch] text-[1.1875rem] leading-snug text-ink-2">
      {parts.length ? parts : runs.length ? "Nothing needs a person right now." : "No invoices yet. Add one below, or send one from Demo emails."}
    </p>
  );
}

function Upload({ onUploaded }: { onUploaded: () => void }) {
  const { name } = useIdentity();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending"; file: string } | { kind: "error"; text: string }>({ kind: "idle" });
  const [over, setOver] = useState(false);

  async function send(file: File | undefined) {
    if (!file) return;
    if (!name) {
      setState({ kind: "error", text: "Choose who you are acting as (top right) before uploading." });
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

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        send(e.dataTransfer.files[0]);
      }}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border-2 border-dashed px-4 py-4 ${over ? "border-carbon bg-carbon-wash" : "border-rule-strong bg-surface"}`}
    >
      <div>
        <p className="font-semibold">Add an invoice</p>
        <p className="text-sm text-ink-2">
          Drop a PDF, PNG or JPEG here (up to 4 MB). Vendors can also email invoices in; both are checked the same way.
        </p>
        {state.kind === "sending" && <p className="mt-1 text-sm text-carbon-deep">Uploading {state.file}</p>}
        {state.kind === "error" && (
          <p role="alert" className="mt-1 text-sm text-bad-fg">
            {state.text}
          </p>
        )}
      </div>
      <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" onChange={(e) => send(e.target.files?.[0] ?? undefined)} />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={state.kind === "sending"}
        className="rounded-md bg-carbon px-4 py-2 text-sm font-semibold text-white hover:bg-carbon-deep disabled:opacity-60"
      >
        Choose file
      </button>
    </div>
  );
}

function RunTable({ runs, filter, onChanged }: { runs: RunSummary[]; filter: FilterId; onChanged: () => void }) {
  const { name } = useIdentity();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const selectable = filter === "cleared";
  const approvable = runs.filter((r) => !r.approve_blocked && !r.export_blocked);
  const selected = approvable.filter((r) => picked.has(r.run_id));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  if (runs.length === 0) {
    const empty: Record<FilterId, string> = {
      review: "Nothing needs a decision. New invoices appear here when a check holds them.",
      waiting: "No corrections are pending with vendors.",
      cleared: "No invoices are waiting for approval.",
      approved: "Nothing approved is waiting for export.",
      exported: "No payment lists exported yet.",
      closed: "No rejected, replaced or skipped invoices.",
      all: "No invoices yet. Upload one above to see every check it goes through.",
    };
    return (
      <div>
        {msg && (
          <p role="status" className={`border-b border-rule px-4 py-2 text-sm ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>
            {msg.text}
          </p>
        )}
        <p className="px-4 py-10 text-center text-ink-2">{empty[filter]}</p>
      </div>
    );
  }

  async function approveSelected() {
    if (!name) return setMsg({ ok: false, text: "Choose who you are acting as before approving." });
    try {
      const r = await api.approveBatch(selected.map((s) => s.run_id), name, Object.fromEntries(selected.map((s) => [s.run_id, s.version])));
      setMsg({ ok: true, text: `Approved ${r.count} invoice${r.count === 1 ? "" : "s"} for the payment list as one batch.` });
      setPicked(new Set());
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <div>
      {selectable && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-2">
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              className="h-4 w-4 md:hidden"
              aria-label="Select all cleared invoices"
              checked={selected.length > 0 && selected.length === approvable.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(approvable.map((r) => r.run_id)) : new Set())}
            />
            {selected.length ? `${selected.length} selected` : "Select cleared invoices to approve them together"}
          </label>
          <button
            type="button"
            disabled={!selected.length}
            onClick={approveSelected}
            className="rounded-md bg-approved-bg px-3 py-1.5 text-sm font-semibold text-approved-fg disabled:opacity-40"
          >
            Approve selected for payment list
          </button>
        </div>
      )}
      {msg && (
        <p role="status" className={`border-b border-rule px-4 py-2 text-sm ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>
          {msg.text}
        </p>
      )}
      {/* Phones: one card per invoice instead of the wide table. */}
      <ul className="divide-y divide-rule md:hidden">
        {runs.map((r) => (
          <li key={r.run_id} className="flex gap-3 px-4 py-3">
            {selectable && (
              <input
                type="checkbox"
                className="mt-1.5 h-4 w-4 shrink-0"
                aria-label={`Select ${r.vendor ?? r.ref}`}
                checked={picked.has(r.run_id)}
                disabled={r.approve_blocked || r.export_blocked}
                title={r.approve_blocked ? "Looks like a repeat of a payable invoice: open it to decide" : undefined}
                onChange={(e) => toggle(r.run_id, e.target.checked)}
              />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/runs/${r.run_id}`} className="break-words font-semibold text-ink hover:text-carbon-deep hover:underline">
                    {r.vendor ?? r.filename ?? "Unread document"}
                  </Link>
                  <VendorNote r={r} />
                </div>
                <span className="num shrink-0 font-semibold">{r.total ?? <span className="font-normal text-ink-3">not read</span>}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-2">
                <span>
                  {r.invoice_number ? <span className="num">{r.invoice_number}</span> : <span className="text-ink-3">no number read</span>}
                  {r.invoice_date && <span className="text-ink-3">, {formatDate(r.invoice_date)}</span>}
                </span>
                <StateChip tone={r.tone} label={r.state_label} exported={r.exported} />
              </div>
              <SlipStrip slip={r.slip} />
              <p className="text-sm text-ink-2">
                <Why r={r} />
                {r.export_blocked && <span className="block text-xs text-bad-fg">Export blocked</span>}
              </p>
              <p className="truncate text-xs text-ink-3">
                <span className="num">{r.ref}</span>, {r.source === "email" ? `emailed by ${r.received_from}` : `uploaded by ${r.received_from} (demo identity)`}, {formatTime(r.created_at)}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <thead className="border-b border-rule text-ink-2">
            <tr>
              {selectable && (
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all cleared invoices"
                    checked={selected.length > 0 && selected.length === approvable.length}
                    onChange={(e) => setPicked(e.target.checked ? new Set(approvable.map((r) => r.run_id)) : new Set())}
                  />
                </th>
              )}
              <th className="px-4 py-2.5 font-semibold">Vendor and invoice</th>
              <th className="px-4 py-2.5 text-right font-semibold">Total</th>
              <th className="px-4 py-2.5 font-semibold" title="The routing slip: reading, the eight checks, then the reviewer">Status and routing slip</th>
              <th className="px-4 py-2.5 font-semibold">Why</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.run_id} className="border-b border-rule last:border-b-0 hover:bg-paper">
                {selectable && (
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.vendor ?? r.ref}`}
                      checked={picked.has(r.run_id)}
                      disabled={r.approve_blocked || r.export_blocked}
                      title={r.approve_blocked ? "Looks like a repeat of a payable invoice: open it to decide" : undefined}
                      onChange={(e) => toggle(r.run_id, e.target.checked)}
                    />
                  </td>
                )}
                <td className="px-4 py-3 align-top">
                  <Link href={`/runs/${r.run_id}`} className="font-semibold text-ink hover:text-carbon-deep hover:underline">
                    {r.vendor ?? r.filename ?? "Unread document"}
                  </Link>
                  <VendorNote r={r} />
                  <div className="whitespace-nowrap text-ink-2">
                    {r.invoice_number ? <span className="num">{r.invoice_number}</span> : <span className="text-ink-3">no number read</span>}
                    {r.invoice_date && <span className="text-ink-3">, {formatDate(r.invoice_date)}</span>}
                  </div>
                  <div className="mt-0.5 max-w-[22rem] truncate text-xs text-ink-3" title={r.received_from ?? undefined}>
                    <span className="num">{r.ref}</span>, {r.source === "email" ? `emailed by ${r.received_from}` : `uploaded by ${r.received_from} (demo identity)`}, {formatTime(r.created_at)}
                  </div>
                </td>
                <td className="num px-4 py-3 text-right align-top font-semibold whitespace-nowrap">{r.total ?? <span className="font-normal text-ink-3">not read</span>}</td>
                <td className="px-4 py-3 align-top">
                  <StateChip tone={r.tone} label={r.state_label} exported={r.exported} />
                  {r.export_blocked && <div className="mt-1 text-xs text-bad-fg">Export blocked</div>}
                  <div className="mt-2">
                    <SlipStrip slip={r.slip} />
                  </div>
                </td>
                <td className="px-4 py-3 align-top text-ink-2">
                  <Why r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** "Not in vendor master" only when the vendor check ran; a skipped document was never checked. */
function VendorNote({ r }: { r: RunSummary }) {
  if (!r.vendor || r.vendor_known) return null;
  return r.vendor_checked
    ? <span className="ml-2 text-xs text-hold-fg">not in vendor master</span>
    : <span className="ml-2 text-xs text-ink-3">vendor not checked</span>;
}

/** The one-line reason shown in the list: what the invoice needs, or why it is where it is. */
function Why({ r }: { r: RunSummary }) {
  if (r.state === "PROCESSING" || r.state === "RECEIVED") return <span className="text-carbon-deep">Reading the document</span>;
  if (r.state === "SUPERSEDED") return <span>Replaced by the vendor&apos;s corrected invoice</span>;
  if (r.approve_blocked) return <span className="text-hold-fg">Looks like a repeat of a payable invoice: open it to decide</span>;
  if (r.primary) {
    return (
      <>
        {r.primary.title}
        {r.blocking_count > 1 && <span className="text-ink-3"> and {r.blocking_count - 1} more</span>}
      </>
    );
  }
  if (r.due_date) return <span>Due (per terms) {formatDate(r.due_date)}</span>;
  return null;
}

function PaymentList({ listing, onChanged }: { listing: Listing | null; onChanged: () => void }) {
  const { name } = useIdentity();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = listing?.runs.filter((r) => r.state === "APPROVED" && !r.exported && !r.export_blocked) ?? [];
  const blocked = listing?.runs.filter((r) => r.state === "APPROVED" && !r.exported && r.export_blocked) ?? [];

  async function doExport() {
    if (!name) return setMsg({ ok: false, text: "Choose who you are acting as before exporting." });
    try {
      const r = await api.exportNow(name);
      setMsg({ ok: true, text: `Exported ${r.count} invoice${r.count === 1 ? "" : "s"} to payment list ${r.export_id}.` });
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <section aria-labelledby="pay-h" className="rounded-md border border-rule bg-surface p-4">
      <h2 id="pay-h" className="text-lg font-bold">Payment list</h2>
      <p className="mt-1 text-sm text-ink-2">
        Approved invoices go to finance as a CSV. Paying them happens in finance&apos;s own process, not here.
      </p>
      <p className="num mt-3 text-sm">
        <span className="font-semibold">{ready.length}</span> approved and ready
        {blocked.length > 0 && <span className="text-bad-fg">, {blocked.length} blocked by a dispute</span>}
      </p>
      <button
        type="button"
        onClick={doExport}
        disabled={!ready.length}
        className="mt-3 w-full rounded-md bg-carbon px-3 py-2 text-sm font-semibold text-white hover:bg-carbon-deep disabled:opacity-40"
      >
        Export payment list
      </button>
      {msg && (
        <p role="status" className={`mt-2 text-sm ${msg.ok ? "text-ok-fg" : "text-bad-fg"}`}>
          {msg.text}
        </p>
      )}
      {listing && listing.exports.length > 0 && (
        <div className="mt-4 border-t border-rule pt-3">
          <h3 className="text-sm font-semibold text-ink-2">Exported lists</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {listing.exports.map((x) => (
              <li key={x.export_id} className="flex items-baseline justify-between gap-2">
                <span>
                  <a href={`/api/exports/${x.export_id}`} className="text-carbon-deep underline">
                    {x.export_id.slice(0, 12)}
                  </a>
                  <span className="text-ink-3">
                    {" "}
                    {x.count} by {x.created_by} (demo identity)
                  </span>
                </span>
                <span className="text-xs text-ink-3">{formatTime(x.created_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const Legend = SlipSwatch;

function HowItWorks() {
  return (
    <section aria-labelledby="how-h" className="rounded-md border border-rule bg-surface p-4 text-sm text-ink-2">
      <h2 id="how-h" className="text-base font-bold text-ink">How a decision is made</h2>
      <p className="mt-2">
        The reader (an AI model; the MOCK answer key on a test setup) only reads the document. Code then checks every
        value against the PDF text, the vendor master and the purchase order, and decides. Nothing reaches the payment
        list without a person approving it.
      </p>
      <p className="mt-3">
        Each invoice&apos;s routing slip shows the reading, the eight checks and the reviewer, in order:{" "}
        <Legend status="passed" /> passed, <Legend status="held" /> held, <Legend status="not_reached" /> not reached, and{" "}
        <Legend status="waiting" /> waiting for a reviewer.
      </p>
    </section>
  );
}
