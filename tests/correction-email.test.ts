import { describe, expect, it, vi } from "vitest";
import { sendCorrection, ResendSender, type MailSender, type OutgoingEmail } from "@/server/correction-email";
import { deliver, makeDeps } from "./support/harness";

// Correction email sent by the app (spec 13, row 11 "sent"). MOCK mail provider: FakeSender records what would go
// out; ResendSender's wire format is checked with fetch stubbed. The pipeline, token linking and store are real.

class FakeSender implements MailSender {
  readonly from = "SpiceRoute AP (demo) <onboarding@resend.dev>";
  sent: OutgoingEmail[] = [];
  constructor(private fail: string | null = null) {}
  async send(e: OutgoingEmail) {
    if (this.fail) throw new Error(this.fail);
    this.sent.push(e);
    return { id: `msg-${this.sent.length}` };
  }
}

const INBOX = "invoices@ap-demo.resend.app";
const actor = "Divya (AP)";

describe("correction email sent by the app", () => {
  it("S3 held -> email sent to the vendor's registered address with the token, replies to the AP inbox -> S4 reply links and clears", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    expect(s3.state).toBe("ON_HOLD");
    const sender = new FakeSender();
    const r = await sendCorrection(deps, s3.run_id, { actor, expectedVersion: s3.version }, { sender, replyTo: INBOX });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const token = r.value.token;
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0];
    expect(mail.to).toBe(s3.sender_email);
    expect(mail.replyTo).toBe(INBOX);
    expect(mail.subject).toContain(`[Ref ${token}]`);
    expect(mail.text).toContain(`[Ref ${token}]`);
    expect(mail.idempotencyKey).toBe(`correction-${s3.run_id}-${token}`);

    const after = await deps.store.read((s) => s.runs.get(s3.run_id)!);
    expect(after.state).toBe("AWAITING_VENDOR");
    const logs = await deps.store.logs(s3.run_id);
    expect(logs.corrections).toEqual([expect.objectContaining({ token, channel: "sent", to: s3.sender_email, provider_message_id: "msg-1" })]);

    // The vendor replies to the email, keeping the reference, with the corrected invoice.
    const s4 = await deliver(deps, "S4", { S3: token });
    expect(s4.state).toBe("CLEARED");
    expect(s4.info_codes).toContain("CORRECTION_OF");
    expect((await deps.store.read((s) => s.runs.get(s3.run_id)!)).state).toBe("SUPERSEDED");
  });

  it("a send that fails changes nothing: no token, no state change, the reason is shown and manual stays possible", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const r = await sendCorrection(deps, s3.run_id, { actor, expectedVersion: s3.version }, {
      sender: new FakeSender("Resend answered 403: You can only send testing emails to your own email address"), replyTo: INBOX,
    });
    expect(r).toMatchObject({ ok: false, code: "EMAIL_NOT_SENT" });
    if (!r.ok) expect(r.reason).toMatch(/not sent .*403.*Nothing changed/);
    const state = await deps.store.read((s) => ({ run: s.runs.get(s3.run_id)!, tokens: s.tokens.size }));
    expect(state.run.state).toBe("ON_HOLD");
    expect(state.run.version).toBe(s3.version);
    expect(state.tokens).toBe(0);
    expect((await deps.store.logs(s3.run_id)).corrections).toEqual([]);
  });

  it("a stale click (old version) is ignored before anything is sent (T8)", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const sender = new FakeSender();
    const first = await sendCorrection(deps, s3.run_id, { actor, expectedVersion: s3.version }, { sender, replyTo: INBOX });
    expect(first.ok).toBe(true);
    const again = await sendCorrection(deps, s3.run_id, { actor, expectedVersion: s3.version }, { sender, replyTo: INBOX });
    expect(again).toMatchObject({ ok: false, code: "ACTION_REPEAT_IGNORED" });
    expect(sender.sent).toHaveLength(1);
    expect((await deps.store.logs(s3.run_id)).events.some((e) => e.type === "ACTION_REPEAT_IGNORED")).toBe(true);
  });

  it("only a held invoice can get a correction request; a cleared one is refused and nothing is sent", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    const sender = new FakeSender();
    const r = await sendCorrection(deps, s1.run_id, { actor, expectedVersion: s1.version }, { sender, replyTo: INBOX });
    expect(r).toMatchObject({ ok: false, code: "INVALID_TRANSITION_BLOCKED" });
    expect(sender.sent).toHaveLength(0);
  });

  it("no display name, no email (T13)", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    const sender = new FakeSender();
    const r = await sendCorrection(deps, s3.run_id, { actor: " ", expectedVersion: s3.version }, { sender, replyTo: INBOX });
    expect(r).toMatchObject({ ok: false, code: "IDENTITY_REQUIRED" });
    expect(sender.sent).toHaveLength(0);
  });
});

describe("ResendSender wire format (fetch stubbed, no network)", () => {
  it("POST /emails with the key in the header, an idempotency key, the reply-to address and plain text", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re-123" }), { status: 200 }));
    const s = new ResendSender("re_test", "AP <onboarding@resend.dev>", "https://api.example", fetchMock as unknown as typeof fetch);
    const out = await s.send({ to: "v@example.com", subject: "S [Ref R-T1ABCD]", text: "body", replyTo: INBOX, idempotencyKey: "k-1" });
    expect(out).toEqual({ id: "re-123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({ from: "AP <onboarding@resend.dev>", to: ["v@example.com"], subject: "S [Ref R-T1ABCD]", text: "body", reply_to: INBOX });
  });

  it("an error answer becomes a readable reason", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ statusCode: 403, message: "You can only send testing emails to your own email address" }), { status: 403 }));
    const s = new ResendSender("re_test", "AP <onboarding@resend.dev>", "https://api.example", fetchMock as unknown as typeof fetch);
    await expect(s.send({ to: "x@example.com", subject: "s", text: "t", replyTo: INBOX, idempotencyKey: "k" })).rejects.toThrow(
      "Resend answered 403: You can only send testing emails to your own email address",
    );
  });
});
