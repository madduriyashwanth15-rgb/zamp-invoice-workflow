"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ArrowRight, BadgeCheck, Check, ChevronLeft, ChevronRight, CircleCheck, Copy, Mail, MailCheck, Phone, RotateCw, Send, TriangleAlert } from "lucide-react";
import type { ActionOption, ReviewAction } from "@/domain/runs/queries";
import type { IssueView } from "@/server/explain";
import type { RunDetail, StageView } from "@/server/views";
import { formatDate, formatTime } from "@/lib/format";
import { TIER_TEXT } from "@/lib/issue-tier";
import { ACTION_TEXT } from "@/lib/reason-text";
import { api, errorText, isRefusal } from "./api";
import { StateChip, TierBadge, TierIcon } from "./chips";
import { useIdentity } from "./identity";
import { Absent, Button, Dialog, Fact, Field, Notice, Skeleton, SourceTag, btn, cx, inputCls, type Icon } from "./kit";
import { homeView, sortRuns, defaultSort } from "./queue";
import { Checks, DocumentPanel, History, PoComparison, Related, demoName, inFlight, readerSource } from "./run-evidence";
import { useRuns } from "./runs-context";
import { PageHeader } from "./shell";
import { usePoll } from "./use-poll";

// The review workbench for one invoice: where it stands and why, the issues to resolve with their evidence and the
// safe next step, the actions a reviewer may take (each in a dialog that says what it does), the invoice against
// its PO, every check, the document beside what was read from it, and the full history.

export function RunView() {
  const { id } = useParams<{ id: string }>();
  // Keyed by the invoice, so moving to the next or previous one starts clean: its own data, no leftover messages.
  return <Workbench key={id} id={id} />;
}

function Workbench({ id }: { id: string }) {
  const search = useSearchParams();
  const {
    data: run,
    error,
    loading,
    refresh,
  } = usePoll(
    () => api.run(id),
    (d) => (inFlight(d) ? 1200 : 20000),
  );
  const runs = useRuns();
  const [done, setDone] = useState<{ text: string } | null>(null);

  if (loading && !run) return <WorkbenchSkeleton />;
  if (!run) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <Notice tone="error" title={isRefusal(error) && error.code === "NOT_FOUND" ? "There is no invoice with this link" : "The invoice did not load"}>
          {isRefusal(error) && error.code === "NOT_FOUND" ? "It may have been removed by a demo reset." : errorText(error)}{" "}
          <Link href="/" className="font-semibold underline">
            Back to all invoices
          </Link>
        </Notice>
      </div>
    );
  }

  const changed = () => {
    refresh();
    runs.refresh();
  };

  return (
    <article>
      <RunHeader run={run} />
      {search.get("repeat") && (
        <Notice tone="info" className="mb-4" live>
          This file was uploaded less than a minute ago, so you are looking at the invoice it already created.
        </Notice>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)]">
        <div className="min-w-0 space-y-5">
          <Decision run={run} onChanged={changed} done={done} setDone={setDone} />
          {run.po_table && <PoComparison table={run.po_table} />}
        </div>
        <aside className="min-w-0 xl:sticky xl:top-6 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:self-start">
          <DocumentPanel run={run} />
        </aside>
        <div className="min-w-0 space-y-5">
          <Checks run={run} />
          {run.related.length > 0 && <Related run={run} />}
          <History run={run} />
        </div>
      </div>
    </article>
  );
}

function WorkbenchSkeleton() {
  return (
    <div aria-busy aria-label="Loading the invoice" className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="w-40" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="w-96" />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-rule bg-surface p-4">
          <Skeleton className="w-48" />
          <Skeleton className="w-full" />
          <Skeleton className="w-5/6" />
          <Skeleton className="w-2/3" />
        </div>
        <div className="h-80 rounded-lg border border-rule bg-surface" />
      </div>
    </div>
  );
}

// ---- header: identity of the invoice, where it stands, and its place in the queue

