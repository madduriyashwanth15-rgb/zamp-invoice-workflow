import { createHash } from "node:crypto";
import { MAX_ATTACHMENT_BYTES, SUPPORTED_TYPES } from "@/domain/intake/inbound-email";
import { failStuckRuns, processRun, receive, receiveUnreadable } from "@/domain/runs/pipeline";
import {
  approve, confirmCorrectionLink, exportApproved, manualHold, overrideApprove, processAsInvoice, reject, replaceApproved,
  requestCorrection, retry, stopWaiting, type ActionResult, type CallbackInput,
} from "@/domain/runs/review";
import type { ReviewAction } from "@/domain/runs/queries";
import { paiseToRupees } from "@/domain/money";
import { sendCorrection, type SendFailure } from "@/server/correction-email";
import { readTextLayer } from "@/server/pdf-text";
import { runtime } from "@/server/runtime";
import { detail, summarize, type RunDetail, type RunSummary } from "@/server/views";

// Application services behind the API routes. They translate HTTP input into domain calls and domain results
// into view models; every rule lives in src/domain.

/** A run still PROCESSING after this long was interrupted (for example the function was stopped). */
const STUCK_AFTER_MS = 6 * 60_000; // above the 300 s function limit, which the extractor's time budget stays under

export async function listRuns(): Promise<{ runs: RunSummary[]; exports: { export_id: string; created_by: string; created_at: string; count: number }[] }> {
  const { deps } = runtime();
  await failStuckRuns(deps, STUCK_AFTER_MS);
  const runs = await deps.store.read((s) => [...s.runs.values()]);
  const logs = await deps.store.logs();
  return {
    runs: runs.reverse().map((r) => summarize(r, deps.reference)),
    exports: logs.exports.slice().reverse().map((x) => ({ export_id: x.export_id, created_by: x.created_by_display_name, created_at: x.created_at, count: x.run_ids.length })),
  };
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  const { deps, mail } = runtime();
  const state = await deps.store.read((s) => ({ run: s.runs.get(runId), runs: s.runs, documents: s.documents, tokens: s.tokens }));
  if (!state.run) return null;
  const logs = await deps.store.logs(runId);
  const d = detail(state.run, state, logs, deps.reference);
  if (d.correction_draft && mail) d.correction_draft.send = { from: mail.sender.from, reply_to: mail.replyTo };
  return d;
}

export async function documentFile(runId: string): Promise<{ bytes: Uint8Array; content_type: string; filename: string } | null> {
  const { deps } = runtime();
  const doc = await deps.store.read((s) => s.documents.get(runId));
  if (!doc) return null;
  const bytes = await deps.store.documentBytes(runId);
  return bytes ? { bytes, content_type: doc.content_type, filename: doc.filename } : null;
}

export type UploadResult = { run_id: string; repeat: boolean; process: (() => Promise<unknown>) | null };

