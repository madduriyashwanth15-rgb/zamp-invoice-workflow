// Shared helpers for the browser checks (review gap 20). Playwright and axe-core are not app dependencies: they are
// resolved from this folder's parents (npm i --no-save playwright axe-core) or from UI_CHECK_MODULES.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const B = (process.env.B ?? "http://localhost:3100").replace(/\/$/, "");

// Demo workspaces: every visitor works in a private sandbox by default, chosen by the ps1-ws cookie. The scripts work
// in one fixed sandbox, as a visitor would, so their API calls and their browser see the same invoices. A request
// without the cookie would land in a new, empty sandbox.
export const WS = process.env.UI_CHECK_WS ?? "sb-uicheckflows";
if (!/^sb-[a-z0-9]{12}$/.test(WS)) {
  console.error(`UI_CHECK_WS must look like sb- and 12 lowercase letters or digits, not ${WS}`);
  process.exit(2);
}
export const COOKIE = `ps1-ws=${WS}; ps1-sb=${WS}`;
/** fetch, in the scripts' sandbox. */
export const api = (p, init = {}) => fetch(B + p, { ...init, headers: { cookie: COOKIE, ...(init.headers ?? {}) } });
/** A browser context in the scripts' sandbox. */
export async function context(browser, options = {}) {
  const c = await browser.newContext(options);
  await c.addCookies([{ name: "ps1-ws", value: WS, url: B }, { name: "ps1-sb", value: WS, url: B }]);
  return c;
}

/** Only a local server: these checks click real buttons, and flows.mjs starts by removing every invoice. */
export async function guard({ needsMock = true } = {}) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) {
    console.error(`Refusing to run against ${B}: the browser checks only run against a local server (http://localhost:<port>).`);
    process.exit(2);
  }
  let info;
  try {
    info = await (await api("/api/status")).json();
  } catch {
    console.error(`No app answering at ${B}. Start it first (see scripts/ui-check/README.md).`);
    process.exit(2);
  }
  if (needsMock && (info.store !== "memory" || info.extractor !== "mock")) {
    console.error(
      `Refusing to run: the server reports store "${info.store}" and reader "${info.extractor}". Start it with no DATABASE_URL and no GEMINI_API_KEY ` +
        "(in-memory store, MOCK reader), so no real data is touched and no AI is called.",
    );
    process.exit(2);
  }
  return info;
}

function loader() {
  const bases = [process.env.UI_CHECK_MODULES, process.cwd(), path.dirname(fileURLToPath(import.meta.url))].filter(Boolean);
  return (name) => {
    for (const base of bases) {
      try {
        return createRequire(path.join(path.resolve(base), "noop.js"))(name);
      } catch {}
    }
    return null;
  };
}
const load = loader();

export function playwright() {
  const pw = load("playwright");
  if (!pw) {
    console.error("Playwright is not installed. In the project folder: npm i --no-save playwright axe-core && npx playwright install chromium");
    process.exit(2);
  }
  return pw;
}

/** axe-core's browser bundle, or null when it is not installed (its checks are then reported as SKIP, never PASS). */
export function axeSource() {
  for (const base of [process.env.UI_CHECK_MODULES, process.cwd()].filter(Boolean)) {
    try {
      return readFileSync(createRequire(path.join(path.resolve(base), "noop.js")).resolve("axe-core/axe.min.js"), "utf-8");
    } catch {}
  }
  return null;
}

export function outDir(arg, fallback) {
  const dir = arg ?? fallback;
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function reporter() {
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  };
  const skip = (name, why) => {
    results.push({ name, ok: null });
    console.log(`SKIP  ${name}  (${why})`);
  };
  const finish = () => {
    const failed = results.filter((r) => r.ok === false).length;
    const passed = results.filter((r) => r.ok === true).length;
    const skipped = results.filter((r) => r.ok === null).length;
    console.log(`\n${passed}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  };
  return { check, skip, finish };
}

export const post = (p, body) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
export const runs = async () => (await (await api("/api/runs")).json()).runs;
export const byFile = async (prefix) => (await runs()).find((r) => (r.filename ?? "").startsWith(prefix));
export const detail = async (id) => (await api(`/api/runs/${id}`)).json();

/**
 * Empties every workspace: "Start again" in the shared inbox (ps1-ws=main), open without a key only on a local
 * in-memory server, which guard() has checked. In a sandbox the same request would only open a new sandbox.
 */
export async function resetAll() {
  const res = await fetch(`${B}/api/demo/reset`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: "ps1-ws=main" }, body: JSON.stringify({ actor: "ui-check", confirm: "RESET" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.sandbox) {
    console.error(`Could not empty the local server (${res.status} ${body.reason ?? ""}).`);
    process.exit(2);
  }
}
