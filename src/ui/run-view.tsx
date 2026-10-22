"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ReviewAction } from "@/domain/runs/queries";
import type { FindingView, PoTableView, RunDetail, StageView } from "@/server/views";
import { formatDate, formatInr, formatTime } from "@/lib/format";
import { ACTION_TEXT, CODE_TEXT, STATE_TEXT } from "@/lib/reason-text";
import { api, errorText, isRefusal } from "./api";
import { StateChip, toneClasses } from "./chips";
import { useIdentity } from "./identity";
import { usePoll } from "./use-poll";

// One invoice: what was decided and why, the routing slip of every check, the document beside what was read
// from it, the actions a reviewer may take, and the full history.

const inFlight = (r: RunDetail | null) => r?.state === "RECEIVED" || r?.state === "PROCESSING";

export function RunView() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { data: run, error, loading, refresh } = usePoll(() => api.run(id), (d) => (inFlight(d) ? 1200 : 20000));

  if (loading && !run) return <p className="py-16 text-center text-ink-2">Loading the invoice</p>;
  if (!run) {
    return (
      <div className="py-16 text-center">
        <p className="text-bad-fg">{isRefusal(error) && error.code === "NOT_FOUND" ? "There is no invoice with this link." : errorText(error)}</p>
        <Link href="/" className="mt-3 inline-block text-carbon-deep underline">
          Back to all invoices
        </Link>
      </div>
    );
  }

  return (
    <article className="space-y-6">
      <Link href="/" className="text-sm text-carbon-deep hover:underline">
        Back to all invoices
      </Link>
      {search.get("repeat") && (
        <p role="status" className="rounded-md border border-wait-edge bg-wait-bg px-3 py-2 text-sm text-wait-fg">
          This file was uploaded less than a minute ago, so you are looking at the run it already created.
        </p>
      )}
      <Header run={run} />
      <Decision run={run} onChanged={refresh} />
      {run.po_table && <PoTable table={run.po_table} />}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] [&>*]:min-w-0">
        <RoutingSlip run={run} />
        <DocumentPanel run={run} />
      </div>
      {run.related.length > 0 && <Related run={run} />}
      <History run={run} />
    </article>
  );
}

