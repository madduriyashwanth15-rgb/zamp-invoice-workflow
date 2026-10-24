import { after } from "next/server";
import { ingestEmail } from "@/server/email-intake";
import { json } from "@/server/http";
import { parseReplyToken } from "@/domain/intake/inbound-email";
import { receiveUnreadable } from "@/domain/runs/pipeline";
import { handleReceived, ResendClient, verifySvix, type ResendReceivedEvent } from "@/server/resend";
import { inboundDeps } from "@/server/service";

// Reading a document with the model happens in this request's after() work (or inside it, for retry). Vercel
// Hobby allows 300 s per invocation; the extractor's time budget keeps a run inside that (gemini-extractor.ts).
export const maxDuration = 300;

/**
 * Resend inbound webhook (phase H): verify the signature, answer 200 at once, then fetch the email and its
 * attachments and run each attachment through the same intake as everything else. A webhook retry of the same
 * email is a logged repeat (delivery key = Resend email id + attachment id). Real email always lands in the shared
 * AP inbox ("main"), never in a visitor's private sandbox.
 */
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET ?? "";
  const apiKey = process.env.RESEND_API_KEY ?? "";
  if (!secret || !apiKey) return json({ ok: false, code: "NOT_CONFIGURED", reason: "RESEND_WEBHOOK_SECRET and RESEND_API_KEY are not set" }, 503);
  const raw = await request.text();
  const ok = verifySvix(raw, { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") }, secret);
  if (!ok) return json({ ok: false, code: "BAD_SIGNATURE", reason: "signature check failed" }, 401);
  const event = JSON.parse(raw) as ResendReceivedEvent;
  if (event.type !== "email.received") return json({ ok: true, ignored: event.type });
  const emailId = event.data.email_id;
  after(async () => {
    const deps = inboundDeps();
    try {
      await handleReceived(event, new ResendClient(apiKey), {
        ingest: (email, fetchBytes) => ingestEmail(deps, email, fetchBytes),
        recordFailure: (m) =>
          receiveUnreadable(deps, {
            source: "email", sender_email: m.from.trim().toLowerCase(), uploader_display_name: null, provider_email_id: m.provider_email_id,
            attachment_id: "unknown", filename: null, content_type: null, size_bytes: null, subject: m.subject, reply_token: parseReplyToken(m.subject, null),
          }, "ATTACHMENT_FETCH_FAILED", m.reason),
      });
    } catch (e) {
      console.error(`[inbound] email ${emailId}:`, e instanceof Error ? e.message : e);
    }
  });
  return json({ ok: true, accepted: emailId });
}
