import type { ReasonCode } from "@/domain/codes";
import { REASON_CODES } from "@/domain/codes";
import type { Finding, ReferenceData, StageStatus } from "@/domain/engine/types";
import { paiseToRupees } from "@/domain/money";
import { availableActions, type ActionOption } from "@/domain/runs/queries";
import type { Approval, AuditEvent, CorrectionRequest, ExportRecord, Logs, RunRecord, StoreState, StoredDocument } from "@/domain/runs/types";
import { nextToken } from "@/domain/runs/actions";
import { formatDate, formatInr } from "@/lib/format";
import { CODE_TEXT, STATE_TEXT, type Tone } from "@/lib/reason-text";

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
  invoice_number: string | null;
  invoice_date: string | null;
  total: string | null;
  po_number: string | null;
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

export interface StageView {
  n: number;
  id: string;
  title: string;
  /** Who did the work: code, an AI model (named), or a person. */
  by: string;
  by_ai: boolean;
  status: StageStatus | "running" | "pending" | "failed";
  notes: string[];
  findings: FindingView[];
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

export function summarize(run: RunRecord, ref: ReferenceData): RunSummary {
  const vendor = run.vendor_id ? ref.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  const primary = run.primary_reason ? codeView(run.primary_reason) : null;
  return {
    run_id: run.run_id, ref: run.ref, state: run.state, state_label: STATE_TEXT[run.state].label, tone: STATE_TEXT[run.state].tone,
    source: run.source, received_from: run.source === "email" ? run.sender_email : run.uploader_display_name,
    vendor: vendor?.legal_name ?? run.extraction?.vendor_name ?? null, vendor_known: Boolean(vendor),
    invoice_number: run.extraction?.invoice_number ?? null, invoice_date: run.invoice_date ?? run.extraction?.invoice_date ?? null,
    total: run.total_paise != null ? fmtRupees(run.total_paise) : formatInr(run.extraction?.total),
    po_number: run.po_number, due_date: run.due_date,
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

/** Engine notes name other runs by id; people know them by reference. */
function refsFor(runs: Map<string, RunRecord>) {
  const pairs = [...runs.values()].map((r) => [r.run_id, r.ref] as const);
  return (text: string) => pairs.reduce((t, [id, ref]) => (t.includes(id) ? t.split(id).join(ref) : t), text);
}

function stagesOf(run: RunRecord, named: (t: string) => string = (t) => t): StageView[] {
  const intake: StageView = {
    n: 0, id: "intake", title: run.source === "email" ? "Received by email" : "Uploaded", by: "Code", by_ai: false, status: "passed",
    notes: run.source === "email"
      ? [`From ${run.sender_email ?? "unknown sender"}`, ...(run.subject ? [`Subject "${run.subject}"`] : []), ...(run.reply_token ? [`Reply token ${run.reply_token}`] : [])]
      : [`Uploaded by ${run.uploader_display_name ?? "unknown"} (demo identity)`],
    findings: [],
  };
  if (run.state === "SKIPPED" && !run.extraction && run.primary_reason) {
    intake.status = "skipped";
    intake.notes.push(run.failure ?? "");
    intake.findings = [{ ...codeView(run.primary_reason), message: run.failure ?? "", evidence: [], line_no: null, blocking: true }];
    return [intake];
  }
  const label = run.extracted_by?.extractor ?? null;
  const ai = Boolean(label && /gemini/i.test(label));
  const read: StageView = {
    n: 1, id: "read", title: "Read the document", by: label ?? "Extractor", by_ai: ai,
    status: run.state === "RECEIVED" ? "pending" : run.state === "PROCESSING" && !run.extraction ? "running" : run.extraction ? "passed" : "failed",
    notes: [], findings: [],
  };
  if (run.extracted_by) {
    read.notes.push(run.extracted_by.cached ? "Answer reused from the cache (same file, prompt and model)" : `${run.extracted_by.attempts} provider call${run.extracted_by.attempts === 1 ? "" : "s"}`);
    for (const r of run.extracted_by.retries ?? []) read.notes.push(`Retried: ${r}`);
  }
  if (run.extraction) read.notes.push(`Read as ${run.extraction.doc_type}, titled "${run.extraction.document_title ?? "no title"}"`);
  if (run.failure && !run.extraction) read.notes.push(run.failure);
  if (run.blocking_codes.includes("EXTRACTION_FAILED") && !run.engine) {
    read.status = "held";
    read.findings = [{ ...codeView("EXTRACTION_FAILED"), message: "The model's answer failed validation twice", evidence: [], line_no: null, blocking: true }];
  }
  const out = [intake, read];
  if (!run.engine) return out;
  for (const st of run.engine.stages) {
    const blockingSet = new Set(run.engine.blocking.map((f) => `${f.code}|${f.stage}|${f.line_no ?? ""}|${f.message}`));
    const usedAi = st.findings.some((f) => f.code === "LINE_MAPPED_AI_VERIFIED" || f.code === "AI_PROPOSAL_REJECTED");
    out.push({
      n: ENGINE_STAGE_NO[st.stage], id: st.stage, title: ENGINE_TITLES[st.stage] ?? st.label,
      by: usedAi ? "Code (checked an AI line proposal)" : "Code", by_ai: false,
      status: st.status, notes: st.notes.map(named),
      findings: st.findings.map((f) => {
        const v = findingView(f, blockingSet.has(`${f.code}|${f.stage}|${f.line_no ?? ""}|${f.message}`));
        return { ...v, message: named(v.message), evidence: v.evidence.map((e) => ({ ...e, value: named(e.value) })) };
      }),
    });
  }
  return out;
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
  return {
    ...summarize(run, ref),
    failure: run.failure, sender_email: run.sender_email, uploader: run.uploader_display_name, subject: run.subject, reply_token: run.reply_token,
    extracted_by: run.extracted_by, extraction: run.extraction,
    document: doc ? { run_id: doc.run_id, filename: doc.filename, content_type: doc.content_type, size_bytes: doc.size_bytes, sha256: doc.sha256, has_text_layer: doc.has_text_layer, body_text: doc.body_text, text_chars: doc.text_layer.length } : null,
    stages: stagesOf(run, refsFor(state.runs as Map<string, RunRecord>)),
    blocking: run.blocking_codes.map(codeView),
    info: run.info_codes.map(codeView),
    actions: availableActions(run, state),
    approvals: logs.approvals, corrections: logs.corrections, exports: logs.exports, events: logs.events,
    related: [...relatedIds].map((id) => state.runs.get(id)).filter((r): r is RunRecord => Boolean(r)).map((r) => summarize(r, ref)),
    token_active: run.state === "AWAITING_VENDOR" || run.state === "ON_HOLD" ? token : null,
    correction_draft: run.state === "ON_HOLD" ? { ...correctionDraft(run, nextToken(state, run), ref), send: null } : null,
  };
}

/** The correction email, written by code from the run's own findings (spec 13). No AI wording. */
export function correctionDraft(run: RunRecord, token: string, ref: ReferenceData): { to: string | null; subject: string; body: string; token: string } {
  const vendor = run.vendor_id ? ref.vendors.find((v) => v.vendor_id === run.vendor_id) : undefined;
  const number = run.extraction?.invoice_number ?? "(no number)";
  const reasons = (run.engine?.blocking ?? []).map((f) => `- ${f.message}`);
  const lines = [
    `Dear ${vendor?.legal_name ?? run.extraction?.vendor_name ?? "Sir or Madam"},`,
    "",
    `We have put your invoice ${number}${run.invoice_date ? ` dated ${formatDate(run.invoice_date)}` : ""}${run.total_paise != null ? ` for ${formatInr(paiseToRupees(run.total_paise))}` : ""} on hold for the following reason${reasons.length === 1 ? "" : "s"}:`,
    ...(reasons.length ? reasons : ["- " + (run.primary_reason ? CODE_TEXT[run.primary_reason].title : "it needs a correction")]),
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
