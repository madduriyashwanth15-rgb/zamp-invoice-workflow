import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_DATA_DIR } from "@/fixtures/load";

// Demo workspaces through the app's own route handlers (in-memory store, MOCK reader, no network). Next's request
// scope does not exist under vitest, so the cookie jar and request headers that next/headers would give a route are
// supplied here; everything after them (workspace choice, service, pipeline, store) is the real code.

interface Cookie { value: string; opts?: Record<string, unknown> }
const jar = new Map<string, Cookie>();
let forwardedProto: string | null = null;
const pending: (() => unknown)[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, opts?: Record<string, unknown>) => void jar.set(name, { value, opts }),
  }),
  headers: async () => new Headers(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => undefined,
  after: (fn: () => unknown) => void pending.push(fn),
}));

const { POST: workspacePost } = await import("@/app/api/workspace/route");
const { GET: runsGet } = await import("@/app/api/runs/route");
const { GET: runGet } = await import("@/app/api/runs/[id]/route");
const { GET: fileGet } = await import("@/app/api/runs/[id]/file/route");
const { GET: statusGet } = await import("@/app/api/status/route");
const { POST: replayPost } = await import("@/app/api/demo/replay/route");
const { POST: resetPost } = await import("@/app/api/demo/reset/route");
const { POST: inboundPost } = await import("@/app/api/inbound/resend/route");
const { runtime } = await import("@/server/runtime");
const { act, inboundDeps, info } = await import("@/server/service");
const { replay } = await import("@/server/demo");
const { currentWorkspace, startNewSandbox, switchWorkspace } = await import("@/server/workspace");
const { MAIN, isSandbox, newSandbox } = await import("@/server/workspace-id");

const KEY = "test-admin-key-7f3a9c";
const DAYS_30 = 30 * 24 * 60 * 60;

const visit = (ws: string | null, sb: string | null = ws === MAIN ? null : ws) => {
  jar.clear();
  if (ws) jar.set("ps1-ws", { value: ws });
  if (sb) jar.set("ps1-sb", { value: sb });
};
const cookie = (name: string) => jar.get(name)?.value;
const drain = async () => {
  while (pending.length) await pending.shift()!();
};
const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const runIds = async () => ((await (await runsGet()).json()) as { runs: { run_id: string }[] }).runs.map((r) => r.run_id);
const runsIn = (ws: string) => runtime().depsFor(ws).store.read((s) => [...s.runs.keys()]);

