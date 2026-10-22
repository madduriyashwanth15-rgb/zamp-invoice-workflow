import { createHash } from "node:crypto";
import { parseReplyToken, triageEmail } from "@/domain/intake/inbound-email";
import { processRun, receive, receiveUnreadable, type PipelineDeps } from "@/domain/runs/pipeline";
import type { InboundEmail } from "@/domain/types";
import { readTextLayer } from "@/server/pdf-text";

// Email intake (plan phase H): one inbound email becomes one run per attachment, through the same InboundEmail
// adapter the golden run uses. Provider specifics (webhook shape, how bytes are fetched) stay with the caller,
// which passes `fetchBytes`. Runs are recorded first; reading and checks are returned as work to run after the
// webhook has been answered ("fast 200, process after").

export const FETCH_ATTEMPTS = 3;

export interface EmailIntakeResult {
  run_ids: string[];
  repeats: string[];
  /** Work to run after the response: one processing call per new run. */
  work: (() => Promise<unknown>)[];
}

export async function ingestEmail(
  deps: PipelineDeps,
  email: InboundEmail,
  fetchBytes: (index: number) => Promise<Uint8Array>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<EmailIntakeResult> {
  const out: EmailIntakeResult = { run_ids: [], repeats: [], work: [] };
  const base = {
    source: "email" as const, sender_email: email.from.trim().toLowerCase(), uploader_display_name: null,
    provider_email_id: email.provider_email_id, subject: email.subject, body_text: email.body_text,
    reply_token: parseReplyToken(email.subject, email.body_text),
    sender_authenticated: email.sender_authenticated ?? null,
  };
  if (email.attachments.length === 0) {
    const run = await receiveUnreadable(deps, { ...base, attachment_id: null, filename: null, content_type: null, size_bytes: null }, "NO_ATTACHMENT", "the email has no attachment");
    out.run_ids.push(run.run_id);
    return out;
  }
  for (let i = 0; i < email.attachments.length; i++) {
    const att = email.attachments[i];
    const attachmentId = i === 0 ? email.attachment_id : `${email.attachment_id}#${i}`;
    // A file the provider reports as too large is recorded without downloading it (audit B03).
    if (att.size_bytes != null) {
      const early = triageEmail(email, [{ filename: att.filename, content_type: att.content_type, size_bytes: att.size_bytes }]).attachments[0];
      if (early.kind === "skip") {
        const run = await receiveUnreadable(deps, { ...base, attachment_id: attachmentId, filename: att.filename, content_type: att.content_type, size_bytes: att.size_bytes }, "UNSUPPORTED_FILE", early.reason);
        out.run_ids.push(run.run_id);
        continue;
      }
    }
    let bytes: Uint8Array | null = null;
    let lastError = "";
    for (let a = 1; a <= FETCH_ATTEMPTS && !bytes; a++) {
      try {
        bytes = await fetchBytes(i);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (a < FETCH_ATTEMPTS) await sleep(500 * a);
      }
    }
    const doc = { ...base, attachment_id: attachmentId };
    if (!bytes) {
      const run = await receiveUnreadable(deps, { ...doc, filename: att.filename, content_type: att.content_type, size_bytes: null }, "ATTACHMENT_FETCH_FAILED", `attachment could not be fetched after ${FETCH_ATTEMPTS} attempts: ${lastError}`);
      out.run_ids.push(run.run_id);
      continue;
    }
    const triage = triageEmail(email, [{ filename: att.filename, content_type: att.content_type, size_bytes: bytes.length }]).attachments[0];
    if (triage.kind === "skip") {
      const run = await receiveUnreadable(deps, { ...doc, filename: att.filename, content_type: att.content_type, size_bytes: bytes.length }, "UNSUPPORTED_FILE", triage.reason);
      out.run_ids.push(run.run_id);
      continue;
    }
    const type = att.content_type.toLowerCase() === "image/jpg" ? "image/jpeg" : att.content_type.toLowerCase();
    const text = await readTextLayer(bytes, type);
    if (text.unreadable) {
      const run = await receiveUnreadable(deps, { ...doc, filename: att.filename, content_type: type, size_bytes: bytes.length }, "UNSUPPORTED_FILE", text.unreadable);
      out.run_ids.push(run.run_id);
      continue;
    }
    const r = await receive(deps, {
      ...doc, filename: att.filename, content_type: type, bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
      text_layer: text.text, has_text_layer: text.has_text_layer,
    });
    out.run_ids.push(r.run_id);
    if (r.kind === "repeat") out.repeats.push(r.run_id);
    else out.work.push(() => processRun(deps, r.run_id));
  }
  return out;
}
