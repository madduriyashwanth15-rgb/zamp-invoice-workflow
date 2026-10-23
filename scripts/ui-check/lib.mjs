// Shared helpers for the browser checks (review gap 20). Playwright and axe-core are not app dependencies: they are
// resolved from this folder's parents (npm i --no-save playwright axe-core) or from UI_CHECK_MODULES.
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const B = (process.env.B ?? "http://localhost:3100").replace(/\/$/, "");

/** Only a local server: these checks click real buttons, and flows.mjs starts by removing every invoice. */
export async function guard({ needsMock = true } = {}) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) {
    console.error(`Refusing to run against ${B}: the browser checks only run against a local server (http://localhost:<port>).`);
    process.exit(2);
  }
  let info;
  try {
    info = await (await fetch(`${B}/api/status`)).json();
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
  fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
export const runs = async () => (await (await fetch(`${B}/api/runs`)).json()).runs;
export const byFile = async (prefix) => (await runs()).find((r) => (r.filename ?? "").startsWith(prefix));
export const detail = async (id) => (await fetch(`${B}/api/runs/${id}`)).json();