beforeEach(() => {
  for (const k of ["DATABASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "RESEND_API_KEY", "AP_INBOX_ADDRESS", "RESEND_WEBHOOK_SECRET"]) vi.stubEnv(k, "");
  vi.stubEnv("DEMO_ADMIN_KEY", KEY);
  (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  jar.clear();
  forwardedProto = null;
  pending.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
});

describe("the visitor's workspace (cookies)", () => {
  it("a first visit gets a new private sandbox, remembered for 30 days in both cookies", async () => {
    visit(null);
    const ws = await currentWorkspace();
    expect(isSandbox(ws)).toBe(true);
    expect(cookie("ps1-ws")).toBe(ws);
    expect(cookie("ps1-sb")).toBe(ws);
    expect(jar.get("ps1-ws")!.opts).toEqual({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: DAYS_30 });
    expect(await currentWorkspace()).toBe(ws); // the next request, same cookies
    visit(null);
    expect(await currentWorkspace()).not.toBe(ws); // another visitor
  });

  it("the cookies are marked secure behind https", async () => {
    forwardedProto = "https";
    visit(null);
    await currentWorkspace();
    expect(jar.get("ps1-ws")!.opts).toMatchObject({ secure: true, httpOnly: true });
  });

  it("an invalid cookie is never used as a workspace", async () => {
    for (const bad of ["../main", "main;x", "sb-ABCDEFGHIJKL", "sb-abc", "sb-abcdefghijklm", "", "public"]) {
      visit(bad, null);
      const ws = await currentWorkspace();
      expect(isSandbox(ws), bad).toBe(true);
      expect(ws).not.toBe(bad);
    }
    const mine = newSandbox();
    visit("nonsense", mine);
    expect(await currentWorkspace()).toBe(mine); // falls back to the visitor's own sandbox
  });

  it("switching to the shared inbox and back keeps the visitor's sandbox", async () => {
    visit(null);
    const mine = await currentWorkspace();
    expect(await switchWorkspace("main")).toBe(MAIN);
    expect([cookie("ps1-ws"), cookie("ps1-sb")]).toEqual([MAIN, mine]);
    expect(await currentWorkspace()).toBe(MAIN);
    expect(await switchWorkspace("sandbox")).toBe(mine);
    expect([cookie("ps1-ws"), cookie("ps1-sb")]).toEqual([mine, mine]);
  });

  it("a visitor in the shared inbox without a sandbox cookie is given one to come back to", async () => {
    visit(MAIN);
    expect(await currentWorkspace()).toBe(MAIN);
    expect(isSandbox(cookie("ps1-sb"))).toBe(true);
    const sb = cookie("ps1-sb");
    expect(await switchWorkspace("sandbox")).toBe(sb);
  });

  it("starting a new sandbox replaces both cookies", async () => {
    const old = newSandbox();
    visit(old);
    const next = await startNewSandbox();
    expect(isSandbox(next) && next !== old).toBe(true);
    expect([cookie("ps1-ws"), cookie("ps1-sb")]).toEqual([next, next]);
  });
});

describe("POST /api/workspace", () => {
  it("accepts JSON only, and only main or sandbox", async () => {
    visit(null);
    const form = await workspacePost(new Request("http://x/api/workspace", { method: "POST", headers: { "content-type": "text/plain" }, body: "use=main" }));
    expect(form.status).toBe(415);
    expect((await workspacePost(jsonPost("http://x/api/workspace", { use: "sb-aaaaaaaaaaaa" }))).status).toBe(400);
    expect((await workspacePost(jsonPost("http://x/api/workspace", {}))).status).toBe(400);
    expect(jar.size).toBe(0); // refused requests set nothing
  });

  it("switches between the shared inbox and the visitor's sandbox", async () => {
    const mine = newSandbox();
    visit(mine);
    const toMain = await workspacePost(jsonPost("http://x/api/workspace", { use: "main" }));
    expect(await toMain.json()).toEqual({ ok: true, workspace: { kind: "shared" } });
    expect([cookie("ps1-ws"), cookie("ps1-sb")]).toEqual([MAIN, mine]);
    const back = await workspacePost(jsonPost("http://x/api/workspace", { use: "sandbox" }));
    expect(await back.json()).toEqual({ ok: true, workspace: { kind: "sandbox" } });
    expect(cookie("ps1-ws")).toBe(mine);
  });
});

describe("routes work in the request's workspace", () => {
  it("a replay lands in the visitor's sandbox, and the desk, detail, file and status follow the cookie", async () => {
    const [a, b] = [newSandbox(), newSandbox()];
    visit(a);
    const r = await replayPost(jsonPost("http://x/api/demo/replay", { test_id: "S1" }));
    const { run_ids } = (await r.json()) as { run_ids: string[] };
    await drain();
    expect(await runIds()).toEqual(run_ids);
    expect((await runGet(new Request("http://x"), ctx(run_ids[0]))).status).toBe(200);
    expect((await fileGet(new Request("http://x"), ctx(run_ids[0]))).status).toBe(200);
    expect(((await (await statusGet()).json()) as { workspace: unknown }).workspace).toMatchObject({ kind: "sandbox" });

    visit(b);
    expect(await runIds()).toEqual([]);
    expect((await runGet(new Request("http://x"), ctx(run_ids[0]))).status).toBe(404);
    expect((await fileGet(new Request("http://x"), ctx(run_ids[0]))).status).toBe(404);

    visit(MAIN);
    expect(await runIds()).toEqual([]);
    expect((await runGet(new Request("http://x"), ctx(run_ids[0]))).status).toBe(404);
    expect(((await (await statusGet()).json()) as { workspace: unknown }).workspace).toMatchObject({ kind: "shared" });
  });

  it("a reply replayed in another sandbox does not find the first sandbox's correction request", async () => {
    const [a, b] = [newSandbox(), newSandbox()];
    const s3 = await replay("S3", a);
    for (const w of s3.work) await w();
    expect((await act(s3.run_ids[0], { action: "request_correction", actor: "Divya (AP)", channel: "marked sent manually" }, a)).ok).toBe(true);
    visit(b);
    const r = await replayPost(jsonPost("http://x/api/demo/replay", { test_id: "S4" }));
    expect(r.status).toBe(409); // B has no S3 request to reply to
    visit(a);
    const ok = await replayPost(jsonPost("http://x/api/demo/replay", { test_id: "S4" }));
    expect(ok.status).toBe(200);
  });
});

describe("Start again", () => {
  const reset = (cookieHeader: string | null, headers: Record<string, string> = {}) =>
    resetPost(jsonPost("http://x/api/demo/reset", { actor: "Divya (AP)", confirm: "RESET" }, { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...headers }));

  it("in a sandbox: a new, empty sandbox, without the admin key; nothing is deleted anywhere", async () => {
    const a = newSandbox();
    const mainRun = (await replay("S6a")).run_ids[0];
    const mine = (await replay("S1", a)).run_ids[0];
    visit(a);
    const r = await reset(`theme=dark; ps1-ws=${a}; ps1-sb=${a}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, sandbox: true, forgotten: null });
    const next = cookie("ps1-ws")!;
    expect(isSandbox(next) && next !== a).toBe(true);
    expect(cookie("ps1-sb")).toBe(next);
    expect(await runIds()).toEqual([]); // the new sandbox is empty
    expect(await runsIn(a)).toEqual([mine]); // the old one is left as it was
    expect(await runsIn(MAIN)).toEqual([mainRun]);
  });

  it("in the shared inbox: needs the admin key, and empties every workspace", async () => {
    const a = newSandbox();
    await replay("S6a");
    await replay("S1", a);
    visit(MAIN);
    expect((await reset(`ps1-ws=${MAIN}`)).status).toBe(401);
    expect((await reset(null)).status).toBe(401); // no cookie: the shared reset, not a free sandbox
    expect((await reset("ps1-ws=sb-x")).status).toBe(401); // an invalid id is not a sandbox
    expect((await runsIn(MAIN)).length).toBe(1);
    const ok = await reset(`ps1-ws=${MAIN}`, { "x-demo-admin-key": KEY });
    expect(await ok.json()).toEqual({ ok: true, forgotten: null });
    expect(await runsIn(MAIN)).toEqual([]);
    expect(await runsIn(a)).toEqual([]);
  });
});

describe("email", () => {
  const secretBytes = randomBytes(24);
  const sign = (id: string, ts: number, body: string) => `v1,${createHmac("sha256", secretBytes).update(`${id}.${ts}.${body}`).digest("base64")}`;

  it("real inbound email always lands in the shared inbox, whatever cookie the request carries", async () => {
    expect(inboundDeps()).toBe(runtime().deps);
    expect(inboundDeps()).toBe(runtime().depsFor(MAIN));
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${secretBytes.toString("base64")}`);
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    const pdf = readFileSync(path.join(TEST_DATA_DIR, "invoices", "S01_FreshPack_FP-2026-0418.pdf"));
    // The provider is MOCKED: these are the three calls the Resend client makes.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/emails/receiving/e-ws")) return Response.json({ id: "e-ws", from: "billing@freshpack.example", to: ["ap@in.example"], subject: "Invoice FP-2026-0418", text: "Please find attached", html: null });
      if (url.endsWith("/emails/receiving/e-ws/attachments")) {
        return Response.json({ object: "list", has_more: false, data: [{ id: "att-ws", filename: "S01_FreshPack_FP-2026-0418.pdf", content_type: "application/pdf", size: pdf.length, download_url: "https://files.example/att-ws", expires_at: "2026-10-25T10:00:00Z" }] });
      }
      if (url === "https://files.example/att-ws") return new Response(pdf);
      return new Response("not found", { status: 404 });
    }));
    const sb = newSandbox();
    visit(sb);
    const body = JSON.stringify({ type: "email.received", data: { email_id: "e-ws", from: "billing@freshpack.example", to: ["ap@in.example"], subject: "Invoice FP-2026-0418" } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await inboundPost(new Request("http://x/api/inbound/resend", {
      method: "POST", body, headers: { "svix-id": "msg_ws", "svix-timestamp": String(ts), "svix-signature": sign("msg_ws", ts, body), cookie: `ps1-ws=${sb}` },
    }));
    expect(res.status).toBe(200);
    await drain();
    const inMain = await runtime().deps.store.read((s) => [...s.runs.values()]);
    expect(inMain.map((r) => [r.provider_email_id, r.state])).toEqual([["resend:e-ws", "CLEARED"]]);
    expect(await runsIn(sb)).toEqual([]);
  });

  it("a sandbox never sends a correction email: it is manual there, even where the shared inbox sends", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_not_real");
    vi.stubEnv("AP_INBOX_ADDRESS", "ap@in.example");
    const rt = runtime();
    expect(rt.mail).not.toBeNull();
    const sent: unknown[] = [];
    rt.mail!.sender = { from: rt.mail!.sender.from, send: async (m: unknown) => (sent.push(m), { id: "never" }) } as never; // MOCK: records, never sends
    expect(info(MAIN).correctionEmail).toMatchObject({ mode: "send", reply_to: "ap@in.example" });
    const sb = newSandbox();
    expect(info(sb)).toMatchObject({ correctionEmail: { mode: "manual" }, workspace: { kind: "sandbox", ap_inbox: "ap@in.example" } });
    expect(info(MAIN).workspace).toEqual({ kind: "shared", ap_inbox: "ap@in.example" });

    const s3 = await replay("S3", sb);
    for (const w of s3.work) await w();
    const id = s3.run_ids[0];
    const r = await act(id, { action: "request_correction", actor: "Divya (AP)", channel: "sent" }, sb);
    expect(r).toMatchObject({ ok: false, code: "EMAIL_NOT_SENT" });
    expect((r as { reason: string }).reason).toContain("private sandbox");
    expect(sent).toEqual([]);
    expect(await runtime().depsFor(sb).store.read((s) => s.runs.get(id)!.state)).toBe("ON_HOLD");
    const { getRun } = await import("@/server/service");
    expect((await getRun(id, sb))!.correction_draft!.send).toBeNull(); // no "Send" offered: the reviewer copies the text
    const inMain = await replay("S3");
    for (const w of inMain.work) await w();
    expect((await getRun(inMain.run_ids[0], MAIN))!.correction_draft!.send).toEqual({ from: rt.mail!.sender.from, reply_to: "ap@in.example" });
    // Marking it sent by hand works, and still sends nothing.
    expect((await act(id, { action: "request_correction", actor: "Divya (AP)", channel: "marked sent manually" }, sb)).ok).toBe(true);
    expect(await runtime().depsFor(sb).store.read((s) => s.runs.get(id)!.state)).toBe("AWAITING_VENDOR");
    expect(sent).toEqual([]);
  });
});