function Header({ run }: { run: RunDetail }) {
  const facts: [string, React.ReactNode][] = [
    ["Invoice number", run.invoice_number ? <span className="num">{run.invoice_number}</span> : "not read"],
    ["Invoice date", formatDate(run.invoice_date) ?? "not read"],
    ["Purchase order", run.po_number ?? (run.po_checked ? "none matched" : <span className="font-normal text-ink-3">not checked</span>)],
    ["Due (per terms)", formatDate(run.due_date) ?? <span className="font-normal text-ink-3">{dueMissing(run)}</span>],
    [run.source === "email" ? "Emailed by" : "Uploaded by", run.source === "email" ? run.sender_email : `${run.uploader} (demo identity)`],
    ["Run", <span key="ref" className="num">{run.ref}</span>],
  ];
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{run.vendor ?? run.filename ?? "Unread document"}</h1>
          {!run.vendor_known && run.vendor && (run.vendor_checked
            ? <p className="text-sm text-hold-fg">Name as printed; not found in the vendor master</p>
            : <p className="text-sm text-ink-3">Name as printed; not checked against the vendor master{run.state === "SKIPPED" ? ` (${run.primary?.code === "NOT_INVOICE" ? "not an invoice" : "not processed"})` : ""}</p>)}
        </div>
        <div className="text-right">
          <p className="num text-3xl font-bold">{run.total ?? <span className="text-xl font-normal text-ink-3">total not read</span>}</p>
          <div className="mt-1">
            <StateChip tone={run.tone} label={run.state_label} exported={run.exported} />
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-y border-rule py-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className="text-ink-3">{k}</dt>
            <dd className="break-words font-semibold text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

/** Why the due date is empty: it is set from the vendor's payment terms once the invoice clears or is approved. */
function dueMissing(run: RunDetail): string {
  if (["SKIPPED", "REJECTED", "SUPERSEDED", "FAILED"].includes(run.state)) return "none";
  if (!run.vendor_known || !run.invoice_date) return "not set: no vendor terms or date";
  return "set when approved";
}

/** U1: every displayed reviewer name carries its demo-identity label. */
const demoName = (n: string | null | undefined) => (n ? `${n} (demo identity)` : "a reviewer");

function stateSentence(run: RunDetail): string {
  const lastApproval = run.approvals.at(-1);
  switch (run.state) {
    case "RECEIVED":
    case "PROCESSING":
      return "Reading the document. The checks run as soon as it is read.";
    case "CLEARED":
      return run.export_blocked
        ? "Every check passed, but a related invoice disputes it, so it cannot be exported."
        : "Every check passed. It needs a reviewer's approval before it goes on the payment list.";
    case "APPROVED":
      return run.exported
        ? `Approved for payment list by ${demoName(lastApproval?.approver_display_name)}, ${formatTime(lastApproval?.approved_at)}. Exported to payment list ${run.export_id}.`
        : `Approved for payment list by ${demoName(lastApproval?.approver_display_name)}, ${formatTime(lastApproval?.approved_at)}${lastApproval?.mode && lastApproval.mode !== "individual" ? ` (${lastApproval.mode})` : ""}.${run.export_blocked ? " Export is blocked by a related dispute." : " It goes out with the next export."}`;
    case "ON_HOLD":
      return `Held by ${run.issues.length} check${run.issues.length === 1 ? "" : "s"}. It stays off the payment list until a reviewer resolves ${run.issues.length === 1 ? "it" : "them"}.`;
    case "AWAITING_VENDOR":
      return `Correction requested with reference [Ref ${run.token_active}]. A reply that carries it, from the vendor's registered address, is linked to this invoice and replaces it only if it passes every check.`;
    case "REJECTED":
      return run.primary?.code === "DUPLICATE_INVOICE" ? "Rejected automatically: this invoice was already received." : "Rejected by a reviewer.";
    case "SUPERSEDED":
      return "Replaced by a corrected invoice; it will not go on the payment list.";
    case "SKIPPED":
      return "Not processed as an invoice.";
    case "FAILED":
      return "The document could not be read. Retrying keeps this run and its history.";
  }
}

function Decision({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  const tone = toneClasses[run.tone];
  return (
    <section aria-labelledby="decision-h" className={`rounded-md border p-4 ${tone}`}>
      <h2 id="decision-h" className="text-lg font-bold">
        {run.state === "CLEARED" ? "Cleared by checks" : run.state_label}
      </h2>
      <p className="mt-1">{stateSentence(run)}</p>
      {inFlight(run) && <div className="reading-bar mt-3 h-1 rounded bg-carbon-wash" aria-hidden />}
      {run.failure && run.state === "FAILED" && <p className="mt-2 text-sm">{run.failure}</p>}
      {run.issues.length > 0 && run.state !== "SUPERSEDED" && (
        <>
          {run.state === "APPROVED" && <p className="mt-3 text-sm font-semibold">Approved despite:</p>}
          <ul className="mt-3 space-y-3">
            {run.issues.map((i) => (
              <li key={`${i.codes.join("+")}-${i.line_no ?? ""}`} className="text-sm">
                <p>
                  <span className="font-semibold">{i.title}</span>
                  {i.codes.map((c) => (
                    <span key={c} className="num ml-2 text-xs opacity-70">
                      {c}
                    </span>
                  ))}
                </p>
                <p className="mt-0.5">{i.explain}</p>
                {i.next && (
                  <p className="mt-0.5 opacity-90">
                    <span className="font-semibold">To resolve: </span>
                    {i.next}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <Actions run={run} onChanged={onChanged} />
    </section>
  );
}

function Actions({ run, onChanged }: { run: RunDetail; onChanged: () => void }) {
  const { name } = useIdentity();
  const [open, setOpen] = useState<ReviewAction | null>(null);
  const [note, setNote] = useState("");
  const [po, setPo] = useState("");
  const [call, setCall] = useState({ number: "", spoke: "", when: "" });
  const [confirm, setConfirm] = useState<{ action: ReviewAction; problems: string[]; kind: "po" | "callback"; reason: string } | null>(null);
  const [confirmed, setConfirmed] = useState<{ po: boolean; callback: boolean }>({ po: false, callback: false });
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!run.actions.length) return null;
  const current = run.actions.find((a) => a.action === open) ?? null;

  async function submit(action: ReviewAction, extra: Record<string, unknown> = {}, doneText?: string) {
    if (!name) return setMsg({ ok: false, text: "Choose who you are acting as (top right) first." });
    setPending(true);
    setMsg(null);
    try {
      await api.act(run.run_id, { action, actor: name, note: note.trim() || null, expectedVersion: run.version, ...extra });
      setMsg({ ok: true, text: doneText ?? `${ACTION_TEXT[action].done}.` });
      setOpen(null);
      setNote("");
      setPo("");
      setCall({ number: "", spoke: "", when: "" });
      setConfirm(null);
      setConfirmed({ po: false, callback: false });
      onChanged();
    } catch (e) {
      if (isRefusal(e) && e.code === "NEEDS_CONFIRMATION") {
        setConfirm({ action, problems: e.details?.problems ?? [e.reason], kind: e.details?.confirm === "callback" ? "callback" : "po", reason: e.reason });
      } else setMsg({ ok: false, text: errorText(e) });
    } finally {
      setPending(false);
    }
  }

  // U05: the recommended action leads; with none, every option is shown alike and the reviewer decides.
  const primary = (a: ReviewAction) => run.recommended?.action === a;

  /** What the open form adds to the request: the PO named (C4b), the callback record (Q9) and any confirmations given. */
  const extras = (opt: typeof current | undefined, given = confirmed): Record<string, unknown> => ({
    ...(opt?.po_choices ? { poNumber: po } : {}),
    ...(opt?.callback ? { callback: { number_called: call.number, spoke_to: call.spoke, called_at: call.when ? new Date(call.when).toISOString() : "" } } : {}),
    ...(given.callback ? { confirmCallback: true } : {}),
    ...(given.po ? { confirmFailingChecks: true } : {}),
  });

  return (
    <div className="mt-4 border-t border-current/20 pt-4">
      {run.recommended && (
        <p className="mb-2 text-sm">
          <span className="font-semibold">Recommended: {ACTION_TEXT[run.recommended.action].label.toLowerCase()}.</span> {run.recommended.why}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {run.actions.map((a) => (
          <button
            key={a.action}
            type="button"
            disabled={pending}
            aria-expanded={a.needsNote || a.action === "request_correction" ? open === a.action : undefined}
            onClick={() => {
              setMsg(null);
              setConfirm(null);
              setConfirmed({ po: false, callback: false });
              if (a.callback && call.when === "") setCall({ ...call, when: localNow() });
              if (a.needsNote || a.action === "request_correction") setOpen(open === a.action ? null : a.action);
              else submit(a.action);
            }}
            className={
              primary(a.action)
                ? "rounded-md bg-approved-bg px-3 py-1.5 text-sm font-semibold text-approved-fg disabled:opacity-50"
                : a.action === "reject"
                  ? "rounded-md border border-bad-edge bg-surface px-3 py-1.5 text-sm font-semibold text-bad-fg disabled:opacity-50"
                  : "rounded-md border border-rule-strong bg-surface px-3 py-1.5 text-sm font-semibold text-ink disabled:opacity-50"
            }
          >
            {ACTION_TEXT[a.action].label}
          </button>
        ))}
      </div>

      {current && current.action === "request_correction" && run.correction_draft && (
        <div className="mt-4 rounded-md border border-rule bg-surface p-3 text-ink">
          {run.correction_draft.send && run.correction_draft.to ? (
            <p className="text-sm text-ink-2">
              Written by code from the holds the vendor can fix; checks on our side are not mentioned. <span className="font-semibold text-ink">Send email</span> delivers it to{" "}
              <span className="font-semibold text-ink">{run.correction_draft.to}</span> from {run.correction_draft.send.from}. The
              vendor&apos;s reply goes to {run.correction_draft.send.reply_to}, where the reference {run.correction_draft.token} links
              it to this invoice.
            </p>
          ) : (
            <p className="text-sm text-ink-2">
              Email sending is not connected on this deployment. Copy this text into your email to{" "}
              <span className="font-semibold text-ink">{run.correction_draft.to ?? "the vendor"}</span>, send it, then mark it as sent. The
              reference {run.correction_draft.token} is issued when you do.
            </p>
          )}
          <p className="mt-3 text-sm font-semibold">Subject: {run.correction_draft.subject}</p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-rule bg-paper p-3 font-sans text-sm">{run.correction_draft.body}</pre>
          <div className="mt-3 flex flex-wrap gap-2">
            {run.correction_draft.send && run.correction_draft.to && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  submit(
                    "request_correction",
                    { channel: "sent" },
                    `Correction email sent to ${run.correction_draft!.to} with reference ${run.correction_draft!.token}.`,
                  )
                }
                className="rounded-md bg-carbon px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {pending ? "Sending" : "Send email"}
              </button>
            )}
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`Subject: ${run.correction_draft!.subject}\n\n${run.correction_draft!.body}`);
                  setCopied(true);
                } catch {
                  setCopied(false);
                  setMsg({ ok: false, text: "Copying is blocked in this browser. Select the text and copy it yourself." });
                }
              }}
              className="rounded-md border border-rule-strong px-3 py-1.5 text-sm font-semibold"
            >
              {copied ? "Copied" : "Copy email text"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => submit("request_correction", { channel: "marked sent manually" })}
              className={
                run.correction_draft.send && run.correction_draft.to
                  ? "rounded-md border border-rule-strong px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  : "rounded-md bg-carbon px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              }
            >
              Mark as sent manually
            </button>
          </div>
        </div>
      )}

      {current && current.needsNote && (
        <form
          className="mt-4 rounded-md border border-rule bg-surface p-3 text-ink"
          onSubmit={(e) => {
            e.preventDefault();
            submit(current.action, extras(current));
          }}
        >
          {current.callback && <CallbackFields need={current.callback} vendor={run.vendor} call={call} setCall={setCall} />}
          {current.po_choices && (
            <div className="mb-3">
              <label htmlFor="po-choice" className="text-sm font-semibold">
                Which purchase order is this for?{" "}
                <span className="font-normal text-ink-2">No PO was found on the invoice. Approving counts it against the PO you choose.</span>
              </label>
              {current.po_choices.length > 0 ? (
                <select id="po-choice" required value={po} onChange={(e) => setPo(e.target.value)} className="mt-2 block w-full max-w-xs rounded-md border border-rule-strong bg-surface p-2 text-sm">
                  <option value="">Choose a PO</option>
                  {current.po_choices.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-2 text-sm text-bad-fg">This vendor has no open purchase order, so it cannot be approved against one. Reject it or request a correction.</p>
              )}
            </div>
          )}
          <label htmlFor="note" className="text-sm font-semibold">
            Why? <span className="font-normal text-ink-2">A note is required and is kept in the history.</span>
          </label>
          <textarea
            id="note"
            required
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-2 w-full rounded-md border border-rule-strong bg-surface p-2 text-sm"
            placeholder={current.action === "reject" ? "For example: price not agreed, vendor will reissue" : "For example: confirmed with the vendor by phone"}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="submit"
              disabled={pending || !note.trim() || (Boolean(current.po_choices) && !po) || (Boolean(current.callback) && (!call.number.trim() || !call.spoke.trim() || !call.when))}
              className="rounded-md bg-carbon px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {ACTION_TEXT[current.action].label}
            </button>
            <button type="button" onClick={() => setOpen(null)} className="rounded-md px-3 py-1.5 text-sm text-ink-2 hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      )}

      {confirm && (
        <div role="alert" className="mt-4 rounded-md border border-bad-edge bg-bad-bg p-3 text-bad-fg">
          <p className="font-semibold">{confirm.kind === "callback" ? `${confirm.reason.replace(/\. Confirm again to approve$/, "")}. Approve only if the call settled this:` : "Approving this would bill more than the purchase order allows:"}</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {confirm.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const given = { ...confirmed, [confirm.kind]: true };
              setConfirmed(given);
              submit(confirm.action, extras(run.actions.find((a) => a.action === confirm.action), given));
            }}
            className="mt-3 rounded-md bg-bad-fg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {confirm.kind === "callback" ? "Confirm and approve" : "Approve anyway"}
          </button>
        </div>
      )}

      {msg && (
        <p role="status" className={`mt-3 text-sm font-semibold ${msg.ok ? "" : "text-bad-fg"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

/** The browser's local time now, in the format a datetime-local input takes ("2026-10-23T09:40"). */
function localNow(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

type CallState = { number: string; spoke: string; when: string };

/** Spec v1.4 row 9 (Q9): the call that confirmed a bank, vendor or sender hold, entered before the override. */
function CallbackFields({ need, vendor, call, setCall }: { need: NonNullable<RunDetail["actions"][number]["callback"]>; vendor: string | null; call: CallState; setCall: (c: CallState) => void }) {
  const input = "mt-1 block w-full rounded-md border border-rule-strong bg-surface p-2 text-sm";
  return (
    <fieldset className="mb-3 rounded-md border border-bad-edge bg-bad-bg/40 p-3">
      <legend className="px-1 text-sm font-semibold text-bad-fg">Call the vendor first</legend>
      <p className="text-sm text-ink">
        {need.master_phone ? (
          <>
            Call {vendor ?? "the vendor"} on <span className="num font-semibold">{need.master_phone}</span>, the number in the vendor master. Never use a number printed on the
            invoice or in the email: if the invoice is fraudulent, that number reaches the fraudster.
          </>
        ) : (
          <>This vendor is not in the vendor master, so there is no trusted number. Use one you can trust, and say in the note how you know it is theirs.</>
        )}
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className="text-sm">
          Number called
          <input type="tel" required value={call.number} onChange={(e) => setCall({ ...call, number: e.target.value })} className={`num ${input}`} />
        </label>
        <label className="text-sm">
          Spoke to
          <input type="text" required value={call.spoke} onChange={(e) => setCall({ ...call, spoke: e.target.value })} placeholder="Name and role" className={input} />
        </label>
        <label className="text-sm">
          When
          <input type="datetime-local" required value={call.when} onChange={(e) => setCall({ ...call, when: e.target.value })} className={`num ${input}`} />
        </label>
      </div>
    </fieldset>
  );
}

/** Invoice lines against the PO they were checked against (audit U01): the numbers behind steps 7 and 8. */
function PoTable({ table }: { table: PoTableView }) {
  return (
    <section aria-labelledby="po-h" className="rounded-md border border-rule bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3">
        <h2 id="po-h" className="text-lg font-bold">
          Invoice against <span className="num">{table.po_number}</span>
        </h2>
        <p className="text-sm text-ink-2">
          {table.how_found}
          {table.po_value ? `. PO value ${table.po_value}` : ""}
          {table.po_status && table.po_status !== "open" ? ` (${table.po_status})` : ""}.
        </p>
      </div>
      <p className="px-4 pt-2 text-xs text-ink-3">Prices are compared before GST, per PO unit.</p>
      {/* Phones: one block per line. */}
      <ul className="divide-y divide-rule sm:hidden">
        {table.rows.map((r) => (
          <li key={r.invoice_line} className="px-4 py-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 break-words font-semibold">
                <span className="num mr-1 text-ink-3">{r.invoice_line}</span>
                {r.description}
              </p>
              <RowStatus r={r} />
            </div>
            <dl className="num mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-ink-2">
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
                    {r.invoice_price} vs {r.po_price} {r.price_diff && <span className={r.flags.includes("Price over") ? "font-semibold text-hold-fg" : ""}>({r.price_diff})</span>}
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
            {r.matched_by && <p className="mt-1 text-xs text-graphite">{r.matched_by}</p>}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto px-4 pb-3 sm:block">
        <table className="mt-2 w-full min-w-[44rem] text-sm">
          <thead className="border-b border-rule text-left text-ink-3">
            <tr>
              <th className="py-1 pr-3 font-normal">Invoice line</th>
              <th className="py-1 pr-3 font-normal">Billed</th>
              <th className="py-1 pr-3 font-normal">PO line</th>
              <th className="py-1 pr-3 text-right font-normal">Invoice price</th>
              <th className="py-1 pr-3 text-right font-normal">PO price</th>
              <th className="py-1 pr-3 text-right font-normal">Quantity</th>
              <th className="py-1 font-normal">Result</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.invoice_line} className={`border-b border-rule align-top last:border-b-0 ${r.flags.length ? "bg-hold-bg/60" : ""}`}>
                <td className="py-2 pr-3">
                  <span className="num mr-1 text-ink-3">{r.invoice_line}</span>
                  {r.description}
                  {r.matched_by && <span className="block text-xs text-graphite">{r.matched_by}</span>}
                </td>
                <td className="num py-2 pr-3 whitespace-nowrap">
                  {r.billed}
                  <span className="block text-ink-3">{r.amount}</span>
                </td>
                <td className="py-2 pr-3">{r.po_line ?? <span className="text-ink-3">none</span>}</td>
                <td className={`num py-2 pr-3 text-right whitespace-nowrap ${r.flags.includes("Price over") ? "font-semibold text-hold-fg" : ""}`}>
                  {r.invoice_price ?? <span className="text-ink-3">not compared</span>}
                  {r.price_diff && <span className="block text-xs">{r.price_diff}</span>}
                </td>
                <td className="num py-2 pr-3 text-right whitespace-nowrap">{r.po_price ?? <span className="text-ink-3">none</span>}</td>
                <td className={`num py-2 pr-3 text-right ${r.flags.includes("Quantity over") ? "font-semibold text-hold-fg" : ""}`}>{r.quantity ?? <span className="text-ink-3">not compared</span>}</td>
                <td className="py-2">
                  <RowStatus r={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RowStatus({ r }: { r: PoTableView["rows"][number] }) {
  if (r.flags.length) return <span className="text-sm font-semibold text-hold-fg">{r.flags.join("; ")}</span>;
  return <span className="text-sm text-ok-fg">{r.ok_text ?? "Not compared"}</span>;
}

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

/** The routing slip: every stage in order, who did it, and what it found. AI work is pencilled (dashed). */
function RoutingSlip({ run }: { run: RunDetail }) {
  const expected = inFlight(run) ? ["Is it an invoice?", "Does the document hold together?", "Vendor, sender and bank details", "Duplicates and corrections", "Which purchase order?", "Lines matched to the PO", "Prices and quantities against the PO", "Decision", "Reviewer decision"] : [];
  return (
    <section aria-labelledby="slip-h" className="rounded-md border border-rule bg-surface">
      <div className="border-b border-rule px-4 py-3">
        <h2 id="slip-h" className="text-lg font-bold">Routing slip</h2>
        <p className="text-sm text-ink-2">
          Every check, in order, then the reviewer. <span className="border-b-2 border-dashed border-graphite">Dashed</span> steps were done by AI; the checks
          are code that verifies the AI&apos;s reading.
        </p>
      </div>
      <ol>
        {run.stages.map((s) => (
          <Stage key={s.id} s={s} />
        ))}
        {expected.slice(run.stages.length - 2).map((t, i) => (
          <li key={t} className="flex gap-3 border-b border-rule px-4 py-3 text-ink-3 last:border-b-0">
            <span className="num w-5 shrink-0 text-right">{i + 2}</span>
            <span>{t}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Stage({ s }: { s: StageView }) {
  const mark = STATUS_MARK[s.status];
  return (
    <li className={`border-b border-rule px-4 py-3 last:border-b-0 ${s.by_ai ? "border-l-4 border-l-graphite [border-left-style:dashed]" : "border-l-4 border-l-transparent"}`}>
      <div className="flex items-baseline gap-3">
        <span className="num w-5 shrink-0 text-right text-ink-3">{s.n}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="font-semibold">{s.title}</h3>
            <span className={`text-sm ${mark.cls}`}>{s.status_text ?? mark.text}</span>
          </div>
          <p className={`text-xs ${s.by_ai ? "text-graphite" : "text-ink-3"}`}>{s.by}</p>
          {s.notes.filter((n) => n.text).length > 0 && (
            <ul className="mt-1.5 space-y-0.5 break-words text-sm text-ink-2">
              {s.notes.filter((n) => n.text).map((n, i) => (
                <li key={i}>
                  {n.at && <span className="num mr-2 text-xs text-ink-3">{formatTime(n.at)}</span>}
                  {n.text}
                  {n.rule && <span className="num ml-2 text-xs text-ink-3" title="Rule in the workflow spec">{n.rule}</span>}
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
      </div>
    </li>
  );
}

function Finding({ f }: { f: FindingView }) {
  const [open, setOpen] = useState(f.blocking);
  return (
    <li className={`break-words rounded border px-3 py-2 text-sm ${f.blocking ? "border-hold-edge bg-hold-bg text-hold-fg" : "border-rule bg-paper text-ink-2"}`}>
      <p>
        <span className="font-semibold">{f.title}</span>
        <span className="ml-2 text-xs opacity-70">{f.code}</span>
      </p>
      <p className="mt-0.5">{f.message}</p>
      {f.evidence.length > 0 && (
        <>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="mt-1 text-xs underline opacity-80 hover:opacity-100">
            {open ? "Hide evidence" : "Show evidence"}
          </button>
          {open && (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {f.evidence.map((e) => (
                <div key={e.key} className="contents">
                  <dt className="opacity-75">{e.key}</dt>
                  <dd className="num break-words font-semibold">{e.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </li>
  );
}

function DocumentPanel({ run }: { run: RunDetail }) {
  const ex = run.extraction;
  const isImage = run.document?.content_type.startsWith("image/");
  return (
    <section aria-labelledby="doc-h" className="space-y-4">
      <div className="rounded-md border border-rule bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule px-4 py-3">
          <h2 id="doc-h" className="text-lg font-bold">Document</h2>
          {run.document && (
            <a href={`/api/runs/${run.run_id}/file`} target="_blank" rel="noreferrer" className="text-sm text-carbon-deep underline">
              Open {run.document.filename}
            </a>
          )}
        </div>
        {run.document ? (
          <>
            <p className="px-4 pt-2 text-xs text-ink-3">
              {run.document.has_text_layer
                ? `Digital PDF: ${run.document.text_chars} characters of text, used to check every value read.`
                : "No text layer (a scan or a photo): values can only come from the image and need a human check."}
            </p>
            {isImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- the stored original, served by our API
              <img src={`/api/runs/${run.run_id}/file`} alt={`Invoice image ${run.document.filename}`} className="mt-2 w-full" />
            ) : (
              <>
                {/* Phone browsers do not show PDFs inside a page reliably: offer the file itself instead. */}
                <a
                  href={`/api/runs/${run.run_id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="mx-4 my-3 block rounded-md border border-rule px-3 py-2 text-center text-sm font-semibold text-carbon-deep sm:hidden"
                >
                  Open the PDF
                </a>
                <iframe title={`Invoice ${run.document.filename}`} src={`/api/runs/${run.run_id}/file#view=FitH`} className="mt-2 hidden h-[32rem] w-full border-t border-rule sm:block" />
              </>
            )}
          </>
        ) : (
          <p className="px-4 py-6 text-sm text-ink-2">No file was stored for this run{run.failure ? `: ${run.failure}` : "."}</p>
        )}
      </div>
      <div className="rounded-md border border-rule bg-surface">
        <div className="border-b border-rule px-4 py-3">
          <h2 className="text-lg font-bold">What was read</h2>
          <p className="text-sm text-ink-2">
            {run.extracted_by ? `By ${run.extracted_by.extractor}.` : "Nothing read yet."} Values are checked against the document text in step 3.
          </p>
        </div>
        {ex ? <ReadValues run={run} /> : <p className="px-4 py-6 text-sm text-ink-2">{inFlight(run) ? "Reading" : "No values were read from this document."}</p>}
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
    ["Document", `${ex.doc_type}${ex.document_title ? `, "${ex.document_title}"` : ""}`],
    ["Invoice number", ex.invoice_number],
    ["Invoice date", formatDate(ex.invoice_date)],
    ["PO printed", ex.po_reference ?? "none"],
    ["Prices", ex.price_basis === "exclusive" ? "GST added on top" : ex.price_basis === "inclusive" ? "GST included" : ex.price_basis === "none" ? "no GST" : "not stated"],
    ["Bank account ending", ex.bank_account_last4 ?? "not printed"],
  ];
  return (
    <div className="px-4 py-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {fields.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="num break-words">{v ?? <span className="text-ink-3">not read</span>}</dd>
          </div>
        ))}
      </dl>
      {/* Phones: each line as a short block; the table needs more width than a phone has. */}
      <ul className="mt-4 divide-y divide-rule border-y border-rule text-sm sm:hidden">
        {ex.lines.map((l) => (
          <li key={l.line_no} className="py-2">
            <p className="break-words">{l.description}</p>
            <div className="num mt-0.5 flex items-baseline justify-between gap-3 text-ink-2">
              <span>
                {l.qty ?? "?"} {l.uom} × {l.unit_price ?? "?"}
                <span className="text-ink-3">, GST {l.gst_rate != null ? `${trimPct(l.gst_rate)}%` : "?"}</span>
              </span>
              <span className="font-semibold text-ink">{formatInr(l.amount)}</span>
            </div>
          </li>
        ))}
      </ul>
      <dl className="num mt-2 space-y-0.5 text-sm sm:hidden">
        {([["Subtotal", ex.subtotal], ["CGST", ex.cgst], ["SGST", ex.sgst], ["IGST", ex.igst ?? null], ["Total", ex.total]] as const)
          .filter(([, v]) => v != null)
          .map(([k, v]) => (
            <div key={k} className={`flex justify-between ${k === "Total" ? "font-bold" : "text-ink-2"}`}>
              <dt>{k}</dt>
              <dd>{formatInr(v)}</dd>
            </div>
          ))}
      </dl>
      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full min-w-[28rem] text-sm">
          <thead className="border-b border-rule text-left text-ink-3">
            <tr>
              <th className="py-1 pr-2 font-normal">Line</th>
              <th className="py-1 pr-2 text-right font-normal">Qty</th>
              <th className="py-1 pr-2 text-right font-normal">Unit price</th>
              <th className="py-1 pr-2 text-right font-normal">GST</th>
              <th className="py-1 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {ex.lines.map((l) => (
              <tr key={l.line_no} className="border-b border-rule align-top">
                <td className="py-1.5 pr-2">{l.description}</td>
                <td className="num py-1.5 pr-2 text-right whitespace-nowrap">
                  {l.qty ?? "?"} {l.uom}
                </td>
                <td className="num py-1.5 pr-2 text-right">{l.unit_price ?? "?"}</td>
                <td className="num py-1.5 pr-2 text-right">{l.gst_rate != null ? `${trimPct(l.gst_rate)}%` : "?"}</td>
                <td className="num py-1.5 text-right">{formatInr(l.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="num">
            {([["Subtotal", ex.subtotal], ["CGST", ex.cgst], ["SGST", ex.sgst], ["IGST", ex.igst ?? null], ["Total", ex.total]] as const)
              .filter(([, v]) => v != null)
              .map(([k, v]) => (
                <tr key={k} className={k === "Total" ? "font-bold" : "text-ink-2"}>
                  <td colSpan={4} className="py-1 pr-2 text-right">
                    {k}
                  </td>
                  <td className="py-1 text-right">{formatInr(v)}</td>
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** "0.18" -> "18" for display (string shift, no float). */
function trimPct(rate: string): string {
  const m = /^0?\.(\d+)$/.exec(rate) ?? /^(0)$/.exec(rate);
  if (!m) return rate;
  if (m[1] === "0") return "0";
  const d = (m[1] + "00").slice(0, 2) + "." + m[1].slice(2);
  return d.replace(/^0(?=\d)/, "").replace(/\.$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function Related({ run }: { run: RunDetail }) {
  return (
    <section aria-labelledby="rel-h" className="rounded-md border border-rule bg-surface p-4">
      <h2 id="rel-h" className="text-lg font-bold">Related invoices</h2>
      <p className="text-sm text-ink-2">Same vendor and invoice number, a correction, or a dispute.</p>
      <ul className="mt-2 divide-y divide-rule">
        {run.related.map((r) => (
          <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <Link href={`/runs/${r.run_id}`} className="text-carbon-deep underline">
              {r.vendor ?? r.filename} <span className="num">{r.invoice_number}</span>, {r.total}
            </Link>
            <span className="flex items-center gap-2">
              <span className="text-xs text-ink-3">{formatTime(r.created_at)}</span>
              <StateChip tone={r.tone} label={r.state_label} exported={r.exported} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

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

function History({ run }: { run: RunDetail }) {
  return (
    <section aria-labelledby="hist-h" className="rounded-md border border-rule bg-surface">
      <div className="border-b border-rule px-4 py-3">
        <h2 id="hist-h" className="text-lg font-bold">History</h2>
        <p className="text-sm text-ink-2">Every change and refusal, as recorded. Names are demo identities, not verified users.</p>
      </div>
      <ol className="divide-y divide-rule">
        {run.events.map((e) => (
          <li key={e.seq} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 py-2 text-sm sm:grid-cols-[9rem_10rem_1fr]">
            <span className="num text-ink-3">{formatTime(e.at)}</span>
            <span className="text-ink-2">{e.actor === "system" ? "System" : demoName(e.actor)}</span>
            <span className="col-span-2 sm:col-span-1">
              {eventText(e)}
              {e.note && <span className="block text-ink-2">Note: {e.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