/** Why the due date is empty: it is set from the vendor's payment terms once the invoice clears or is approved. */
function dueMissing(run: RunDetail): string {
  if (["SKIPPED", "REJECTED", "SUPERSEDED", "FAILED"].includes(run.state)) return "none";
  if (!run.vendor_known || !run.invoice_date) return "not set: no vendor terms or date";
  return "set when approved";
}

function useQueuePosition(run: RunDetail) {
  const { data } = useRuns();
  const view = homeView(run);
  const list = data ? sortRuns(data.runs.filter(view.test), defaultSort(view.id)) : [];
  const i = list.findIndex((r) => r.run_id === run.run_id);
  return { view, list, i, prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}

function RunHeader({ run }: { run: RunDetail }) {
  const { view, list, i, prev, next } = useQueuePosition(run);
  const viewHref = view.id === "review" ? "/" : `/?view=${view.id}`;
  return (
    <PageHeader
      crumbs={[{ href: "/", label: "Invoices" }, { href: viewHref, label: view.label }, { label: run.ref }]}
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="break-words">{run.vendor ?? run.filename ?? "Unread document"}</span>
          <StateChip tone={run.tone} label={run.state_label} exported={run.exported} />
        </span>
      }
      meta={
        !run.vendor_known && run.vendor ? (
          run.vendor_checked ? (
            <span className="font-medium text-bad-fg">Name as printed; not found in the vendor master</span>
          ) : (
            <span>
              Name as printed; not checked against the vendor master
              {run.state === "SKIPPED" ? ` (${run.primary?.code === "NOT_INVOICE" ? "not an invoice" : "not processed"})` : ""}
            </span>
          )
        ) : undefined
      }
      actions={
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <p className="num text-[26px] font-semibold leading-none">{run.total ?? <span className="text-[17px] font-normal text-ink-3">total not read</span>}</p>
          {run.total && <p className="text-[12px] text-ink-3">Invoice total, GST included</p>}
          {i >= 0 && list.length > 1 && (
            <nav aria-label="Queue position" className="mt-1 flex items-center gap-1 text-[12px] text-ink-2">
              {prev ? (
                <Link href={`/runs/${prev.run_id}`} className={btn("ghost", "sm", "h-7 px-1.5")} aria-label={`Previous: ${prev.vendor ?? prev.ref}`}>
                  <ChevronLeft aria-hidden size={15} />
                </Link>
              ) : (
                <span className={btn("ghost", "sm", "pointer-events-none h-7 px-1.5 opacity-30")} aria-hidden>
                  <ChevronLeft size={15} />
                </span>
              )}
              <span className="num">
                {i + 1} of {list.length} in {view.label.toLowerCase()}
              </span>
              {next ? (
                <Link href={`/runs/${next.run_id}`} className={btn("ghost", "sm", "h-7 px-1.5")} aria-label={`Next: ${next.vendor ?? next.ref}`}>
                  <ChevronRight aria-hidden size={15} />
                </Link>
              ) : (
                <span className={btn("ghost", "sm", "pointer-events-none h-7 px-1.5 opacity-30")} aria-hidden>
                  <ChevronRight size={15} />
                </span>
              )}
            </nav>
          )}
        </div>
      }
    >
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-rule bg-surface px-4 py-3 text-[13px] sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Invoice number">{run.invoice_number ? <span className="num">{run.invoice_number}</span> : <Absent>not read</Absent>}</Fact>
        <Fact label="Invoice date">{formatDate(run.invoice_date) ?? <Absent>not read</Absent>}</Fact>
        <Fact label="Purchase order">
          {run.po_number ? <span className="num">{run.po_number}</span> : run.po_checked ? <Absent>none matched</Absent> : <Absent>not checked</Absent>}
        </Fact>
        <Fact label="Due (per terms)">{formatDate(run.due_date) ?? <Absent>{dueMissing(run)}</Absent>}</Fact>
        <Fact label={run.source === "email" ? "Emailed by" : "Uploaded by"}>
          <span className="flex min-w-0 items-center gap-1" title={run.source === "email" ? (run.sender_email ?? undefined) : undefined}>
            {run.source === "email" ? <Mail aria-hidden size={13} className="shrink-0 text-ink-3" /> : null}
            <span className="truncate">{run.source === "email" ? run.sender_email : `${run.uploader} (demo identity)`}</span>
          </span>
        </Fact>
        <Fact label="Received">
          {formatTime(run.created_at)} <span className="num text-ink-3">· {run.ref}</span>
        </Fact>
      </dl>
    </PageHeader>
  );
}

