import type { InboundEmail } from "../types";

// Stage 0 for email intake (spec 3, A12): reply-token parsing, supported files, idempotency keys.
// Provider specifics (webhooks, fetching attachment bytes) live outside the domain; this adapter only
// sees the internal InboundEmail shape.

export const TOKEN_PATTERN = /\[Ref (R-[A-Za-z0-9]+)\]/;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const SUPPORTED_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

/** Our token "[Ref R-<id>]" from the subject, else the body (quoted replies included). */
export function parseReplyToken(subject: string | null, body: string | null): string | null {
  return (subject ?? "").match(TOKEN_PATTERN)?.[1] ?? (body ?? "").match(TOKEN_PATTERN)?.[1] ?? null;
}

export function deliveryKey(providerEmailId: string, attachmentId: string): string {
  return `${providerEmailId}::${attachmentId}`;
}

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export type AttachmentTriage =
  | { kind: "accept"; attachment: AttachmentMeta; index: number }
  | { kind: "skip"; attachment: AttachmentMeta; index: number; code: "UNSUPPORTED_FILE"; reason: string };

export interface EmailTriage {
  sender: string;
  subject: string;
  token: string | null;
  noAttachment: boolean;
  attachments: AttachmentTriage[];
}

const typeOf = (a: AttachmentMeta) => {
  const t = a.content_type.toLowerCase();
  if (t === "image/jpg") return "image/jpeg";
  return t;
};

/** Each supported attachment becomes its own run; unsupported ones are SKIPPED UNSUPPORTED_FILE. */
export function triageEmail(email: InboundEmail, attachments: AttachmentMeta[]): EmailTriage {
  return {
    sender: email.from.trim().toLowerCase(),
    subject: email.subject,
    token: parseReplyToken(email.subject, email.body_text),
    noAttachment: attachments.length === 0,
    attachments: attachments.map((a, index): AttachmentTriage => {
      const t = typeOf(a);
      if (!(SUPPORTED_TYPES as readonly string[]).includes(t)) {
        return { kind: "skip", attachment: a, index, code: "UNSUPPORTED_FILE", reason: `type ${a.content_type} is not PDF, PNG or JPEG` };
      }
      if (a.size_bytes > MAX_ATTACHMENT_BYTES) {
        return { kind: "skip", attachment: a, index, code: "UNSUPPORTED_FILE", reason: `${a.size_bytes} bytes is over the 4 MB limit` };
      }
      return { kind: "accept", attachment: a, index };
    }),
  };
}
