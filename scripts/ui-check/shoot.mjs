// Screenshots of every screen and invoice at desktop, tablet and phone widths; fails on sideways scroll or a console
// error (review gap 20). Read-only. Run flows.mjs first so the screens have data.
// Usage: node scripts/ui-check/shoot.mjs [outdir]     (default out/ui-check/shots). ONLY=desktop,phone limits widths.
import { B, api, context, guard, outDir, playwright, reporter } from "./lib.mjs";

await guard();
const out = outDir(process.argv[2], "out/ui-check/shots");
const { check, finish } = reporter();
const { chromium } = playwright();
const runs = (await (await api("/api/runs")).json()).runs;
const W = { desktop: { width: 1440, height: 900 }, tablet: { width: 834, height: 1112 }, phone: { width: 390, height: 844 } };
const pages = [
  ["desk", "/"],
  ["desk-cleared", "/?view=cleared"],
  ["desk-exported", "/?view=exported"],
  ...runs.map((r) => [`run-${r.ref}-${(r.filename ?? "upload").split("_")[0]}`, `/runs/${r.run_id}`]),
  ["rules", "/settings"],
  ["demo", "/demo"],
];
const only = process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(W);
const browser = await chromium.launch();
for (const [name, path] of pages) {
  for (const w of only) {
    const ctx = await context(browser, { viewport: W[w], deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(B + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${name}-${w}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`${name} at ${w}: no sideways scroll, no console errors`, overflow === 0 && errors.length === 0, [overflow ? `overflow ${overflow}px` : "", ...errors.slice(0, 2)].filter(Boolean).join(" | "));
    await ctx.close();
  }
}
await browser.close();
finish();