/** Upload (A1: an internal action by a reviewer, recorded under their demo display name). */
export async function upload(file: File, uploader: string): Promise<UploadResult> {
  const { deps } = runtime();
  const name = uploader.trim();
  const base = { source: "upload" as const, sender_email: null, uploader_display_name: name, provider_email_id: null, attachment_id: null, subject: null, reply_token: null };
  const type = (file.type || "").toLowerCase();
  if (!SUPPORTED_TYPES.includes(type as (typeof SUPPORTED_TYPES)[number]) || file.size > MAX_ATTACHMENT_BYTES) {
    const reason = file.size > MAX_ATTACHMENT_BYTES ? `${file.size} bytes is over the 4 MB limit` : `type ${type || "unknown"} is not PDF, PNG or JPEG`;
    const run = await receiveUnreadable(deps, { ...base, filename: file.name, content_type: type || null, size_bytes: file.size }, "UNSUPPORTED_FILE", reason);
    return { run_id: run.run_id, repeat: false, process: null };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = await readTextLayer(bytes, type);
  if (text.unreadable) {
    const run = await receiveUnreadable(deps, { ...base, filename: file.name, content_type: type, size_bytes: file.size }, "UNSUPPORTED_FILE", text.unreadable);
    return { run_id: run.run_id, repeat: false, process: null };
  }
  const r = await receive(deps, { ...base, filename: file.name, content_type: type, bytes, sha256, text_layer: text.text, has_text_layer: text.has_text_layer });
  if (r.kind === "repeat") return { run_id: r.run_id, repeat: true, process: null };
  return { run_id: r.run_id, repeat: false, process: () => processRun(deps, r.run_id) };
}

export interface ActionBody {
  action: ReviewAction;
  actor: string;
  note?: string | null;
  expectedVersion?: number;
  confirmFailingChecks?: boolean;
  /** Override only: the PO a reviewer names when the code found none (spec v1.4 C4b). */
  poNumber?: string | null;
  /** Override of a bank, vendor or sender hold: the call that confirmed it, then a second confirmation (v1.4 row 9). */
  callback?: CallbackInput | null;
  confirmCallback?: boolean;
  channel?: "sent" | "marked sent manually";
}

export async function act(runId: string, body: ActionBody): Promise<ActionResult<unknown> | SendFailure> {
  const { deps, mail } = runtime();
  const ctx = { actor: body.actor, note: body.note ?? null, expectedVersion: body.expectedVersion };
  switch (body.action) {
    case "approve": return approve(deps, [runId], ctx);
    case "manual_hold": return manualHold(deps, runId, ctx);
    case "override_approve":
      return overrideApprove(deps, runId, {
        ...ctx, confirmFailingChecks: body.confirmFailingChecks, poNumber: body.poNumber ?? null, callback: body.callback ?? null, confirmCallback: body.confirmCallback,
      });
    case "reject": return reject(deps, runId, ctx);
    case "request_correction":
      if (body.channel !== "sent") return requestCorrection(deps, runId, { ...ctx, channel: "marked sent manually" });
      if (!mail) return { ok: false, code: "EMAIL_NOT_SENT", reason: "Sending is not set up on this deployment (RESEND_API_KEY and AP_INBOX_ADDRESS). Copy the text and mark it sent manually." };
      return sendCorrection(deps, runId, ctx, mail);
    case "stop_waiting": return stopWaiting(deps, runId, ctx);
    case "confirm_link": return confirmCorrectionLink(deps, runId, { ...ctx, confirmFailingChecks: body.confirmFailingChecks });
    case "replace_approved": return replaceApproved(deps, runId, { ...ctx, confirmFailingChecks: body.confirmFailingChecks });
    case "retry": return retry(deps, runId, ctx);
    case "process_as_invoice": return processAsInvoice(deps, runId, ctx);
    default: return { ok: false, code: "INVALID_TRANSITION_BLOCKED", reason: `unknown action ${String(body.action)}` };
  }
}

export async function approveBatch(runIds: string[], actor: string, expectedVersions?: Record<string, number>) {
  const { deps } = runtime();
  return approve(deps, runIds, { actor, expectedVersions });
}

export async function exportNow(actor: string) {
  const { deps } = runtime();
  const r = await exportApproved(deps, { actor });
  return r.ok ? { ok: true as const, export_id: r.value.record.export_id, count: r.value.runs.length } : r;
}

/**
 * One CSV cell: quoted, quotes doubled, and a leading = + - @ tab or CR neutralised with an apostrophe so a
 * spreadsheet shows it as text instead of running it as a formula (audit A09). Totals never start with these.
 */
export function csvCell(v: string | null | undefined): string {
  const s = String(v ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** CSV of one export (the payment list handed to finance). Amounts as printed totals in rupees. */
export async function exportCsv(exportId: string): Promise<string | null> {
  const { deps } = runtime();
  const logs = await deps.store.logs();
  const x = logs.exports.find((e) => e.export_id === exportId);
  if (!x) return null;
  const runs = await deps.store.read((s) => x.run_ids.map((id) => s.runs.get(id)!));
  const approvals = logs.approvals;
  const esc = csvCell;
  const header = ["export_id", "exported_by_demo_identity", "exported_at", "run_ref", "vendor_id", "vendor", "invoice_number", "invoice_date", "po_number", "total_inr", "due_per_terms", "approved_by_demo_identity", "approved_at", "approval_mode"];
  const rows = runs.map((r) => {
    const v = deps.reference.vendors.find((x) => x.vendor_id === r.vendor_id);
    const a = approvals.filter((ap) => ap.run_id === r.run_id).at(-1);
    return [x.export_id, x.created_by_display_name, x.created_at, r.ref, r.vendor_id, v?.legal_name ?? r.extraction?.vendor_name, r.extraction?.invoice_number, r.invoice_date, r.po_number, r.total_paise != null ? paiseToRupees(r.total_paise) : "", r.due_date, a?.approver_display_name, a?.approved_at, a?.mode].map((c) => esc(c as string));
  });
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}

export function info() {
  return runtime().info;
}