// ---- where it stands, the issues, and what to do

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
        ? `Approved for payment list by ${demoName(lastApproval?.approver_display_name)}, ${formatTime(lastApproval?.approved_at)}. Exported to payment list ${run.export_id}; finance pays from that list.`
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
      return "The document could not be read. Retrying keeps this invoice and its history.";
  }
}

const HEADLINE_ACCENT: Record<RunDetail["tone"], string> = {
  neutral: "border-l-carbon",
  muted: "border-l-muted-edge",
  ok: "border-l-stamp-ok",
  hold: "border-l-hold-edge",
  wait: "border-l-wait-edge",
  approved: "border-l-approved-bg",
  bad: "border-l-bad-fg",
};

function headline(run: RunDetail): string {
  if (run.exported) return "Approved and exported";
  if (run.state === "ON_HOLD") return `On hold: ${run.issues.length} issue${run.issues.length === 1 ? "" : "s"} to resolve`;
  if (run.state === "CLEARED") return run.notice ? "Cleared, but looks like a repeat" : "Cleared by every check";
  return run.state_label;
}

function Decision({ run, onChanged, done, setDone }: { run: RunDetail; onChanged: () => void; done: { text: string } | null; setDone: (d: { text: string } | null) => void }) {
  const showIssues = run.issues.length > 0 && run.state !== "SUPERSEDED";
  // Information codes (a correction linked, a price within tolerance, an AI line match verified by code): worth seeing,
  // never a reason to hold. One line each, by title.
  // U12: a MOCK run's line match came from the scripted MOCK proposer, so nothing may say "AI".
  const unAi = (t: string) => (readerSource(run) === "ai" ? t : t.replace(/\bAI\b/g, "MOCK"));
  const notes = inFlight(run) ? [] : run.info.filter((n, i, all) => all.findIndex((m) => m.code === n.code) === i).map((n) => ({ ...n, title: unAi(n.title) }));
  const { next, view } = useQueuePosition(run);
  return (
    <section aria-labelledby="decision-h" className="overflow-hidden rounded-lg border border-rule bg-surface">
      <div className={cx("border-b border-l-4 border-b-rule px-4 py-3.5", HEADLINE_ACCENT[run.tone])}>
        <h2 id="decision-h" className="text-[17px] font-semibold text-ink">
          {headline(run)}
        </h2>
        <p className="mt-0.5 max-w-[75ch] text-[14px] text-ink-2">{stateSentence(run)}</p>
        {inFlight(run) && <div className="reading-bar mt-3 h-1 rounded bg-carbon-wash" aria-hidden />}
        {run.failure && run.state === "FAILED" && <p className="mt-2 text-[13px] text-bad-fg">{run.failure}</p>}
      </div>
      {done && (
        <div className="border-b border-rule px-4 py-3">
          <Notice tone="success" live>
            <span className="font-semibold">{done.text}</span>
            {next && (
              <>
                {" "}
                <Link href={`/runs/${next.run_id}`} className="inline-flex items-center gap-1 font-semibold underline" onClick={() => setDone(null)}>
                  Next in {view.label.toLowerCase()}
                  <ArrowRight aria-hidden size={13} />
                </Link>
              </>
            )}
          </Notice>
        </div>
      )}
      {run.notice && (
        <div className="border-b border-rule px-4 py-3">
          <Notice tone="warn" title="Approval is not offered">
            {run.notice.replace(/^Approval is not offered: /, "")}
          </Notice>
        </div>
      )}
      {showIssues && (
        <div className="px-4 py-4">
          {run.state === "APPROVED" && <p className="mb-2 text-[13px] font-semibold text-ink-2">Approved with an exception despite:</p>}
          <ol className="space-y-3">
            {run.issues.map((i) => (
              <IssueCard key={`${i.codes.join("+")}-${i.line_no ?? ""}`} issue={i} run={run} />
            ))}
          </ol>
        </div>
      )}
      {notes.length > 0 && (
        <div className={cx("px-4 py-3 text-[13px]", showIssues && "border-t border-rule")}>
          <p className="font-semibold text-ink-2">Noted by the checks, not holding it</p>
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            {notes.map((n) => (
              <li key={n.code} className="flex items-center gap-1.5">
                <Check aria-hidden size={13} className="text-ok-fg" />
                {n.title}
                {(n.code === "CORRECTION_OF" || n.code === "CORRECTION_CANDIDATE_OF") && run.related.length > 0 && <span className="text-ink-3">(see related invoices)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.actions.length > 0 && (
        <div className={cx("bg-surface-2 px-4 py-4", (showIssues || run.notice) && "border-t border-rule")}>
          <Actions run={run} onChanged={onChanged} onDone={setDone} />
        </div>
      )}
    </section>
  );
}

const TIER_EDGE: Record<NonNullable<IssueView["tier"]>, string> = {
  identity: "border-l-bad-fg",
  twice: "border-l-bad-edge",
  po: "border-l-hold-edge",
  document: "border-l-muted-edge",
  check: "border-l-wait-edge",
};

/** The step that recorded a hold, so the reviewer can see which check found it (and that it was code, not the AI). */
function foundAt(run: RunDetail, codes: IssueView["codes"]): StageView | undefined {
  return run.stages.find((s) => s.findings.some((f) => codes.includes(f.code) && f.blocking));
}

function IssueCard({ issue, run }: { issue: IssueView; run: RunDetail }) {
  const stage = foundAt(run, issue.codes);
  const high = issue.tier === "identity" || issue.tier === "twice";
  return (
    <li className={cx("rounded-md border border-l-4 border-rule bg-surface", issue.tier ? TIER_EDGE[issue.tier] : "border-l-rule-strong")}>
      <div className="px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {issue.tier && <TierBadge tier={issue.tier} />}
          {issue.line_no != null && <span className="num rounded bg-muted-bg px-1.5 py-px text-[12px] font-medium text-ink-2">Line {issue.line_no}</span>}
          <span className="ml-auto">
            {stage ? (
              <SourceTag source="code" label={`Found by code, step ${stage.n}`} />
            ) : issue.codes.includes("MANUAL_HOLD") ? (
              <SourceTag source="person" label="Held by a reviewer" />
            ) : (
              <SourceTag source="code" />
            )}
          </span>
        </div>
        <h3 className={cx("mt-2 flex items-start gap-2 text-[15px] font-semibold", high ? "text-bad-fg" : "text-ink")}>
          {issue.tier && <TierIcon tier={issue.tier} className="mt-0.5 shrink-0" />}
          {issue.title}
        </h3>
        <p className="mt-1 max-w-[80ch] text-[14px] leading-relaxed text-ink">{issue.explain}</p>
        {issue.impact && (
          <p className="mt-2">
            <span className="num inline-flex items-center rounded border border-rule-strong bg-surface-2 px-2 py-0.5 text-[13px] font-semibold text-ink">{issue.impact}</span>
          </p>
        )}
        {issue.next && (
          <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
            <p className="text-[11px] font-semibold tracking-[0.05em] text-ink-3 uppercase">Safe next step</p>
            <p className="mt-0.5 text-ink">{issue.next}</p>
          </div>
        )}
        <p className="mt-2 flex flex-wrap gap-x-3 text-[11px] text-ink-3">
          {issue.tier && <span>{TIER_TEXT[issue.tier].why}</span>}
          <span className="font-mono">{issue.codes.join(" + ")}</span>
        </p>
      </div>
    </li>
  );
}

// ---- actions: each one opens a dialog that says what it will do, then calls the same API as before

const ACTION_ICON: Partial<Record<ReviewAction, Icon>> = {
  approve: BadgeCheck,
  override_approve: BadgeCheck,
  request_correction: Mail,
  retry: RotateCw,
  confirm_link: CircleCheck,
  replace_approved: CircleCheck,
};

type Confirm = { action: ReviewAction; problems: string[]; kind: "po" | "callback"; reason: string };
type CallState = { number: string; spoke: string; when: string };

/** The browser's local time now, in the format a datetime-local input takes ("2026-10-23T09:40"). */
function localNow(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Actions({ run, onChanged, onDone }: { run: RunDetail; onChanged: () => void; onDone: (d: { text: string } | null) => void }) {
  const { name } = useIdentity();
  const [open, setOpen] = useState<ReviewAction | null>(null);
  const [note, setNote] = useState("");
  const [po, setPo] = useState("");
  const [call, setCall] = useState<CallState>({ number: "", spoke: "", when: "" });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmed, setConfirmed] = useState<{ po: boolean; callback: boolean }>({ po: false, callback: false });
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = run.actions.find((a) => a.action === open) ?? null;
  const reset = () => {
    setNote("");
    setPo("");
    setCall({ number: "", spoke: "", when: "" });
    setConfirm(null);
    setConfirmed({ po: false, callback: false });
    setErr(null);
  };
  const close = () => {
    setOpen(null);
    reset();
  };

  async function submit(action: ReviewAction, extra: Record<string, unknown> = {}, doneText?: string) {
    if (!name) return setErr("Choose who you are acting as (in the side menu) first. Every action records that name.");
    setPending(true);
    setErr(null);
    try {
      await api.act(run.run_id, { action, actor: name, note: note.trim() || null, expectedVersion: run.version, ...extra });
      onDone({ text: doneText ?? `${ACTION_TEXT[action].done}.` });
      setOpen(null);
      reset();
      onChanged();
    } catch (e) {
      if (isRefusal(e) && e.code === "NEEDS_CONFIRMATION") {
        setConfirm({ action, problems: e.details?.problems ?? [e.reason], kind: e.details?.confirm === "callback" ? "callback" : "po", reason: e.reason });
      } else setErr(errorText(e));
    } finally {
      setPending(false);
    }
  }

  /** What the open form adds to the request: the PO named (C4b), the callback record (Q9) and any confirmations given. */
  const extras = (opt: ActionOption | null | undefined, given = confirmed): Record<string, unknown> => ({
    ...(opt?.po_choices ? { poNumber: po } : {}),
    ...(opt?.callback ? { callback: { number_called: call.number, spoke_to: call.spoke, called_at: call.when ? new Date(call.when).toISOString() : "" } } : {}),
    ...(given.callback ? { confirmCallback: true } : {}),
    ...(given.po ? { confirmFailingChecks: true } : {}),
  });

  // U05: the recommended action leads; with none, every option is shown alike and the reviewer decides.
  const rec = run.recommended;
  const ordered = [...run.actions].sort((a, b) => Number(b.action === rec?.action) - Number(a.action === rec?.action));
  const variantOf = (a: ActionOption) =>
    a.action === rec?.action
      ? a.action === "approve" || a.action === "override_approve" || a.action === "confirm_link" || a.action === "replace_approved"
        ? "approve"
        : "primary"
      : a.action === "reject"
        ? "danger"
        : "secondary";

  return (
    <div>
      {rec ? (
        <p className="mb-3 text-[13px] text-ink-2">
          <span className="font-semibold text-ink">Recommended: {ACTION_TEXT[rec.action].label.toLowerCase()}.</span> {rec.why}
        </p>
      ) : run.state === "ON_HOLD" ? (
        <p className="mb-3 text-[13px] text-ink-2">
          <span className="font-semibold text-ink">No button is recommended: this needs your judgement first.</span>{" "}
          {run.issues.some((i) => i.tier === "identity")
            ? "Call the vendor on the vendor-master number. Approving with an exception asks you to record that call."
            : run.issues.some((i) => i.tier === "twice")
              ? "Compare this invoice with the related one before deciding."
              : "Do the check described above, then decide."}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {ordered.map((a) => (
          <Button
            key={a.action}
            variant={variantOf(a)}
            icon={ACTION_ICON[a.action]}
            disabled={pending}
            busy={pending && a.action === "retry"}
            aria-haspopup={a.action === "retry" ? undefined : "dialog"}
            onClick={() => {
              onDone(null);
              reset();
              if (a.action === "retry") return void submit("retry");
              if (a.callback) setCall({ number: "", spoke: "", when: localNow() });
              setOpen(a.action);
            }}
          >
            {ACTION_TEXT[a.action].label}
          </Button>
        ))}
      </div>
      {err && !open && (
        <Notice tone="error" live className="mt-3">
          {err}
        </Notice>
      )}
      {!name && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-hold-fg">
          <TriangleAlert aria-hidden size={13} />
          Choose who you are acting as in the side menu before you act. It is recorded on every action.
        </p>
      )}

      {current?.action === "approve" && <ApproveDialog run={run} pending={pending} err={err} onClose={close} onConfirm={() => submit("approve")} />}
      {current?.action === "request_correction" && run.correction_draft && <CorrectionDialog run={run} pending={pending} err={err} onClose={close} submit={submit} />}
      {current && current.needsNote && (
        <NoteDialog
          run={run}
          option={current}
          note={note}
          setNote={setNote}
          po={po}
          setPo={setPo}
          call={call}
          setCall={setCall}
          confirm={confirm}
          pending={pending}
          err={err}
          onClose={close}
          onSubmit={() => submit(current.action, extras(current))}
          onConfirm={() => {
            if (!confirm) return;
            const given = { ...confirmed, [confirm.kind]: true };
            setConfirmed(given);
            submit(
              confirm.action,
              extras(
                run.actions.find((a) => a.action === confirm.action),
                given,
              ),
            );
          }}
        />
      )}
    </div>
  );
}

function ApproveDialog({ run, pending, err, onClose, onConfirm }: { run: RunDetail; pending: boolean; err: string | null; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Approve for the payment list"
      description="Every check passed. Approving puts it on the next payment list export; finance pays from that list, not this tool."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="approve" icon={BadgeCheck} disabled={pending} busy={pending} onClick={onConfirm}>
            {pending ? "Approving" : `Approve ${run.total ?? ""}`}
          </Button>
        </>
      }
    >
      <SummaryBox run={run} />
      {err && (
        <Notice tone="error" live className="mt-3">
          {err}
        </Notice>
      )}
    </Dialog>
  );
}

function SummaryBox({ run }: { run: RunDetail }) {
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-md border border-rule bg-surface-2 px-3 py-2.5 text-[13px]">
      <Fact label="Vendor">{run.vendor ?? <Absent>not read</Absent>}</Fact>
      <Fact label="Total">
        <span className="num">{run.total ?? "not read"}</span>
      </Fact>
      <Fact label="Invoice">
        <span className="num">{run.invoice_number ?? "no number"}</span>
        {run.invoice_date && <span className="text-ink-3">, {formatDate(run.invoice_date)}</span>}
      </Fact>
      <Fact label="Purchase order">{run.po_number ?? <Absent>none matched</Absent>}</Fact>
    </dl>
  );
}

function NoteDialog({
  run,
  option,
  note,
  setNote,
  po,
  setPo,
  call,
  setCall,
  confirm,
  pending,
  err,
  onClose,
  onSubmit,
  onConfirm,
}: {
  run: RunDetail;
  option: ActionOption;
  note: string;
  setNote: (s: string) => void;
  po: string;
  setPo: (s: string) => void;
  call: CallState;
  setCall: (c: CallState) => void;
  confirm: Confirm | null;
  pending: boolean;
  err: string | null;
  onClose: () => void;
  onSubmit: () => void;
  onConfirm: () => void;
}) {
  const a = option.action;
  const isOverride = a === "override_approve";
  const ready = note.trim() && (!option.po_choices || po) && (!option.callback || (call.number.trim() && call.spoke.trim() && call.when));
  const DESCRIPTION: Partial<Record<ReviewAction, string>> = {
    override_approve: "Approves it for the payment list even though the checks below held it. Your name, your note and anything you confirm are kept in the history.",
    reject: "It will not go on the payment list. The vendor is not told automatically.",
    manual_hold: "Takes it out of the approval queue until someone resolves what your note describes.",
    stop_waiting: "Stops waiting for the vendor's correction and puts it back on hold for a decision.",
    confirm_link: "Records that this is the vendor's corrected copy: it replaces the held invoice and is approved for the payment list.",
    replace_approved: "This invoice replaces the approved one with the same number, which comes off the payment list.",
    process_as_invoice: "Runs every invoice check on this document, as if it had been read as an invoice.",
  };
  return (
    <Dialog
      open
      wide={Boolean(option.callback) || isOverride}
      onClose={onClose}
      title={ACTION_TEXT[a].label}
      description={DESCRIPTION[a]}
      footer={
        confirm ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="danger-solid" disabled={pending} busy={pending} onClick={onConfirm}>
              {confirm.kind === "callback" ? "Confirm and approve" : "Approve anyway"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="action-form"
              variant={a === "reject" ? "danger-solid" : isOverride || a === "confirm_link" || a === "replace_approved" ? "approve" : "primary"}
              disabled={pending || !ready}
              busy={pending}
            >
              {pending ? "Saving" : ACTION_TEXT[a].label}
            </Button>
          </>
        )
      }
    >
      <form
        id="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onSubmit();
        }}
        className="space-y-4"
      >
        <SummaryBox run={run} />
        {isOverride && run.issues.length > 0 && (
          <div>
            <p className="text-[13px] font-semibold text-ink">You are approving despite</p>
            <ul className="mt-1.5 space-y-1">
              {run.issues.map((i) => (
                <li key={`${i.codes.join("+")}-${i.line_no ?? ""}`} className="flex flex-wrap items-center gap-2 text-[13px]">
                  {i.tier && <TierBadge tier={i.tier} short />}
                  <span>
                    {i.title}
                    {i.line_no != null && <span className="text-ink-3"> (line {i.line_no})</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {option.callback && <CallbackFields need={option.callback} vendor={run.vendor} call={call} setCall={setCall} />}
        {option.po_choices && (
          <Field label="Which purchase order is this for?" hint="No PO was found on the invoice. Approving counts it against the PO you choose." htmlFor="po-choice">
            {option.po_choices.length > 0 ? (
              <select id="po-choice" required value={po} onChange={(e) => setPo(e.target.value)} className={cx(inputCls, "max-w-xs")}>
                <option value="">Choose a PO</option>
                {option.po_choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <Notice tone="error">This vendor has no open purchase order, so it cannot be approved against one. Reject it or request a correction.</Notice>
            )}
          </Field>
        )}
        <Field label="Why?" hint="Required. Kept in the history with your name." htmlFor="note">
          <textarea
            id="note"
            required
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputCls}
            placeholder={
              a === "reject"
                ? "For example: price not agreed, vendor will reissue"
                : option.callback
                  ? "For example: called the master number, spoke to the accounts head, account change confirmed"
                  : "For example: confirmed with the vendor by phone"
            }
          />
        </Field>
        {confirm && (
          <Notice
            tone="error"
            title={
              confirm.kind === "callback"
                ? `${confirm.reason.replace(/\. Confirm again to approve$/, "")}. Approve only if the call settled this:`
                : "Approving this goes past these checks:"
            }
            live
          >
            <ul className="mt-1 list-disc pl-4">
              {confirm.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}
        {err && (
          <Notice tone="error" live>
            {err}
          </Notice>
        )}
      </form>
    </Dialog>
  );
}

/** Spec v1.4 row 9 (Q9): the call that confirmed a bank, vendor or sender hold, entered before the override. */
function CallbackFields({ need, vendor, call, setCall }: { need: NonNullable<ActionOption["callback"]>; vendor: string | null; call: CallState; setCall: (c: CallState) => void }) {
  return (
    <fieldset className="rounded-md border border-bad-edge bg-bad-bg/40 p-3">
      <legend className="flex items-center gap-1.5 px-1 text-[13px] font-semibold text-bad-fg">
        <Phone aria-hidden size={14} />
        Call the vendor first
      </legend>
      <p className="text-[13px] text-ink">
        {need.master_phone ? (
          <>
            Call {vendor ?? "the vendor"} on <span className="num font-semibold">{need.master_phone}</span>, the number in the vendor master. Never use a number printed on the
            invoice or in the email: if the invoice is fraudulent, that number reaches the fraudster.
          </>
        ) : (
          <>This vendor is not in the vendor master, so there is no trusted number. Use one you can trust, and say in the note how you know it is theirs.</>
        )}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Field label="Number called" htmlFor="cb-number">
          <input id="cb-number" type="tel" required value={call.number} onChange={(e) => setCall({ ...call, number: e.target.value })} className={cx("num", inputCls)} />
        </Field>
        <Field label="Spoke to" htmlFor="cb-spoke">
          <input
            id="cb-spoke"
            type="text"
            required
            value={call.spoke}
            onChange={(e) => setCall({ ...call, spoke: e.target.value })}
            placeholder="Name and role"
            className={inputCls}
          />
        </Field>
        <Field label="When" htmlFor="cb-when">
          <input id="cb-when" type="datetime-local" required value={call.when} onChange={(e) => setCall({ ...call, when: e.target.value })} className={cx("num", inputCls)} />
        </Field>
      </div>
    </fieldset>
  );
}

function CorrectionDialog({
  run,
  pending,
  err,
  onClose,
  submit,
}: {
  run: RunDetail;
  pending: boolean;
  err: string | null;
  onClose: () => void;
  submit: (a: ReviewAction, extra?: Record<string, unknown>, doneText?: string) => void;
}) {
  const d = run.correction_draft!;
  const canSend = Boolean(d.send && d.to);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Request a correction"
      description={
        canSend ? (
          <>
            Written by code from the holds the vendor can fix; checks on our side are not mentioned. Nothing is sent until you press{" "}
            <span className="font-semibold">Send email</span>.
          </>
        ) : (
          "Email sending is not connected on this deployment. Copy the text into your own email, send it, then mark it as sent here."
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={canSend ? "secondary" : "primary"} icon={MailCheck} disabled={pending} onClick={() => submit("request_correction", { channel: "marked sent manually" })}>
            Mark as sent manually
          </Button>
          {canSend && (
            <Button
              variant="primary"
              icon={Send}
              disabled={pending}
              busy={pending}
              onClick={() => submit("request_correction", { channel: "sent" }, `Correction email sent to ${d.to} with reference ${d.token}.`)}
            >
              {pending ? "Sending" : "Send email"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded border border-dashed border-ink-3 px-1.5 py-px text-[11px] font-semibold tracking-[0.04em] text-ink-2 uppercase">
            Draft, not sent
          </span>
          <SourceTag source="code" label="Written by code" />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-rule bg-surface-2 px-3 py-2 text-[13px]">
          <dt className="text-ink-3">To</dt>
          <dd className="font-medium break-all">{d.to ?? <Absent>no registered address: copy it into an email to the vendor</Absent>}</dd>
          {d.send && (
            <>
              <dt className="text-ink-3">From</dt>
              <dd className="break-all">{d.send.from}</dd>
              <dt className="text-ink-3">Replies to</dt>
              <dd className="break-all">{d.send.reply_to}</dd>
            </>
          )}
          <dt className="text-ink-3">Reference</dt>
          <dd className="num">{d.token}</dd>
          <dt className="text-ink-3">Subject</dt>
          <dd className="font-medium">{d.subject}</dd>
        </dl>
        {run.blocking.some((c) => c.code === "MANUAL_HOLD") && (
          <Notice tone="warn">The reason in the email is the hold note, quoted word for word. Check it is fit for the vendor before you send it.</Notice>
        )}
        <pre className="max-h-72 overflow-auto rounded-md border border-rule bg-surface p-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{d.body}</pre>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
            className={btn("secondary", "sm")}
          >
            <Copy aria-hidden size={14} />
            {copied ? "Copied" : "Copy email text"}
          </button>
          {copied === false && <span className="text-bad-fg">Copying is blocked in this browser. Select the text and copy it yourself.</span>}
          <span>The vendor&apos;s reply is linked to this invoice by the reference and checked again from the start.</span>
        </div>
        {err && (
          <Notice tone="error" live>
            {err}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}
