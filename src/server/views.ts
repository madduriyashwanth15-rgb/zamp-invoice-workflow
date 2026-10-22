import type { ReasonCode } from "@/domain/codes";
import { REASON_CODES } from "@/domain/codes";
import Decimal from "decimal.js";
import type { Finding, LineMatch, ReferenceData, StageStatus } from "@/domain/engine/types";
import { paiseToRupees } from "@/domain/money";
import { availableActions, vendorCanFix, type ActionOption } from "@/domain/runs/queries";
import type { Approval, AuditEvent, CorrectionRequest, ExportRecord, Logs, RunRecord, StoreState, StoredDocument } from "@/domain/runs/types";
import { nextToken } from "@/domain/runs/actions";
import { formatDate, formatInr } from "@/lib/format";
import { CODE_TEXT, STATE_TEXT, type Tone } from "@/lib/reason-text";
import { holdNoteOf, issuesOf, readerName, recommendedAction, unitInr, vendorReasons, type ExplainContext, type IssueView, type Recommended } from "./explain";

// JSON view models for the UI (no bigint, no internal objects). Presentation only: every value comes from the run.

export interface CodeView {
  code: ReasonCode;
  kind: string;
  title: string;
  next: string | null;
}

export interface RunSummary {
  run_id: string;
  ref: string;
  state: RunRecord["state"];
  state_label: string;
  tone: Tone;
  source: RunRecord["source"];
  received_from: string | null;
  vendor: string | null;
  vendor_known: boolean;
  /** False when the vendor check did not run (document skipped, or not read yet): "not found" would be untrue. */
  vendor_checked: boolean;
  invoice_number: string | null;
  invoice_date: string | null;
  total: string | null;
  po_number: string | null;
  /** False when the purchase-order check did not run, so "none matched" would be untrue. */
  po_checked: boolean;
  due_date: string | null;
  primary: CodeView | null;
  blocking_count: number;
  exported: boolean;
  export_id: string | null;
  export_blocked: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  filename: string | null;
}

export interface FindingView extends CodeView {
  message: string;
  evidence: { key: string; value: string }[];
  line_no: number | null;
  blocking: boolean;
}

/** A stage note in plain words. `rule` is the spec rule it comes from (K1, V2...), shown small for auditors. */
export interface NoteView {
  rule: string | null;
  text: string;
  /** Set on reviewer actions; the browser formats it in the viewer's time zone. */
  at?: string;
}

export interface StageView {
  n: number;
  id: string;
  title: string;
  /** Who did the work: code, an AI model (named), or a person. */
  by: string;
  by_ai: boolean;
  status: StageStatus | "running" | "pending" | "failed" | "awaiting_review" | "reviewed" | "not_needed";
  /** Overrides the default status wording (the reviewer step shows the run's state). */
  status_text: string | null;
  notes: NoteView[];
  findings: FindingView[];
}

/** One invoice line set against the PO, formatted for the comparison table. Presentation only. */
export interface PoRowView {
  invoice_line: number;
  description: string;
  /** "100 pcs × ₹42.00", or "Lump sum" when there is no quantity. */
  billed: string;
  amount: string | null;
  status: LineMatch["status"];
  /** Blocking findings on this line, in short words ("Price over"); empty when the line is fine. */
  flags: string[];
  /** "Matches the PO", "Charge on the PO"... when there are no flags. */
  ok_text: string | null;
  po_line: string | null;
  po_price: string | null;
  invoice_price: string | null;
  price_diff: string | null;
  quantity: string | null;
  /** Set when the line was matched by a proposal (AI or MOCK) that code verified. */
  matched_by: string | null;
}

export interface PoTableView {
  po_number: string;
  po_status: string | null;
  po_value: string | null;
  how_found: string;
  rows: PoRowView[];
}

export interface RunDetail extends RunSummary {
  failure: string | null;
  sender_email: string | null;
  uploader: string | null;
  subject: string | null;
  reply_token: string | null;
  extracted_by: RunRecord["extracted_by"];
  extraction: RunRecord["extraction"];
  document: (Omit<StoredDocument, "text_layer"> & { text_chars: number }) | null;
  stages: StageView[];
  blocking: CodeView[];
  info: CodeView[];
  actions: ActionOption[];
  approvals: Approval[];
  corrections: CorrectionRequest[];
  exports: ExportRecord[];
  events: AuditEvent[];
  related: RunSummary[];
  token_active: string | null;
  /** The holds in plain words with their figures, most severe first (audit U01). */
  issues: IssueView[];
  /** The action to lead with, or null when the next step is a person's judgement (audit U05). */
  recommended: Recommended | null;
  /** Invoice lines against the matched PO; null when no PO was matched or the run predates line matches. */
  po_table: PoTableView | null;
  /** Correction email built by code from the run's own facts (spec 13); null when no correction can be requested. */
  correction_draft: {
    to: string | null;
    subject: string;
    body: string;
    token: string;
    /** Set when the app can send the email itself (Resend configured); otherwise only "mark sent manually". */
    send: { from: string; reply_to: string } | null;
  } | null;
}

