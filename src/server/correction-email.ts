import type { PipelineDeps } from "@/domain/runs/pipeline";
import { prepareCorrection, requestCorrection, type ActionCtx, type ActionResult } from "@/domain/runs/review";
import type { RunRecord } from "@/domain/runs/types";
import { holdNoteOf } from "./explain";
import { correctionDraft } from "./views";

// Correction email actually sent (spec 13, row 11 "correction email sent"). The text is the code-built draft
// with the reply token; replies go to the AP inbox, where the token links them (D2).
//
// Order: check (nothing changes) -> send -> record. A refusal or a failed send changes nothing, so the reviewer can
// still copy the text and mark it sent manually. The send uses an idempotency key made from the run and token, so a
// repeated click cannot send the same request twice.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  replyTo: string;
  idempotencyKey: string;
}

export interface MailSender {
  readonly from: string;
  send(email: OutgoingEmail): Promise<{ id: string }>;
}

/** Resend's send API (POST /emails). The API key travels in a header. */
export class ResendSender implements MailSender {
  constructor(
    private apiKey: string,
    readonly from: string,
    private base = "https://api.resend.com",
    private fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  }

  async send(e: OutgoingEmail): Promise<{ id: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await this.fetchImpl(`${this.base}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": e.idempotencyKey },
        body: JSON.stringify({ from: this.from, to: [e.to], subject: e.subject, text: e.text, reply_to: e.replyTo }),
        signal: ctrl.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        let message = body.slice(0, 300);
        try {
          message = (JSON.parse(body) as { message?: string }).message ?? message;
        } catch {
          // keep the raw text
        }
        throw new Error(`Resend answered ${res.status}: ${message}`);
      }
      const id = (JSON.parse(body) as { id?: string }).id;
      if (!id) throw new Error("Resend answered without a message id");
      return { id };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("Resend did not answer within 20 s");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type SendFailure = { ok: false; code: "EMAIL_NOT_SENT"; reason: string };

/** Checks, sends, then records the request (row 11, channel "sent"). */
export async function sendCorrection(
  deps: Pick<PipelineDeps, "store" | "now" | "newId" | "reference">,
  runId: string,
  ctx: ActionCtx,
  mail: { sender: MailSender; replyTo: string },
): Promise<ActionResult<{ run: RunRecord; token: string; provider_message_id: string }> | SendFailure> {
  const pre = await prepareCorrection(deps, runId, ctx);
  if (!pre.ok) return pre;
  const { run, token } = pre.value;
  const draft = correctionDraft(run, token, deps.reference, holdNoteOf((await deps.store.logs(runId)).events));
  if (!draft.to) {
    return { ok: false, code: "EMAIL_NOT_SENT", reason: "There is no registered address for this vendor to send to. Copy the text and mark it sent manually." };
  }
  let sent: { id: string };
  try {
    sent = await mail.sender.send({ to: draft.to, subject: draft.subject, text: draft.body, replyTo: mail.replyTo, idempotencyKey: `correction-${run.run_id}-${token}` });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "EMAIL_NOT_SENT", reason: `The email was not sent (${why}). Nothing changed: you can copy the text and mark it sent manually.` };
  }
  const rec = await requestCorrection(deps, runId, {
    ...ctx, channel: "sent", expectToken: token, delivery: { to: draft.to, provider_message_id: sent.id },
  });
  if (rec.ok) return { ok: true, value: { ...rec.value, provider_message_id: sent.id } };
  const recorded = await deps.store.read((s) => s.tokens.get(token) === run.run_id);
  if (recorded) return { ok: false, code: "ACTION_REPEAT_IGNORED", reason: `Already sent with reference ${token}` };
  return { ok: false, code: rec.code, reason: `The email was sent to ${draft.to} with reference ${token}, but recording it failed: ${rec.reason}` };
}
