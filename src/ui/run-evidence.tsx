"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Check, ChevronDown, CircleAlert, ExternalLink, FileText, Minus, ScanLine, ShieldCheck, User, X } from "lucide-react";
import type { FindingView, PoTableView, RunDetail, StageView } from "@/server/views";
import { formatDate, formatInr, formatSeconds, formatTime } from "@/lib/format";
import { CODE_TEXT, STATE_TEXT } from "@/lib/reason-text";
import { readerLabel } from "@/lib/reader-label";
import { SHORT_STATE, StateChip } from "./chips";
import { Absent, Panel, SourceTag, cx } from "./kit";

// The evidence behind a decision: the invoice against its PO, every check in order, the document beside what was
// read from it, related invoices and the full history. Read-only.

export const inFlight = (r: RunDetail | null) => r?.state === "RECEIVED" || r?.state === "PROCESSING";

/** Who read the document, as a provenance tag: an AI model, the MOCK answer key, or not read. */
export function readerSource(run: RunDetail): "ai" | "mock" | null {
  const label = run.extracted_by?.extractor ?? "";
  return /gemini/i.test(label) ? "ai" : /mock/i.test(label) ? "mock" : null;
}

// ---- invoice against the PO

export function PoComparison({ table }: { table: PoTableView }) {
  const flagged = table.rows.filter((r) => r.flags.length).length;
  return (
    <Panel
      title={
        <>
          Invoice against <span className="num">{table.po_number}</span>
        </>
      }
      description={
        <>
          {table.how_found}
          {table.po_value ? `. PO value ${table.po_value}` : ""}
          {table.po_status && table.po_status !== "open" ? ` (${table.po_status})` : ""}. Prices compared before GST, per PO unit.
        </>
      }
      actions={
        <span className={cx("rounded px-2 py-0.5 text-[12px] font-semibold", flagged ? "bg-hold-bg text-hold-fg" : "bg-ok-bg text-ok-fg")}>
          {flagged
            ? `${flagged} of ${table.rows.length} line${table.rows.length === 1 ? "" : "s"} ${flagged === 1 ? "differs" : "differ"}`
            : table.rows.length === 1
              ? "The line matches"
              : `All ${table.rows.length} lines match`}
        </span>
      }
      flush
    >
      {/* Narrow columns and phones: one block per line; the full table when the panel is wide enough for it. */}
      <div className="@container">
        <ul className="divide-y divide-rule @3xl:hidden">
          {table.rows.map((r) => (
            <li key={r.invoice_line} className={cx("px-4 py-3 text-[13px]", r.flags.length > 0 && "border-l-4 border-l-hold-edge bg-hold-bg/40")}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 break-words font-semibold">
                  <span className="num mr-1 text-ink-3">{r.invoice_line}</span>
                  {r.description}
                </p>
                <RowStatus r={r} />
              </div>
              <dl className="num mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ink-2">
                <dt className="text-ink-3">Billed</dt>
                <dd>
                  {r.billed} = {r.amount}
                </dd>
                {r.po_line && (
                  <>
                    <dt className="text-ink-3">PO line</dt>
                    <dd className="break-words">{r.po_line}</dd>
                  </>
                )}
                {r.po_price && (
                  <>
                    <dt className="text-ink-3">Price</dt>
                    <dd>
                      {r.invoice_price} vs {r.po_price} {r.price_diff && <Variance r={r} />}
                    </dd>
                  </>
                )}
                {r.quantity && (
                  <>
                    <dt className="text-ink-3">Quantity</dt>
                    <dd className={r.flags.includes("Quantity over") ? "font-semibold text-hold-fg" : ""}>{r.quantity}</dd>
                  </>
                )}
              </dl>
              {r.matched_by && <p className="mt-1 text-[12px] text-graphite">{r.matched_by}</p>}
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto @3xl:block">
          <table className="w-full text-[13px]">
            <thead className="border-b border-rule bg-surface-2 text-left text-[12px] text-ink-2">
              <tr>
                <th scope="col" className="py-2 pr-3 pl-4 font-semibold">
                  Invoice line
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  Billed
                </th>
                <th scope="col" className="py-2 pr-3 font-semibold">
                  PO line
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  Invoice price
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  PO price
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  Difference
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  Quantity
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.invoice_line} className={cx("border-b border-rule align-top last:border-b-0", r.flags.length > 0 && "bg-hold-bg/45")}>
                  <td className={cx("py-2.5 pr-3 pl-4", r.flags.length > 0 && "border-l-4 border-l-hold-edge pl-3")}>
                    <span className="num mr-1 text-ink-3">{r.invoice_line}</span>
                    {r.description}
                    {r.matched_by && <span className="mt-0.5 block text-[12px] text-graphite">{r.matched_by}</span>}
                  </td>
                  <td className="num py-2.5 pr-3 text-right whitespace-nowrap">
                    {r.billed}
                    <span className="block text-ink-3">{r.amount}</span>
                  </td>
                  <td className="py-2.5 pr-3">{r.po_line ?? <Absent>none</Absent>}</td>
                  <td className={cx("num py-2.5 pr-3 text-right whitespace-nowrap", r.flags.includes("Price over") && "font-semibold text-hold-fg")}>
                    {r.invoice_price ?? <Absent>not compared</Absent>}
                  </td>
                  <td className="num py-2.5 pr-3 text-right whitespace-nowrap">{r.po_price ?? <Absent>none</Absent>}</td>
                  <td className="num py-2.5 pr-3 text-right whitespace-nowrap">{r.price_diff ? <Variance r={r} /> : <Absent>–</Absent>}</td>
                  <td className={cx("num py-2.5 pr-3 text-right", r.flags.includes("Quantity over") && "font-semibold text-hold-fg")}>
                    {r.quantity ?? <Absent>not compared</Absent>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <RowStatus r={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function Variance({ r }: { r: PoTableView["rows"][number] }) {
  const over = r.flags.includes("Price over");
  const zero = r.price_diff === "0%";
  return <span className={cx("rounded px-1 font-semibold", over ? "bg-hold-edge/40 text-hold-fg" : zero ? "font-normal text-ink-3" : "text-ink-2")}>{r.price_diff}</span>;
}

function RowStatus({ r }: { r: PoTableView["rows"][number] }) {
  if (r.flags.length)
    return (
      <span className="inline-flex items-start gap-1 text-[13px] font-semibold text-hold-fg">
        <CircleAlert aria-hidden size={14} className="mt-0.5 shrink-0" />
        {r.flags.join("; ")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[13px] text-ok-fg">
      <Check aria-hidden size={14} />
      {r.ok_text ?? "Not compared"}
    </span>
  );
}

// ---- the routing slip: every check in order

const STATUS_MARK: Record<StageView["status"], { text: string; cls: string }> = {
  passed: { text: "Passed", cls: "text-ok-fg" },
  held: { text: "Held", cls: "text-hold-fg font-semibold" },
  rejected: { text: "Rejected", cls: "text-bad-fg font-semibold" },
  skipped: { text: "Skipped", cls: "text-muted-fg" },
  not_evaluated: { text: "Not reached", cls: "text-ink-3" },
  running: { text: "Running", cls: "text-carbon-deep font-semibold" },
  pending: { text: "Waiting", cls: "text-ink-3" },
  failed: { text: "Failed", cls: "text-bad-fg font-semibold" },
  awaiting_review: { text: "Waiting for a reviewer", cls: "text-wait-fg font-semibold" },
  reviewed: { text: "Done", cls: "text-ink font-semibold" },
  not_needed: { text: "No action needed", cls: "text-ink-3" },
};

const MARK_CLS: Record<StageView["status"], string> = {
  passed: "bg-stamp-ok text-white",
  held: "bg-hold-edge text-hold-fg",
  rejected: "bg-bad-fg text-white",
  skipped: "bg-muted-edge text-muted-fg",
  not_evaluated: "border-2 border-dashed border-rule-strong bg-surface text-ink-3",
  running: "bg-carbon text-white slip-running",
  pending: "border-2 border-rule-strong bg-surface text-ink-3",
  failed: "bg-bad-fg text-white",
  awaiting_review: "border-2 border-carbon bg-surface text-carbon",
  reviewed: "bg-approved-bg text-approved-fg",
  not_needed: "border-2 border-rule-strong bg-surface text-ink-3",
};

/** The mark on the rail: a tick, a stop, a cross, or an empty ring for a step not reached or still to come. */
function StageMark({ status, ai }: { status: StageView["status"]; ai: boolean }) {
  const I =
    status === "passed" || status === "reviewed" ? Check : status === "held" ? CircleAlert : status === "rejected" || status === "failed" ? X : status === "skipped" ? Minus : null;
  return (
    <span
      aria-hidden
      className={cx(
        "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        MARK_CLS[status],
        ai && "outline-2 outline-offset-2 outline-dashed outline-graphite",
      )}
    >
      {I && <I size={13} strokeWidth={2.6} />}
    </span>
  );
}

const EXPECTED = [
  "Is it an invoice?",
  "Does the document hold together?",
  "Vendor, sender and bank details",
  "Duplicates and corrections",
  "Which purchase order?",
  "Lines matched to the PO",
  "Prices and quantities against the PO",
  "Decision",
  "Reviewer decision",
];

/** Gap 16: the durations measured on this run, as recorded. A MOCK lookup's time is not shown: it means nothing. */
function TimingLine({ timing, reader, cached }: { timing: NonNullable<RunDetail["timing"]>; reader: "ai" | "mock" | null; cached: boolean }) {
  const parts: string[] = [];
  if (reader === "ai") parts.push(`${cached ? "reading reused from the cache" : "read by the AI"} in ${formatSeconds(timing.read_ms)}`);
  parts.push(`checked by code in ${formatSeconds(timing.check_ms)}`);
  if (timing.propose_ms > 0) parts.push(`plus ${formatSeconds(timing.propose_ms)} for the ${reader === "ai" ? "AI" : "MOCK"} line-match proposal`);
  const text = parts.join(", ");
  return (
    <span className="mt-1 block text-ink-3">
      Measured on this invoice: <span className="num">{text}</span>.
    </span>
  );
}

export function Checks({ run }: { run: RunDetail }) {
  const expected = inFlight(run) ? EXPECTED : [];
  const reader = readerSource(run);
  const passed = run.stages.filter((s) => s.status === "passed").length;
  const stopped = run.stages.filter((s) => s.status === "held" || s.status === "rejected" || s.status === "failed").length;
  return (
    <Panel
      title="Checks"
      description={
        <>
          {reader === "ai"
            ? "Step 1 is the AI reading the document (pencilled, dashed). Every step after it is code that verifies what was read, then a person decides."
            : reader === "mock"
              ? "Step 1 is the MOCK reading (the answer key, test files only). Every step after it is code, then a person decides."
              : "Each check is code; a person makes the final decision."}
          {!inFlight(run) && run.timing && <TimingLine timing={run.timing} reader={reader} cached={Boolean(run.extracted_by?.cached)} />}
        </>
      }
      actions={
        !inFlight(run) && (
          <span className="text-[12px] text-ink-2">
            <span className="num font-semibold text-ok-fg">{passed}</span> passed
            {stopped > 0 && (
              <>
                , <span className="num font-semibold text-hold-fg">{stopped}</span> stopped
              </>
            )}
          </span>
        )
      }
      flush
    >
      <ol className="relative py-1">
        <span aria-hidden className="absolute top-5 bottom-5 left-[1.75rem] w-0.5 bg-rule" />
        {run.stages.map((s) => (
          <Stage key={s.id} s={s} />
        ))}
        {expected.slice(Math.max(0, run.stages.length - 2)).map((t, i) => (
          <li key={t} className="relative flex items-center gap-3 px-4 py-2 text-ink-3">
            <StageMark status="pending" ai={false} />
            <span>
              <span className="num mr-2 text-[12px]">{i + 2}</span>
              {t}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function stageSource(s: StageView): "ai" | "mock" | "code" | "person" {
  if (s.id === "review") return "person";
  if (s.by_ai) return "ai";
  // Only the reading itself is MOCK work; a code step that checked a MOCK line proposal is still code.
  if (s.id === "read" && /mock/i.test(s.by)) return "mock";
  return "code";
}

/** Plain code steps carry no tag (the panel says every step after reading is code); anything else is labelled. */
const showSource = (s: StageView) => stageSource(s) !== "code" || s.by !== "Code";

function Stage({ s }: { s: StageView }) {
  const mark = STATUS_MARK[s.status];
  const notes = s.notes.filter((n) => n.text);
  const hasBody = notes.length > 0 || s.findings.length > 0;
  const stop = s.status === "held" || s.status === "rejected" || s.status === "failed" || s.status === "awaiting_review";
  const head = (
    <>
      <StageMark status={s.status} ai={s.by_ai} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-semibold text-ink">
            <span className="num mr-2 text-[12px] font-normal text-ink-3">{s.n}</span>
            {s.title}
          </span>
          <span className={cx("text-[13px]", mark.cls)}>{s.status_text ?? mark.text}</span>
        </span>
        {showSource(s) && (
          <span className="mt-1 flex items-center gap-2">
            <SourceTag source={stageSource(s)} label={s.by} />
          </span>
        )}
      </span>
    </>
  );
  if (!hasBody) return <li className="relative flex gap-3 px-4 py-2">{head}</li>;
  return (
    <li className="relative">
      <details open={stop} className="group">
        <summary className="flex cursor-pointer list-none gap-3 px-4 py-2 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
          {head}
          <ChevronDown aria-hidden size={16} className="mt-1 shrink-0 text-ink-3 transition-transform group-open:rotate-180" />
        </summary>
        <div className="pr-4 pb-3 pl-[3.25rem]">
          {notes.length > 0 && (
            <ul className="space-y-1 break-words text-[13px] text-ink-2">
              {notes.map((n, i) => (
                <li key={i}>
                  {n.at && <span className="num mr-2 text-[12px] text-ink-3">{formatTime(n.at)}</span>}
                  {n.text}
                  {n.rule && (
                    <span className="ml-2 font-mono text-[11px] text-ink-3" title="Rule in the workflow spec">
                      {n.rule}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {s.findings.length > 0 && (
            <ul className="mt-2 space-y-2">
              {s.findings.map((f, i) => (
                <Finding key={`${f.code}-${i}`} f={f} />
              ))}
            </ul>
          )}
        </div>
      </details>
    </li>
  );
}

function Finding({ f }: { f: FindingView }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cx("break-words rounded-md border px-3 py-2 text-[13px]", f.blocking ? "border-hold-edge bg-hold-bg/60 text-ink" : "border-rule bg-surface-2 text-ink-2")}>
      <p className="font-semibold">{f.title}</p>
      <p className="mt-0.5">{f.message.replace(/\s*\([A-Z]\d+[a-z]?\)\s*$/, "")}</p>
      {f.evidence.length > 0 && (
        <>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-[12px] font-medium text-carbon-deep underline-offset-2 hover:underline">
            {open ? "Hide recorded evidence" : "Show recorded evidence"}
          </button>
          {open && (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
              {f.evidence.map((e) => (
                <div key={e.key} className="contents">
                  <dt className="text-ink-3">{e.key}</dt>
                  <dd className="num break-words font-medium">{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
      <p className="mt-1 font-mono text-[11px] text-ink-3">{f.code}</p>
    </li>
  );
}

// ---- the document beside what was read from it

export function DocumentPanel({ run }: { run: RunDetail }) {
  const [tab, setTab] = useState<"doc" | "values">("doc");
  const reader = readerSource(run);
  const isImage = run.document?.content_type.startsWith("image/");
  const tabCls = (on: boolean) => cx("-mb-px border-b-2 px-3 py-2.5 text-[13px]", on ? "border-carbon font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink");
  return (
    <section aria-label="Document and values read" className="overflow-hidden rounded-lg border border-rule bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-rule pr-3 pl-1">
        <div role="tablist" aria-label="Document views" className="flex">
          <button type="button" role="tab" id="tab-doc" aria-controls="pane-doc" aria-selected={tab === "doc"} onClick={() => setTab("doc")} className={tabCls(tab === "doc")}>
            Document
          </button>
          <button
            type="button"
            role="tab"
            id="tab-values"
            aria-controls="pane-values"
            aria-selected={tab === "values"}
            onClick={() => setTab("values")}
            className={tabCls(tab === "values")}
          >
            Values read
          </button>
        </div>
        {run.document && (
          <a
            href={`/api/runs/${run.run_id}/file`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-semibold text-carbon-deep hover:underline"
          >
            Open original
            <ExternalLink aria-hidden size={13} />
          </a>
        )}
      </div>
      <div id="pane-doc" role="tabpanel" aria-labelledby="tab-doc" hidden={tab !== "doc"}>
        {run.document ? (
          <>
            <p className="flex items-start gap-2 border-b border-rule bg-surface-2 px-4 py-2 text-[12px] text-ink-2">
              {run.document.has_text_layer ? (
                <FileText aria-hidden size={14} className="mt-px shrink-0 text-ink-3" />
              ) : (
                <ScanLine aria-hidden size={14} className="mt-px shrink-0 text-hold-fg" />
              )}
              <span>
                <span className="font-medium text-ink">{run.document.filename}</span>.{" "}
                {run.document.has_text_layer
                  ? `Digital PDF with ${run.document.text_chars.toLocaleString("en-IN")} characters of text; code checks every value read against it.`
                  : "No text layer (a scan or a photo): no value can be checked against the document's own text, so a person compares them with the image."}
              </span>
            </p>
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- the stored original, served by our API
              <img src={`/api/runs/${run.run_id}/file`} alt={`Invoice image ${run.document.filename}`} className="w-full" />
            ) : (
              <>
                {/* Phone browsers do not show PDFs inside a page reliably: offer the file itself instead. */}
                <div className="p-4 sm:hidden">
                  <a
                    href={`/api/runs/${run.run_id}/file`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-center gap-2 rounded-md border border-rule-strong px-3 py-2.5 text-[13px] font-semibold text-carbon-deep"
                  >
                    <FileText aria-hidden size={16} />
                    Open the PDF
                  </a>
                </div>
                <iframe title={`Invoice ${run.document.filename}`} src={`/api/runs/${run.run_id}/file#view=FitH`} className="hidden h-[min(72dvh,52rem)] w-full sm:block" />
              </>
            )}
          </>
        ) : (
          <p className="px-4 py-8 text-center text-[13px] text-ink-2">No file was stored for this invoice{run.failure ? `: ${run.failure}` : "."}</p>
        )}
      </div>
      <div id="pane-values" role="tabpanel" aria-labelledby="tab-values" hidden={tab !== "values"}>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule bg-surface-2 px-4 py-2 text-[12px] text-ink-2">
          {reader && <SourceTag source={reader} label={reader === "ai" ? `Read by ${readerLabel(run.extracted_by?.extractor)}` : "MOCK reading (answer key)"} />}
          <span>{run.extraction ? "Values as read, before any check. Code compares each one with the document text and the reference data." : "Nothing read yet."}</span>
        </div>
        {run.extraction ? (
          <ReadValues run={run} />
        ) : (
          <p className="px-4 py-8 text-center text-[13px] text-ink-2">{inFlight(run) ? "Reading" : "No values were read from this document."}</p>
        )}
      </div>
    </section>
  );
}

function ReadValues({ run }: { run: RunDetail }) {
  const ex = run.extraction!;
  const fields: [string, string | null][] = [
    ["Seller", ex.vendor_name],
    ["Seller GSTIN", ex.vendor_gstin],
    ["Buyer", ex.buyer_name],
    ["Document", `${ex.doc_type.replace(/_/g, " ")}${ex.document_title ? `, "${ex.document_title}"` : ""}`],
    ["Invoice number", ex.invoice_number],
    ["Invoice date", formatDate(ex.invoice_date)],
    ["PO printed", ex.po_reference ?? "none"],
    ["Prices", ex.price_basis === "exclusive" ? "GST added on top" : ex.price_basis === "inclusive" ? "GST included" : ex.price_basis === "none" ? "no GST" : "not stated"],
    ["Bank account ending", ex.bank_account_last4 ?? "none read"],
  ];
  const totals = (
    [
      ["Subtotal", ex.subtotal],
      ["CGST", ex.cgst],
      ["SGST", ex.sgst],
      ["IGST", ex.igst ?? null],
      ["Total", ex.total],
    ] as const
  ).filter(([, v]) => v != null);
  return (
    <div className="px-4 py-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {fields.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="num break-words">{v ?? <Absent>not read</Absent>}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-4 text-[12px] font-semibold text-ink-2">Lines</h3>
      <ul className="mt-1 divide-y divide-rule border-y border-rule text-[13px]">
        {ex.lines.map((l) => (
          <li key={l.line_no} className="py-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 break-words">
                <span className="num mr-1 text-ink-3">{l.line_no}</span>
                {l.description}
              </p>
              <span className="num shrink-0 font-medium">{formatInr(l.amount)}</span>
            </div>
            <p className="num mt-0.5 text-[12px] text-ink-2">
              {l.qty ?? "?"} {l.uom} × {l.unit_price ?? "?"}
              <span className="text-ink-3">, GST {l.gst_rate != null ? `${trimPct(l.gst_rate)}%` : "?"}</span>
            </p>
          </li>
        ))}
      </ul>
      <dl className="num mt-2 space-y-0.5 text-[13px]">
        {totals.map(([k, v]) => (
          <div key={k} className={cx("flex justify-between", k === "Total" ? "border-t border-rule pt-1 font-semibold text-ink" : "text-ink-2")}>
            <dt>{k}</dt>
            <dd>{formatInr(v)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** "0.18" -> "18" for display (string shift, no float). */
function trimPct(rate: string): string {
  const m = /^0?\.(\d+)$/.exec(rate) ?? /^(0)$/.exec(rate);
  if (!m) return rate;
  if (m[1] === "0") return "0";
  const d = (m[1] + "00").slice(0, 2) + "." + m[1].slice(2);
  return d
    .replace(/^0(?=\d)/, "")
    .replace(/\.$/, "")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

// ---- related invoices

export function Related({ run }: { run: RunDetail }) {
  return (
    <Panel title="Related invoices" description="Same vendor and invoice number, a correction, or a dispute." flush>
      <ul className="divide-y divide-rule">
        {run.related.map((r) => (
          <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
            <Link href={`/runs/${r.run_id}`} className="inline-flex min-w-0 items-center gap-1 font-medium text-carbon-deep hover:underline">
              {r.vendor ?? r.filename} <span className="num">{r.invoice_number}</span>
              <span className="num text-ink-3">· {r.ref}</span>
              <ArrowUpRight aria-hidden size={13} />
            </Link>
            <span className="flex items-center gap-3">
              <span className="num font-medium">{r.total}</span>
              <StateChip tone={r.tone} label={r.state_label} short={SHORT_STATE[r.state]} exported={r.exported} size="sm" />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---- history

/** U1: every displayed reviewer name carries its demo-identity label. */
export const demoName = (n: string | null | undefined) => (n ? `${n} (demo identity)` : "a reviewer");

function eventText(e: RunDetail["events"][number]): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "RUN_RECEIVED":
      return d.source === "email" ? `Received by email from ${d.sender}` : `Uploaded by ${d.uploader}`;
    case "STATE_CHANGED":
      return `${STATE_TEXT[e.from_state!]?.label ?? e.from_state} to ${STATE_TEXT[e.to_state!]?.label ?? e.to_state}${e.code ? ` (${CODE_TEXT[e.code]?.title ?? e.code})` : ""}`;
    case "DECIDED": {
      const reasons = Array.isArray(d.blocking) ? (d.blocking as (keyof typeof CODE_TEXT)[]).map((c) => CODE_TEXT[c]?.title ?? c) : [];
      return `Checks finished: ${STATE_TEXT[d.outcome as RunDetail["state"]]?.label ?? d.outcome}${reasons.length ? `. ${reasons.join("; ")}` : ""}`;
    }
    case "CORRECTION_SENT":
      return `Correction ${d.channel === "sent" ? `email sent${d.to ? ` to ${d.to}` : ""}` : "marked sent manually"} with reference ${d.token}`;
    case "EXPORTED":
      return `Exported to payment list ${d.export_id}`;
    case "INVALID_TRANSITION_BLOCKED":
      return `Refused: ${d.action}. ${d.reason}`;
    case "ACTION_REPEAT_IGNORED":
      return `Ignored a repeated or outdated click: ${d.action}`;
    case "DELIVERY_REPEAT_IGNORED":
      return "Ignored a repeated delivery of the same file";
    case "NOTE":
      return d.export_blocked_by ? "Export blocked by a related dispute" : d.export_block_lifted ? "Export block lifted" : "Note";
    default:
      return e.type;
  }
}

export function History({ run }: { run: RunDetail }) {
  return (
    <Panel title="History" description="Every change and refusal, as recorded. Names are demo identities, not verified users." flush>
      <ol className="relative px-4 py-2">
        <span aria-hidden className="absolute top-5 bottom-5 left-[1.6rem] w-px bg-rule" />
        {run.events.map((e) => {
          const person = e.actor !== "system";
          const refused = e.type === "INVALID_TRANSITION_BLOCKED";
          const I = person ? User : ShieldCheck;
          return (
            <li key={e.seq} className="relative flex gap-3 py-2 text-[13px]">
              <span
                aria-hidden
                className={cx(
                  "relative z-10 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border bg-surface",
                  refused ? "border-bad-edge text-bad-fg" : person ? "border-carbon/50 text-carbon-deep" : "border-rule-strong text-ink-3",
                )}
              >
                <I size={11} strokeWidth={2.4} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={cx("break-words", refused ? "font-medium text-bad-fg" : "text-ink")}>{eventText(e)}</span>
                  <span className="num shrink-0 text-[12px] text-ink-3">{formatTime(e.at)}</span>
                </p>
                <p className="text-[12px] text-ink-3">{person ? demoName(e.actor) : "System"}</p>
                {e.note && <p className="mt-0.5 rounded bg-surface-2 px-2 py-1 text-ink-2">Note: {e.note}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