const codeView = (code: ReasonCode): CodeView => ({
  code, kind: REASON_CODES[code].kind, title: CODE_TEXT[code]?.title ?? code, next: CODE_TEXT[code]?.next ?? null,
});

const fmtRupees = (p: bigint | null) => (p == null ? null : formatInr(paiseToRupees(p)));

/** True when the engine actually ran this stage (not skipped because of an earlier result). */
const evaluated = (run: RunRecord, stage: string) =>
  run.engine?.stages.some((s) => s.stage === stage && s.status !== "not_evaluated") ?? false;

export function summarize(run: RunRecord, ref: ReferenceData): RunSummary {
  const vendor = run.vendor_id ? ref.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  const primary = run.primary_reason ? codeView(run.primary_reason) : null;
  return {
    run_id: run.run_id, ref: run.ref, state: run.state, state_label: STATE_TEXT[run.state].label, tone: STATE_TEXT[run.state].tone,
    source: run.source, received_from: run.source === "email" ? run.sender_email : run.uploader_display_name,
    vendor: vendor?.legal_name ?? run.extraction?.vendor_name ?? null, vendor_known: Boolean(vendor),
    vendor_checked: Boolean(vendor) || evaluated(run, "vendor"),
    invoice_number: run.extraction?.invoice_number ?? null, invoice_date: run.invoice_date ?? run.extraction?.invoice_date ?? null,
    total: run.total_paise != null ? fmtRupees(run.total_paise) : formatInr(run.extraction?.total),
    po_number: run.po_number, po_checked: Boolean(run.po_number) || evaluated(run, "po"), due_date: run.due_date,
    primary: run.state === "CLEARED" || run.state === "APPROVED" || run.state === "SUPERSEDED" ? null : primary,
    blocking_count: run.blocking_codes.length, exported: run.exported, export_id: run.export_id, export_blocked: run.export_blocked,
    version: run.version, created_at: run.created_at, updated_at: run.updated_at, filename: run.filename,
  };
}

function findingView(f: Finding, blocking: boolean): FindingView {
  return {
    ...codeView(f.code), message: f.message, line_no: f.line_no ?? null, blocking,
    evidence: Object.entries(f.evidence).map(([key, v]) => ({ key: key.replace(/_/g, " "), value: Array.isArray(v) ? v.join(", ") : v == null ? "none" : String(v) })),
  };
}

const ENGINE_STAGE_NO: Record<string, number> = { classify: 2, document: 3, vendor: 4, duplicates: 5, po: 6, lines: 7, compare: 8, decide: 9 };
const ENGINE_TITLES: Record<string, string> = {
  classify: "Is it an invoice?",
  document: "Does the document hold together?",
  vendor: "Vendor, sender and bank details",
  duplicates: "Duplicates and corrections",
  po: "Which purchase order?",
  lines: "Lines matched to the PO",
  compare: "Prices and quantities against the PO",
  decide: "Decision",
};

const NOT_CHECKED_WHY: Record<string, string> = {
  "skipped at G1": "this document is not an invoice",
  "vendor unknown": "the vendor is not in the vendor master",
  "rejected as a duplicate": "the invoice was rejected as a duplicate",
  "no PO": "no purchase order was matched",
};

/**
 * Engine notes are written for the audit trail ("K1: ...", "not evaluated: skipped at G1", "Outcome: ON_HOLD").
 * The screen shows the same facts in plain words, with the rule id kept separately (shown small).
 */
