import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as resetPost } from "@/app/api/demo/reset/route";
import { checkAdminKey } from "@/server/admin-guard";
import { replay } from "@/server/demo";
import { json } from "@/server/http";
import { runtime } from "@/server/runtime";
import { info } from "@/server/service";

// Audit A07: the demo reset empties every run table, so it must not be open to anyone.

const KEY = "test-admin-key-7f3a9c";

describe("checkAdminKey", () => {
  const withKey = { configured: KEY, store: "postgres" as const };
  it("accepts the configured key", () => expect(checkAdminKey(KEY, withKey)).toEqual({ ok: true }));
  it("refuses a wrong key with 401", () => expect(checkAdminKey("test-admin-key-7f3a9d", withKey)).toMatchObject({ ok: false, status: 401, code: "ADMIN_KEY_REQUIRED" }));
  it("refuses a missing key with 401", () => expect(checkAdminKey(null, withKey)).toMatchObject({ ok: false, status: 401, code: "ADMIN_KEY_REQUIRED" }));
  it("refuses a key of a different length with 401", () => expect(checkAdminKey(`${KEY}-longer`, withKey)).toMatchObject({ ok: false, status: 401 }));
  it("is off (403) when no key is configured and a database is attached", () =>
    expect(checkAdminKey(null, { configured: "  ", store: "postgres" })).toMatchObject({ ok: false, status: 403, code: "RESET_DISABLED" }));
  it("is open when no key is configured and the store is in memory", () => expect(checkAdminKey(null, { configured: undefined, store: "memory" })).toEqual({ ok: true }));
});

describe("POST /api/demo/reset (in-memory store, MOCK reader)", () => {
  beforeEach(async () => {
    // Force the in-memory store and the MOCK reader whatever the local env files hold.
    for (const k of ["DATABASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "RESEND_API_KEY", "AP_INBOX_ADDRESS"]) vi.stubEnv(k, "");
    vi.stubEnv("DEMO_ADMIN_KEY", KEY);
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
    expect(runtime().info).toMatchObject({ store: "memory", extractor: "mock" });
    await replay("S1");
    expect(await runCount()).toBeGreaterThan(0);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  });

  const runCount = () => runtime().deps.store.read((s) => s.runs.size);
  const call = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    resetPost(new Request("http://localhost/api/demo/reset", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const valid = { actor: "Asha (demo identity)", confirm: "RESET" };

  it("refuses a text/plain body with 415 (cross-site form post)", async () => {
    const res = await call(JSON.stringify(valid), { "Content-Type": "text/plain", "x-demo-admin-key": KEY });
    expect(res.status).toBe(415);
    expect((await res.json()).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(await runCount()).toBeGreaterThan(0);
  });

  it("refuses a request without the key header with 401", async () => {
    const res = await call(valid);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("ADMIN_KEY_REQUIRED");
    expect(await runCount()).toBeGreaterThan(0);
  });

  it("refuses a wrong key with 401, also when asked to forget readings", async () => {
    const res = await call({ ...valid, forgetReadings: true }, { "Content-Type": "application/json", "x-demo-admin-key": "wrong" });
    expect(res.status).toBe(401);
    expect(await runCount()).toBeGreaterThan(0);
  });

  it("resets with the right key, RESET and a display name", async () => {
    const res = await call(valid, { "Content-Type": "application/json", "x-demo-admin-key": KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await runCount()).toBe(0);
  });

  it("/api/status shows how reset is guarded and never the key", async () => {
    // The status route's body is json(info()); its connection() call needs a Next request scope, so call the body directly.
    const res = json(info());
    const text = await res.text();
    expect(JSON.parse(text).demoReset).toBe("key");
    expect(text).not.toContain(KEY);
  });
});
