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
import { runtime, type RuntimeInfo } from "@/server/runtime";
import { detail, summarize, type RunDetail, type RunSummary } from "@/server/views";
import { MAIN, kindOf, type Workspace } from "@/server/workspace-id";

// Application services behind the API routes. They translate HTTP input into domain calls and domain results
// into view models; every rule lives in src/domain. Each one works in one workspace: the shared AP inbox ("main",
// the default) or a visitor's private sandbox (workspace-id.ts). The route handlers pass the request's workspace.

/** A run still PROCESSING after this long was interrupted (for example the function was stopped). */
const STUCK_AFTER_MS = 6 * 60_000; // above the 300 s function limit, which the extractor's time budget stays under

export async function listRuns(ws: Workspace = MAIN): Promise<{ runs: RunSummary[]; exports: { export_id: string; created_by: string; created_at: string; count: number }[] }> {
  const deps = runtime().depsFor(ws);
  await failStuckRuns(deps, STUCK_AFTER_MS);
  const state = await deps.store.read((s) => ({ runs: s.runs, documents: s.documents }));
  const runs = [...state.runs.values()];
  const logs = await deps.store.logs();
  return {
    runs: runs.reverse().map((r) => summarize(r, deps.reference, state)),
    exports: logs.exports.slice().reverse().map((x) => ({ export_id: x.export_id, created_by: x.created_by_display_name, created_at: x.created_at, count: x.run_ids.length })),
  };
}

export async function getRun(runId: string, ws: Workspace = MAIN): Promise<RunDetail | null> {
  const deps = runtime().depsFor(ws);
  const mail = mailFor(ws);
  const state = await deps.store.read((s) => ({ run: s.runs.get(runId), runs: s.runs, documents: s.documents, tokens: s.tokens }));
  if (!state.run) return null;
  const logs = await deps.store.logs(runId);
  const d = detail(state.run, state, logs, deps.reference);
  if (d.correction_draft && mail) d.correction_draft.send = { from: mail.sender.from, reply_to: mail.replyTo };
  return d;
}

export async function documentFile(runId: string, ws: Workspace = MAIN): Promise<{ bytes: Uint8Array; content_type: string; filename: string } | null> {
  const deps = runtime().depsFor(ws);
  const doc = await deps.store.read((s) => s.documents.get(runId));
  if (!doc) return null;
  const bytes = await deps.store.documentBytes(runId);
  return bytes ? { bytes, content_type: doc.content_type, filename: doc.filename } : null;
}

export type UploadResult = { run_id: string; repeat: boolean; process: (() => Promise<unknown>) | null };

/** Upload (A1: an internal action by a reviewer, recorded under their demo display name). */
export async function upload(file: File, uploader: string, ws: Workspace = MAIN): Promise<UploadResult> {
  const deps = runtime().depsFor(ws);
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

export async function act(runId: string, body: ActionBody, ws: Workspace = MAIN): Promise<ActionResult<unknown> | SendFailure> {
  const deps = runtime().depsFor(ws);
  const mail = mailFor(ws);
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
      if (!mail) {
        return {
          ok: false, code: "EMAIL_NOT_SENT",
          reason: ws === MAIN
            ? "Sending is not set up on this deployment (RESEND_API_KEY and AP_INBOX_ADDRESS). Copy the text and mark it sent manually."
            : "A private sandbox does not send email. Copy the text and mark it sent manually; the vendor's reply can be replayed from the demo inbox.",
        };
      }
      return sendCorrection(deps, runId, ctx, mail);
    case "stop_waiting": return stopWaiting(deps, runId, ctx);
    case "confirm_link": return confirmCorrectionLink(deps, runId, { ...ctx, confirmFailingChecks: body.confirmFailingChecks });
    case "replace_approved": return replaceApproved(deps, runId, { ...ctx, confirmFailingChecks: body.confirmFailingChecks });
    case "retry": return retry(deps, runId, ctx);
    case "process_as_invoice": return processAsInvoice(deps, runId, ctx);
    default: return { ok: false, code: "INVALID_TRANSITION_BLOCKED", reason: `unknown action ${String(body.action)}` };
  }
}

export async function approveBatch(runIds: string[], actor: string, expectedVersions?: Record<string, number>, ws: Workspace = MAIN) {
  const deps = runtime().depsFor(ws);
  return approve(deps, runIds, { actor, expectedVersions });
}

export async function exportNow(actor: string, ws: Workspace = MAIN) {
  const deps = runtime().depsFor(ws);
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
export async function exportCsv(exportId: string, ws: Workspace = MAIN): Promise<string | null> {
  const deps = runtime().depsFor(ws);
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

/** Gap 15: the whole audit trail as CSV, every event in order (read-only). Names are demo identities. */
export async function auditCsv(ws: Workspace = MAIN): Promise<string> {
  const deps = runtime().depsFor(ws);
  const logs = await deps.store.logs();
  const refs = await deps.store.read((s) => new Map([...s.runs.values()].map((r) => [r.run_id, r.ref])));
  const header = ["seq", "at", "run_ref", "run_id", "event", "actor", "from_state", "to_state", "transition_row", "reason_code", "note", "details_json"];
  const rows = [...logs.events]
    .sort((a, b) => a.seq - b.seq)
    .map((e) =>
      [
        String(e.seq), e.at, e.run_id ? refs.get(e.run_id) ?? "" : "", e.run_id ?? "", e.type,
        e.actor === "system" ? "system" : `${e.actor} (demo identity)`,
        e.from_state ?? "", e.to_state ?? "", e.transition != null ? String(e.transition) : "", e.code ?? "", e.note ?? "",
        e.details && Object.keys(e.details).length ? JSON.stringify(e.details, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : "",
      ].map(csvCell),
    );
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}

/** Real email leaves only from the shared inbox: replies to it come back there, never to a sandbox. */
function mailFor(ws: Workspace) {
  return ws === MAIN ? runtime().mail : null;
}

/** The deployment's setup as seen from one workspace: a sandbox copies and marks corrections sent by hand. */
export function info(ws: Workspace = MAIN): RuntimeInfo {
  const rt = runtime();
  return {
    ...rt.info,
    correctionEmail: ws === MAIN ? rt.info.correctionEmail : { mode: "manual" },
    workspace: { kind: kindOf(ws), ap_inbox: rt.mail?.replyTo ?? null },
  };
}

/** The inbound email webhook always delivers to the shared inbox: an email carries no visitor's sandbox. */
export function inboundDeps() {
  return runtime().depsFor(MAIN);
}
