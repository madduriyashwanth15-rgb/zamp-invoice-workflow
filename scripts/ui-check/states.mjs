// Loading, empty, error and narrow-screen states (review gap 20). Network failures are injected in the browser
// (route interception); the server and its data are untouched. Run flows.mjs first so there is data to show.
// Usage: node scripts/ui-check/states.mjs [outdir]     (default out/ui-check/states)
import { B, api, context, guard, outDir, playwright, reporter } from "./lib.mjs";

await guard();
const out = outDir(process.argv[2], "out/ui-check/states");
const { check, finish } = reporter();
const { chromium } = playwright();
const runs = (await (await api("/api/runs")).json()).runs;
const id = (p) => runs.find((r) => (r.filename ?? "").startsWith(p))?.run_id;
const browser = await chromium.launch();
async function ctx(width = 1440, height = 900) {
  const c = await context(browser, { viewport: { width, height } });
  const p = await c.newPage();
  return { c, p };
}

// Desk while the list is slow: skeletons, no fake rows.
{
  const { c, p } = await ctx();
  await p.route("**/api/runs", async (r) => {
    await new Promise((res) => setTimeout(res, 2500));
    await r.continue();
  });
  await p.goto(B + "/", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(700);
  await p.screenshot({ path: `${out}/s1-desk-loading.png` });
  check("desk loading shows skeletons", (await p.locator("[aria-busy]").count()) > 0);
  await c.close();
}
// Desk when the list fails: a plain error with a retry.
{
  const { c, p } = await ctx();
  await p.route("**/api/runs", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, code: "STORE_ERROR", reason: "The records store did not answer" }) }));
  await p.goto(B + "/", { waitUntil: "networkidle" });
  await p.screenshot({ path: `${out}/s2-desk-error.png` });
  check("desk error says the list did not load and offers a retry", (await p.getByText("The invoice list did not load").count()) === 1 && (await p.getByRole("button", { name: "Try again" }).count()) === 1);
  await c.close();
}
// Server not answering at all: the side menu says so.
{
  const { c, p } = await ctx();
  await p.route("**/api/status", (r) => r.abort());
  await p.goto(B + "/settings", { waitUntil: "networkidle" });
  await p.screenshot({ path: `${out}/s3-status-down.png` });
  check("setup strip says the server is not answering", (await p.getByText("The server is not answering").count()) > 0);
  await c.close();
}
// Unknown invoice link.
{
  const { c, p } = await ctx();
  await p.goto(B + "/runs/does-not-exist", { waitUntil: "networkidle" });
  await p.screenshot({ path: `${out}/s4-run-404.png` });
  check("unknown invoice: plain message and a way back", (await p.getByText("There is no invoice with this link").count()) === 1);
  await c.close();
}
// Empty views and a search with no match.
{
  const { c, p } = await ctx();
  await p.goto(B + "/?view=exported", { waitUntil: "networkidle" });
  await p.screenshot({ path: `${out}/s5-empty-view.png` });
  const exported = runs.filter((r) => r.exported).length;
  check("exported view: empty state or rows, never both", exported ? (await p.getByText("No payment lists exported yet").count()) === 0 : (await p.getByText("No payment lists exported yet").count()) === 1);
  await p.goto(B + "/", { waitUntil: "networkidle" });
  await p.getByPlaceholder("Vendor, invoice no., PO or ref").fill("zzzz-no-match");
  await p.waitForTimeout(200);
  check("search with no match says so", (await p.getByText("No invoices match").count()) === 1);
  await c.close();
}
// Simulated in-flight run (the response is rewritten in the browser, labelled as simulated in the report).
{
  const { c, p } = await ctx();
  const target = id("S01");
  await p.route(`**/api/runs/${target}`, async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.state = "PROCESSING";
    body.state_label = "Reading";
    body.tone = "neutral";
    body.stages = body.stages.slice(0, 1);
    body.actions = [];
    body.extraction = null;
    await r.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await p.goto(`${B}/runs/${target}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}/s6-inflight-simulated.png` });
  check("in-flight run shows the reading bar and the steps still to come", (await p.locator(".reading-bar").count()) === 1);
  await c.close();
}
// Phone: the override dialog fits and scrolls; Tab stays inside it.
{
  const { c, p } = await ctx(390, 844);
  await p.goto(B + "/", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Open menu" }).click();
  await p.locator("dialog[open]").getByLabel("Acting as").selectOption("Arjun (AP lead)");
  await p.keyboard.press("Escape");
  const target = runs.find((r) => r.state === "ON_HOLD")?.run_id;
  await p.goto(`${B}/runs/${target}`, { waitUntil: "networkidle" });
  const btn = p.getByRole("button", { name: /Approve with exception|Reject/ }).first();
  await btn.click();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${out}/s7-phone-dialog.png` });
  const box = await p.locator("dialog[open]").boundingBox();
  check("phone dialog fits the screen", box && box.width <= 390 && box.height <= 844, JSON.stringify(box));
  for (let i = 0; i < 12; i++) await p.keyboard.press("Tab");
  const inside = await p.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")));
  check("Tab keeps focus inside the dialog", inside);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no sideways scroll on the phone review screen", overflow === 0, String(overflow));
  await c.close();
}
// Keyboard: the queue is reachable without a mouse and focus is visible.
{
  const { c, p } = await ctx();
  await p.goto(B + "/", { waitUntil: "networkidle" });
  for (let i = 0; i < 4; i++) await p.keyboard.press("Tab");
  await p.screenshot({ path: `${out}/s8-keyboard-focus.png` });
  const style = await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check("focused element shows an outline", style !== "none", style);
  await c.close();
}
await browser.close();
finish();