export function plainNote(note: string, reader = "The AI"): NoteView {
  const m = /^([A-Z]\d+(?:[-/][A-Z]?\d+)*)( not evaluated)?:\s*(.*)$/s.exec(note);
  const rule = m ? m[1] : null;
  let text = m ? (m[2] ? `not evaluated: ${m[3]}` : m[3]) : note;
  const skipped = /^not evaluated:\s*(.*)$/s.exec(text);
  if (skipped) text = `Not checked: ${NOT_CHECKED_WHY[skipped[1]] ?? skipped[1]}`;
  const outcome = /^Outcome: ([A-Z_]+)$/.exec(text);
  if (outcome) text = `Decision: ${STATE_TEXT[outcome[1] as RunRecord["state"]]?.label ?? outcome[1]}`;
  const due = /^Due \(per terms\): (\d{4}-\d{2}-\d{2}) \((\d+) days\)$/.exec(text);
  if (due) text = `Due (per terms): ${formatDate(due[1])}, ${due[2]} days after the invoice date`;
  const ai = /^AI doc_type: ([^;]*); title "([^"]*)"; number label "([^"]*)"$/.exec(text);
  if (ai) text = `${reader} read it as ${ai[1] === "invoice" ? "an invoice" : `a ${ai[1].replace(/_/g, " ")}`}${ai[2] ? `, titled "${ai[2]}"` : ""}${ai[3] ? `, number labelled "${ai[3]}"` : ""}`;
  return { rule, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

const plain = (text: string): NoteView => ({ rule: null, text });

/** Engine notes name other runs by id; people know them by reference. */
function refsFor(runs: Map<string, RunRecord>) {
  const pairs = [...runs.values()].map((r) => [r.run_id, r.ref] as const);
  return (text: string) => pairs.reduce((t, [id, ref]) => (t.includes(id) ? t.split(id).join(ref) : t), text);
}

function stagesOf(run: RunRecord, named: (t: string) => string = (t) => t): StageView[] {
  const reader = readerName(run);
  const intake: StageView = {
    n: 0, id: "intake", title: run.source === "email" ? "Received by email" : "Uploaded", by: "Code", by_ai: false, status: "passed", status_text: null,
    notes: (run.source === "email"
      ? [`From ${run.sender_email ?? "unknown sender"}`, ...(run.subject ? [`Subject "${run.subject}"`] : []), ...(run.reply_token ? [`Reply token ${run.reply_token}`] : [])]
      : [`Uploaded by ${run.uploader_display_name ?? "unknown"} (demo identity)`]).map(plain),
    findings: [],
  };
  if (run.state === "SKIPPED" && !run.extraction && run.primary_reason) {
    intake.status = "skipped";
    if (run.failure) intake.notes.push(plain(run.failure));
    intake.findings = [{ ...codeView(run.primary_reason), message: run.failure ?? "", evidence: [], line_no: null, blocking: true }];
    return [intake];
  }
  const label = run.extracted_by?.extractor ?? null;
  const ai = Boolean(label && /gemini/i.test(label));
  const read: StageView = {
    n: 1, id: "read", title: "Read the document", by: label ?? "Extractor", by_ai: ai, status_text: null,
    status: run.state === "RECEIVED" ? "pending" : run.state === "PROCESSING" && !run.extraction ? "running" : run.extraction ? "passed" : "failed",
    notes: [], findings: [],
  };
  if (run.extracted_by) {
    const mock = reader === "The MOCK reading";
    read.notes.push(plain(mock ? "Values from the MOCK answer key for this test file; no AI was called"
      : run.extracted_by.cached ? "Answer reused from the cache (same file, prompt and model)"
      : `${run.extracted_by.attempts} call${run.extracted_by.attempts === 1 ? "" : "s"} to the model`));
    for (const r of run.extracted_by.retries ?? []) read.notes.push(plain(`Retried: ${r}`));
  }
  if (run.extraction) read.notes.push(plain(`Read as ${run.extraction.doc_type.replace(/_/g, " ")}, titled "${run.extraction.document_title ?? "no title"}"`));
  if (run.failure && !run.extraction) read.notes.push(plain(run.failure));
  if (run.blocking_codes.includes("EXTRACTION_FAILED") && !run.engine) {
    read.status = "held";
    read.findings = [{ ...codeView("EXTRACTION_FAILED"), message: `${reader === "The AI" ? "The model's" : `${reader}'s`} answer failed validation twice`, evidence: [], line_no: null, blocking: true }];
  }
  const out = [intake, read];
  if (!run.engine) return out;
  for (const st of run.engine.stages) {
    const blockingSet = new Set(run.engine.blocking.map((f) => `${f.code}|${f.stage}|${f.line_no ?? ""}|${f.message}`));
    const usedAi = st.findings.some((f) => f.code === "LINE_MAPPED_AI_VERIFIED" || f.code === "AI_PROPOSAL_REJECTED");
    out.push({
      n: ENGINE_STAGE_NO[st.stage], id: st.stage, title: ENGINE_TITLES[st.stage] ?? st.label,
      by: usedAi ? "Code (checked an AI line proposal)" : "Code", by_ai: false,
      status: st.status, status_text: null, notes: st.notes.map((n) => plainNote(named(n), reader)),
      findings: st.findings.map((f) => {
        const v = findingView(f, blockingSet.has(`${f.code}|${f.stage}|${f.line_no ?? ""}|${f.message}`));
        return { ...v, message: named(v.message), evidence: v.evidence.map((e) => ({ ...e, value: named(e.value) })) };
      }),
    });
  }
  return out;
}

/** What a reviewer's state change did, in words. Keyed by the section 11 row recorded on the event. */
function reviewerAction(e: AuditEvent): string {
  switch (e.to_state) {
    case "APPROVED":
      return e.transition === 9 || e.transition === 14 ? "Approved with an exception" : "Approved for the payment list";
    case "ON_HOLD":
      return e.transition === 13 ? "Stopped waiting for the vendor; back on hold" : "Put on hold";
    case "REJECTED":
      return "Rejected";
    case "AWAITING_VENDOR":
      return "Requested a correction from the vendor";
    case "PROCESSING":
      return e.transition === 5 ? "Processed it as an invoice" : "Retried reading";
    case "SUPERSEDED":
      return e.transition === 17 ? "Replaced it with the newer invoice" : "Confirmed the vendor's correction replaces it";
    default:
      return `${STATE_TEXT[e.from_state!]?.label ?? e.from_state} to ${STATE_TEXT[e.to_state!]?.label ?? e.to_state}`;
  }
}

const WAITING_NOTE: Partial<Record<RunRecord["state"], string>> = {
  CLEARED: "Nothing goes on the payment list until a reviewer approves it.",
  ON_HOLD: "A reviewer decides: request a correction, approve with an exception, or reject.",
  FAILED: "A reviewer can retry reading it.",
};

/** Why a skipped run needs nothing (U12): the reason depends on what was skipped, not only "not an invoice". */
const SKIP_WHY: Partial<Record<ReasonCode, string>> = {
  NOT_INVOICE: "Not an invoice, so there is nothing to approve.",
  UNSUPPORTED_FILE: "The file type or size is not supported, so nothing was read. The vendor has to send a PDF, PNG or JPEG under 4 MB.",
  NO_ATTACHMENT: "The email had no attachment, so there is nothing to approve.",
};

const NOTHING_TO_DO: Partial<Record<RunRecord["state"], string>> = {
  SKIPPED: "Not processed as an invoice, so there is nothing to approve.",
  REJECTED: "Rejected by the checks, so there is nothing to approve.",
  SUPERSEDED: "Replaced by the vendor's corrected invoice, which is reviewed instead.",
  FAILED: "The file could not be fetched; the vendor has to send it again.",
};

/**
 * The last step of the routing slip: what a person did after the checks. Built from the audit log (human state
 * changes and exports), so it shows only what was recorded.
 */
export function reviewStage(run: RunRecord, events: AuditEvent[], actions: ActionOption[]): StageView | null {
  if (run.state === "RECEIVED" || run.state === "PROCESSING") return null;
  const human = events.filter((e) => e.actor !== "system" && ((e.type === "STATE_CHANGED" && e.to_state) || e.type === "EXPORTED"));
  const notes: NoteView[] = human.map((e) => {
    const what = e.type === "EXPORTED" ? `Exported to payment list ${String((e.details ?? {}).export_id ?? "")}`.trim() : reviewerAction(e);
    return { rule: null, text: `${what} by ${e.actor} (demo identity)${e.note ? `. Note: ${e.note}` : ""}`, at: e.at };
  });
  const waiting = actions.length > 0 && (run.state === "CLEARED" || run.state === "ON_HOLD" || run.state === "FAILED");
  let status: StageView["status"];
  let status_text: string | null;
  if (waiting) {
    status = "awaiting_review";
    status_text = "Waiting for a reviewer";
    notes.push(plain(WAITING_NOTE[run.state] ?? ""));
  } else if (human.length > 0) {
    status = "reviewed";
    status_text = run.exported ? "Approved and exported" : STATE_TEXT[run.state].label;
  } else {
    status = "not_needed";
    status_text = "No action needed";
    notes.push(plain((run.state === "SKIPPED" && run.primary_reason ? SKIP_WHY[run.primary_reason] : undefined) ?? NOTHING_TO_DO[run.state] ?? "Nothing for a reviewer to do."));
    if (actions.some((a) => a.action === "process_as_invoice")) notes.push(plain("If it is an invoice after all, a reviewer can process it as one."));
  }
  return { n: 10, id: "review", title: "Reviewer decision", by: "Person (demo identity)", by_ai: false, status, status_text, notes, findings: [] };
}

export function detail(run: RunRecord, state: Pick<StoreState, "runs" | "documents" | "tokens">, logs: Logs, ref: ReferenceData): RunDetail {
  const doc = state.documents.get(run.run_id);
  const relatedIds = new Set<string>([
    ...run.supersedes_run_ids, ...(run.superseded_by_run_id ? [run.superseded_by_run_id] : []),
    ...(run.engine?.correction?.hold_family_run_ids ?? []), ...(run.engine?.dispute ? [run.engine.dispute.counterpart_run_id] : []),
  ]);
  for (const r of state.runs.values()) {
    if (r.run_id !== run.run_id && run.chain_key && r.chain_key === run.chain_key) relatedIds.add(r.run_id);
    if (r.engine?.dispute?.counterpart_run_id === run.run_id || r.engine?.correction?.hold_family_run_ids.includes(run.run_id)) relatedIds.add(r.run_id);
  }
  relatedIds.delete(run.run_id);
  const token = [...state.tokens].find(([, id]) => id === run.run_id)?.[0] ?? null;
  const actions = availableActions(run, state, ref);
  const review = reviewStage(run, logs.events, actions);
  const ctx = explainContext(run, state, ref, logs.events, actions);
  return {
    ...summarize(run, ref),
    failure: run.failure, sender_email: run.sender_email, uploader: run.uploader_display_name, subject: run.subject, reply_token: run.reply_token,
    extracted_by: run.extracted_by, extraction: run.extraction,
    document: doc ? { run_id: doc.run_id, filename: doc.filename, content_type: doc.content_type, size_bytes: doc.size_bytes, sha256: doc.sha256, has_text_layer: doc.has_text_layer, body_text: doc.body_text, text_chars: doc.text_layer.length } : null,
    stages: [...stagesOf(run, refsFor(state.runs as Map<string, RunRecord>)), ...(review ? [review] : [])],
    blocking: run.blocking_codes.map(codeView),
    info: run.info_codes.map(codeView),
    actions,
    approvals: logs.approvals, corrections: logs.corrections, exports: logs.exports, events: logs.events,
    related: [...relatedIds].map((id) => state.runs.get(id)).filter((r): r is RunRecord => Boolean(r)).map((r) => summarize(r, ref)),
    token_active: run.state === "AWAITING_VENDOR" || run.state === "ON_HOLD" ? token : null,
    issues: issuesOf(ctx),
    recommended: recommendedAction(run, actions),
    po_table: poTable(run, ref),
    correction_draft: run.state === "ON_HOLD" && vendorCanFix(run) ? { ...correctionDraft(run, nextToken(state, run), ref, ctx.holdNote), send: null } : null,
  };
}

/** Everything the explanations need from the store, gathered once. */
export function explainContext(
  run: RunRecord, state: Pick<StoreState, "runs">, ref: ReferenceData, events: AuditEvent[], actions?: ActionOption[],
): ExplainContext {
  const refOf = (id: string) => state.runs.get(id)?.ref ?? id;
  const disputedBy = [...state.runs.values()].filter((r) => r.run_id !== run.run_id && r.engine?.dispute?.counterpart_run_id === run.run_id && (r.state === "ON_HOLD" || r.state === "AWAITING_VENDOR"));
  return { run, ref, refOf, disputedBy, holdNote: holdNoteOf(events), actions };
}

const FLAG: Partial<Record<ReasonCode, string>> = {
  PRICE_OVER_TOLERANCE: "Price over", QTY_EXCEEDS_PO: "Quantity over", TAX_RATE_MISMATCH: "GST rate differs", UNAPPROVED_CHARGE: "Charge not approved",
  LINE_UNMAPPED: "Not matched", UOM_UNSUPPORTED: "Unit not verified", AI_PROPOSAL_REJECTED: "Proposed match rejected",
  BUNDLED_QUANTITY_UNVERIFIED: "Lump sum: quantity not checked", PO_AMOUNT_EXCEEDED: "Over the PO value",
};

/** The invoice-against-PO table (audit U01): from the engine's line matches, so it shows what the checks compared. */
export function poTable(run: RunRecord, ref: ReferenceData): PoTableView | null {
  const rows = run.engine?.line_matches;
  if (!run.po_number || !rows?.length) return null;
  const po = ref.purchaseOrders.find((p) => p.po_number === run.po_number);
  const blocking = run.engine?.blocking ?? [];
  const proposer = readerName(run) === "The AI" ? "AI proposal" : readerName(run) === "The MOCK reading" ? "MOCK proposal" : "Proposal";
  return {
    po_number: run.po_number,
    po_status: po?.status ?? null,
    po_value: po ? `${fmtRupees(po.subtotal_pretax)} before GST` : null,
    how_found: run.engine?.po_match_method === "inferred" ? "No PO was printed; this is the only open PO on which every line matches" : "The PO printed on the invoice",
    rows: rows.map((m) => {
      const flags = [...new Set(blocking.filter((f) => f.line_no === m.invoice_line).map((f) => FLAG[f.code] ?? CODE_TEXT[f.code]?.title ?? f.code))];
      const already = m.already_billed ? new Decimal(m.already_billed) : null;
      const diff = m.price_diff_pct ? new Decimal(m.price_diff_pct) : null;
      return {
        invoice_line: m.invoice_line,
        description: m.description,
        billed: m.qty != null ? `${m.qty} ${m.uom ?? ""} × ${unitInr(m.unit_price)}`.replace(/\s+×/, " ×") : "Lump sum",
        amount: formatInr(m.amount),
        status: m.status,
        flags,
        ok_text: flags.length ? null
          : m.status === "charge" ? "Charge on the PO"
          : m.price_result === "below" ? "Below the PO price"
          : m.status === "matched" ? "Matches the PO" : null,
        po_line: m.po_line != null ? `${m.po_line}. ${m.po_description ?? ""}`.trim() : null,
        po_price: m.po_unit_price ? `${unitInr(m.po_unit_price)} / ${m.po_uom}` : null,
        invoice_price: m.price_per_po_unit ? `${unitInr(m.price_per_po_unit)} / ${m.po_uom}` : null,
        price_diff: diff ? `${diff.gt(0) ? "+" : ""}${diff.toString()}%` : null,
        quantity: m.base_qty && m.ordered ? `${new Decimal(m.base_qty).toString()} billed${already?.gt(0) ? ` + ${already.toString()} before` : ""}, ${m.ordered} ordered` : null,
        matched_by: m.via && /^M2/.test(m.via) ? `${proposer}, verified by code` : null,
      };
    }),
  };
}

/** The correction email, written by code from the run's own findings (spec 13). No AI wording. */
export function correctionDraft(run: RunRecord, token: string, ref: ReferenceData, holdNote: string | null = null): { to: string | null; subject: string; body: string; token: string } {
  const vendor = run.vendor_id ? ref.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  const number = run.extraction?.invoice_number ?? "(no number)";
  // Only what the vendor can fix, in plain words (audit U03); our own checks (bank account, sender) never go out.
  const reasons = vendorReasons({ run, ref, refOf: (id) => id, holdNote }).map((r) => `- ${r}`);
  const lines = [
    `Dear ${vendor?.legal_name ?? run.extraction?.vendor_name ?? "Sir or Madam"},`,
    "",
    `We have put your invoice ${number}${run.invoice_date ? ` dated ${formatDate(run.invoice_date)}` : ""}${run.total_paise != null ? ` for ${formatInr(paiseToRupees(run.total_paise))}` : ""} on hold for the following reason${reasons.length === 1 ? "" : "s"}:`,
    ...(reasons.length ? reasons : ["- It needs a correction before it can go on our payment list."]),
    "",
    `Please reply to this email with a corrected invoice. Keep the reference [Ref ${token}] in the subject so we can match your reply to this invoice.`,
    "",
    "Regards,",
    `Accounts payable, ${ref.settings.buyer.name}`,
  ];
  return {
    to: run.source === "email" && vendor?.registered_senders.includes(run.sender_email ?? "") ? run.sender_email : vendor?.registered_senders[0] ?? null,
    subject: `Correction needed: invoice ${number} [Ref ${token}]`,
    body: lines.join("\n"),
    token,
  };
}
