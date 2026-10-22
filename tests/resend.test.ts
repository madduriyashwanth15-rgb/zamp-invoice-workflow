import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { receiveUnreadable } from "@/domain/runs/pipeline";
import { TEST_DATA_DIR } from "@/fixtures/load";
import { ingestEmail } from "@/server/email-intake";
import { handleReceived, ResendClient, verifySvix, type ResendReceivedEvent } from "@/server/resend";
import { makeDeps } from "./support/harness";

// Resend inbound (phase H) with the provider MOCKED: signature check, the API calls the client makes, and the
// path from a webhook event to a decided run. The live provider is checked only once Resend is set up.

const secretBytes = randomBytes(24);
const secret = `whsec_${secretBytes.toString("base64")}`;
const sign = (id: string, ts: number, body: string) => `v1,${createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64")}`;

describe("Svix signature (Resend webhooks)", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });
  const now = 1_790_000_000;
  it("accepts a correct signature, including among several", () => {
    expect(verifySvix(body, { id: "msg_1", timestamp: String(now), signature: sign("msg_1", now, body) }, secret, now)).toBe(true);
    expect(verifySvix(body, { id: "msg_1", timestamp: String(now), signature: `v1,AAAA ${sign("msg_1", now, body)}` }, secret, now)).toBe(true);
  });
  it("refuses a changed body, a wrong secret, an old timestamp and missing headers", () => {
    const sig = sign("msg_1", now, body);
    expect(verifySvix(body + " ", { id: "msg_1", timestamp: String(now), signature: sig }, secret, now)).toBe(false);
    expect(verifySvix(body, { id: "msg_1", timestamp: String(now), signature: sig }, `whsec_${randomBytes(24).toString("base64")}`, now)).toBe(false);
    expect(verifySvix(body, { id: "msg_1", timestamp: String(now - 301), signature: sign("msg_1", now - 301, body) }, secret, now)).toBe(false);
    expect(verifySvix(body, { id: null, timestamp: String(now), signature: sig }, secret, now)).toBe(false);
  });
});

describe("ResendClient (fetch stubbed)", () => {
  it("loads the email and attachments with the API key in the header and maps them to InboundEmail", async () => {
    const pdf = readFileSync(path.join(TEST_DATA_DIR, "invoices", "S01_FreshPack_FP-2026-0418.pdf"));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/emails/receiving/e1")) {
        expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
        return Response.json({ id: "e1", from: "billing@freshpack.example", to: ["ap@in.example"], subject: "Invoice FP-2026-0418", text: "Please find attached", html: null });
      }
      if (url.endsWith("/emails/receiving/e1/attachments")) {
        return Response.json({ object: "list", has_more: false, data: [{ id: "att-1", filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", size: pdf.length, download_url: "https://files.example/att-1", expires_at: "2026-10-22T10:00:00Z" }] });
      }
      if (url === "https://files.example/att-1") return new Response(pdf);
      return new Response("not found", { status: 404 });
    });
    const client = new ResendClient("re_test", "https://api.resend.com", fetchMock as unknown as typeof fetch);
    const { email, fetchBytes } = await client.load("e1");
    expect(email).toMatchObject({ provider_email_id: "resend:e1", attachment_id: "att-1", from: "billing@freshpack.example", subject: "Invoice FP-2026-0418" });
    const deps = makeDeps();
    const r = await ingestEmail(deps, email, fetchBytes);
    await Promise.all(r.work.map((w) => w()));
    expect((await deps.store.read((s) => s.runs.get(r.run_ids[0])!)).state).toBe("CLEARED");
  });
});

describe("ResendClient: images inside the email body are not invoices", () => {
  const pdf = readFileSync(path.join(TEST_DATA_DIR, "invoices", "S01_FreshPack_FP-2026-0418.pdf"));
  const client = (attachments: Record<string, unknown>[]) =>
    new ResendClient("re_test", "https://api.resend.com", (async (url: string) => {
      if (url.endsWith("/emails/receiving/e2")) return Response.json({ id: "e2", from: "billing@freshpack.example", to: ["ap@in.example"], subject: "Invoice FP-2026-0418", text: "Regards", html: null });
      if (url.endsWith("/emails/receiving/e2/attachments")) return Response.json({ object: "list", has_more: false, data: attachments });
      if (url === "https://files.example/pdf") return new Response(pdf);
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch);
  const logo = { id: "img-1", filename: "image001.png", content_type: "image/png", content_disposition: "inline", content_id: "ii_1", size: 5120, download_url: "https://files.example/logo", expires_at: "2026-10-22T10:00:00Z" };
  const attachedPdf = { id: "att-1", filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", content_disposition: "attachment", size: pdf.length, download_url: "https://files.example/pdf", expires_at: "2026-10-22T10:00:00Z" };

  it("a signature logo next to the PDF is ignored: one run, for the invoice", async () => {
    const { email, fetchBytes } = await client([logo, attachedPdf]).load("e2");
    expect(email.attachments.map((a) => a.filename)).toEqual(["S01_FreshPack_FP-2026-0418.pdf"]);
    const deps = makeDeps();
    const r = await ingestEmail(deps, email, fetchBytes);
    await Promise.all(r.work.map((w) => w()));
    expect(r.run_ids).toHaveLength(1);
    expect((await deps.store.read((s) => s.runs.get(r.run_ids[0])!)).state).toBe("CLEARED");
  });

  it("an email with only an inline picture is still recorded, as SKIPPED NO_ATTACHMENT", async () => {
    const { email, fetchBytes } = await client([logo]).load("e2");
    const deps = makeDeps();
    const r = await ingestEmail(deps, email, fetchBytes);
    const run = await deps.store.read((s) => s.runs.get(r.run_ids[0])!);
    expect([run.state, run.primary_reason]).toEqual(["SKIPPED", "NO_ATTACHMENT"]);
  });
});

describe("handleReceived", () => {
  const event: ResendReceivedEvent = { type: "email.received", data: { email_id: "e9", from: "Billing@FreshPack.example", to: ["ap@in.example"], subject: "Invoice" } };
  it("Resend unreachable 3 times -> one FAILED ATTACHMENT_FETCH_FAILED run from the webhook metadata", async () => {
    const deps = makeDeps();
    const load = vi.fn(async () => { throw new Error("503"); });
    await handleReceived(event, { load }, {
      ingest: (email, fb) => ingestEmail(deps, email, fb),
      recordFailure: (m) => receiveUnreadable(deps, { source: "email", sender_email: m.from.toLowerCase(), uploader_display_name: null, provider_email_id: m.provider_email_id, attachment_id: "unknown", filename: null, content_type: null, size_bytes: null, subject: m.subject, reply_token: null }, "ATTACHMENT_FETCH_FAILED", m.reason),
    }, async () => {});
    expect(load).toHaveBeenCalledTimes(3);
    const runs = await deps.store.read((s) => [...s.runs.values()]);
    expect(runs.map((r) => [r.state, r.primary_reason, r.sender_email])).toEqual([["FAILED", "ATTACHMENT_FETCH_FAILED", "billing@freshpack.example"]]);
    expect(runs[0].failure).toMatch(/after 3 attempts: 503/);
  });
});
