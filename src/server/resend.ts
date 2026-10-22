import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundEmail } from "@/domain/types";

// Resend inbound email (plan phase H). The webhook only carries metadata; the body and the attachments are fetched
// from the Resend API with the email id (docs checked 22 Oct 2026: GET /emails/receiving/{id} and
// GET /emails/receiving/{id}/attachments, each attachment with a temporary download_url).
// Webhooks are signed by Svix: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<raw body>" with the base64 secret
// that follows "whsec_".

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** True when the raw body was signed with `secret` within `toleranceSec` of `nowSec`. */
export function verifySvix(rawBody: string, h: SvixHeaders, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  if (!h.id || !h.timestamp || !h.signature || !secret) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = Buffer.from(createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest("base64"));
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export interface ResendReceivedEvent {
  type: string;
  data: { email_id: string; from: string; to: string[]; subject: string; attachments?: { id: string; filename: string; content_type: string }[] };
}

interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
}

interface AttachmentList {
  data: { id: string; filename: string; content_type: string; content_disposition?: string | null; size: number; download_url: string; expires_at: string }[];
}

export class ResendClient {
  constructor(private apiKey: string, private base = "https://api.resend.com", private fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`Resend ${path} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  /** The inbound email in our InboundEmail shape, plus a fetcher for each attachment's bytes. */
  async load(emailId: string): Promise<{ email: InboundEmail; fetchBytes: (i: number) => Promise<Uint8Array> }> {
    const e = await this.get<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(emailId)}`);
    const list = await this.get<AttachmentList>(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
    // Images inside the email body (signature logos, pasted pictures) are not invoice attachments: invoices arrive as
    // attached files. An email left with nothing attached is still recorded, as SKIPPED NO_ATTACHMENT.
    const atts = list.data.filter(
      (a) => a.content_type && a.filename && !(a.content_disposition === "inline" && a.content_type.toLowerCase().startsWith("image/")),
    );
    const email: InboundEmail = {
      provider_email_id: `resend:${e.id}`,
      attachment_id: atts[0]?.id ?? "none",
      from: e.from,
      to: e.to,
      subject: e.subject ?? "",
      body_text: e.text ?? (e.html ? e.html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ") : ""),
      attachments: atts.map((a) => ({ filename: a.filename, path: "", content_type: a.content_type })),
      // DMARC pass = trusted From; fail = possible spoof (held as SENDER_UNVERIFIED, never links); otherwise unknown.
      sender_authenticated: e.authentication?.dmarc === "pass" ? true : e.authentication?.dmarc === "fail" ? false : null,
    };
    const fetchBytes = async (i: number) => {
      const res = await this.fetchImpl(atts[i].download_url);
      if (!res.ok) throw new Error(`attachment download answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
    return { email, fetchBytes };
  }
}

/**
 * Handles one verified email.received event. Loading the email from Resend is tried 3 times; if it still fails,
 * a FAILED ATTACHMENT_FETCH_FAILED run is recorded from the webhook metadata so the email is never lost silently.
 */
export async function handleReceived(
  event: ResendReceivedEvent,
  client: Pick<ResendClient, "load">,
  intake: {
    ingest: (email: InboundEmail, fetchBytes: (i: number) => Promise<Uint8Array>) => Promise<{ work: (() => Promise<unknown>)[] }>;
    recordFailure: (meta: { provider_email_id: string; from: string; subject: string; reason: string }) => Promise<unknown>;
  },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  let lastError = "";
  for (let a = 1; a <= 3; a++) {
    try {
      const { email, fetchBytes } = await client.load(event.data.email_id);
      const r = await intake.ingest(email, fetchBytes);
      await Promise.all(r.work.map((w) => w()));
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (a < 3) await sleep(1000 * a);
    }
  }
  await intake.recordFailure({ provider_email_id: `resend:${event.data.email_id}`, from: event.data.from, subject: event.data.subject, reason: `email could not be loaded from Resend after 3 attempts: ${lastError}` });
}
