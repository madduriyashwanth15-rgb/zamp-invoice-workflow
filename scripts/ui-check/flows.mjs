// End-to-end flows through the real UI, each result verified through the API afterwards (review gap 20).
// Local server only, in-memory store and MOCK reader only: it starts by removing every invoice (guarded in lib.mjs).
// Usage: node scripts/ui-check/flows.mjs [outdir]     (default out/ui-check/flows; screenshots go there)
import { B, axeSource, byFile, detail, guard, outDir, playwright, post, reporter, runs } from "./lib.mjs";

await guard();
const out = outDir(process.argv[2], "out/ui-check/flows");
const { check, skip, finish } = reporter();
const AXE = axeSource();
const { chromium } = playwright();

// Fresh data: reset, then replay the scenario set.
await post("/api/demo/reset", { actor: "ui-check", confirm: "RESET" });
for (const t of ["S1", "S2", "S3", "S5", "S6a", "S6b", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14"]) {
  await post("/api/demo/replay", { test_id: t });
}
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

async function axe(name) {
  if (!AXE) return skip(`axe ${name}`, "axe-core not installed");
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes[0]?.target?.join(" ") }));
  });
  const bad = r.filter((v) => v.impact === "serious" || v.impact === "critical");
  check(`axe ${name}: no serious or critical WCAG A/AA violations`, bad.length === 0, r.map((v) => `${v.id}/${v.impact}x${v.n} ${v.sample}`).join("; "));
}
const shot = (n) => page.screenshot({ path: `${out}/${n}.png`, fullPage: false });
const dialog = () => page.locator("dialog[open]");
const istToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// 0. Without a name, an action is refused in the dialog and nothing changes.
{
  const r = await byFile("S14");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve for payment list" }).click();
  await dialog().getByRole("button", { name: /^Approve/ }).click();
  await page.waitForTimeout(300);
  const msg = await dialog().getByText("Choose who you are acting as").count();
  await shot("f0-no-identity");
  check("no identity: approval refused with a message, state unchanged", msg > 0 && (await detail(r.run_id)).state === "CLEARED");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("Escape closes the dialog", (await dialog().count()) === 0);
}

// 0b. Measured timings (gap 16): a MOCK run shows the code checks' time and does not claim an AI reading.
{
  const r = await byFile("S14");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  const line = page.getByText("Measured on this invoice:");
  const text = (await line.count()) ? await line.first().innerText() : "";
  const d = await detail(r.run_id);
  check("timings: the checks' measured time is shown, from the recorded run", /checked by code in (under 0\.01|\d+\.\d+) s/.test(text) && d.timing != null, text);
  check("timings: a MOCK run does not claim an AI reading", !/read by the AI/.test(text));
}

// Choose who is acting.
await page.getByLabel("Acting as").selectOption("Divya (AP)");

// 1. Desk: lanes and queue match the API; due dates (gap 12) shown as recorded.
{
  await page.goto(B + "/", { waitUntil: "networkidle" });
  const all = await runs();
  const held = all.filter((r) => r.state === "ON_HOLD" || r.state === "FAILED").length;
  const lane = await page.getByRole("link", { name: /Needs a decision/ }).first().innerText();
  check("desk lane count equals held invoices from the API", lane.includes(String(held)), lane.replace(/\n/g, " | "));
  const s3 = all.find((r) => (r.filename ?? "").startsWith("S03"));
  const row = page.locator("table tbody tr", { has: page.locator(`a[href="/runs/${s3.run_id}"]`) });
  const due = row.locator("[title^='Due (per terms)']");
  const days = Math.round((Date.parse(s3.due_per_terms) - Date.parse(istToday)) / 86_400_000);
  const want = days < 0 ? `overdue by ${-days} day` : days === 0 ? "due today" : days === 1 ? "due tomorrow" : `due in ${days} days`;
  const got = (await due.count()) ? await due.innerText() : "";
  check("desk: S3 shows its due date (per terms) counted from today", got.startsWith(want), `${got} (due ${s3.due_per_terms}, today ${istToday})`);
  await page.getByRole("combobox", { name: /Sort/ }).selectOption("due");
  await page.waitForTimeout(200);
  const hrefs = await page.locator("table tbody tr").evaluateAll((trs) => trs.map((tr) => tr.querySelector('a[href^="/runs/"]')?.getAttribute("href")));
  const expected = all
    .filter((r) => r.state === "ON_HOLD" && r.due_per_terms)
    .sort((a, b) => a.due_per_terms.localeCompare(b.due_per_terms) || b.created_at.localeCompare(a.created_at))
    .map((r) => `/runs/${r.run_id}`);
  check("desk: 'Due soonest' puts the earliest due date first", JSON.stringify(hrefs.slice(0, expected.length)) === JSON.stringify(expected), `${expected.length} with a due date`);
  await page.getByRole("combobox", { name: /Sort/ }).selectOption("serious");
  await shot("f1-desk");
  await axe("desk");
}

// 2. S3: request a correction (draft, then mark as sent manually).
{
  const r = await byFile("S03");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await axe("review S3");
  await page.getByRole("button", { name: "Request correction" }).click();
  const draft = await dialog().getByText("Draft, not sent").count();
  await shot("f2-correction-dialog");
  await axe("correction dialog");
  check("correction dialog shows the draft as not sent", draft === 1);
  await dialog().getByRole("button", { name: "Mark as sent manually" }).click();
  await page.waitForTimeout(800);
  const d = await detail(r.run_id);
  check("S3 correction recorded: waiting for vendor", d.state === "AWAITING_VENDOR", d.state);
  await shot("f2-after-correction");
}

// 3. S2: approve with exception needs the call record, then a second confirmation.
{
  const r = await byFile("S02");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve with exception" }).click();
  const disabled = await dialog().getByRole("button", { name: "Approve with exception" }).isDisabled();
  check("override button disabled until call and note are filled", disabled);
  await dialog().getByLabel("Number called").fill("+91 80 0000 1002");
  await dialog().getByLabel("Spoke to").fill("Ravi, accounts head");
  await dialog().getByLabel("Why?").fill("Called the master number; the account change is confirmed in writing");
  await shot("f3-override-dialog");
  await axe("override dialog");
  await dialog().getByRole("button", { name: "Approve with exception" }).click();
  await page.waitForTimeout(600);
  const second = await dialog().getByRole("button", { name: "Confirm and approve" }).count();
  await shot("f3-second-confirmation");
  check("bank override asks for a second confirmation", second === 1, `state ${(await detail(r.run_id)).state}`);
  if (second) await dialog().getByRole("button", { name: "Confirm and approve" }).click();
  await page.waitForTimeout(800);
  const d = await detail(r.run_id);
  check("S2 approved with the call recorded", d.state === "APPROVED" && Boolean(d.approvals.at(-1)?.callback), d.state);
}

// 4. S8: reject with a note.
{
  const r = await byFile("S08");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Reject" }).click();
  await dialog().getByLabel("Why?").fill("Unknown vendor; not onboarded");
  await dialog().getByRole("button", { name: "Reject" }).click();
  await page.waitForTimeout(800);
  check("S8 rejected", (await detail(r.run_id)).state === "REJECTED");
}

// 5. S12: lump sum, approve with exception past the failing check (second confirmation).
{
  const r = await byFile("S12");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Approve with exception" }).click();
  await dialog().getByLabel("Why?").fill("Service visit completed, confirmed by the kitchen manager");
  await dialog().getByRole("button", { name: "Approve with exception" }).click();
  await page.waitForTimeout(600);
  const anyway = await dialog().getByRole("button", { name: "Approve anyway" }).count();
  if (anyway) await dialog().getByRole("button", { name: "Approve anyway" }).click();
  await page.waitForTimeout(800);
  const d = await detail(r.run_id);
  check("S12 approved with exception", d.state === "APPROVED", `${d.state}, second step shown: ${anyway === 1}`);
}

// 6. S9: process a skipped document as an invoice.
{
  const r = await byFile("S09");
  await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Process as an invoice" }).click();
  await dialog().getByLabel("Why?").fill("Checking how the quotation would be held");
  await dialog().getByRole("button", { name: "Process as an invoice" }).click();
  await page.waitForTimeout(1500);
  const d = await detail(r.run_id);
  check("S9 processed as an invoice: no longer skipped", d.state !== "SKIPPED", d.state);
}

// 7. Batch approval from the cleared view.
{
  await page.goto(`${B}/?view=cleared`, { waitUntil: "networkidle" });
  const before = (await runs()).filter((r) => r.state === "CLEARED" && !r.approve_blocked);
  const boxes = page.locator("table tbody input[type=checkbox]:not([disabled])");
  const n = Math.min(2, await boxes.count());
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await page.getByRole("button", { name: "Approve selected" }).click();
  await shot("f7-batch-dialog");
  await axe("batch dialog");
  await dialog().getByRole("button", { name: /^Approve ₹/ }).click();
  await page.waitForTimeout(800);
  const after = (await runs()).filter((r) => r.state === "CLEARED" && !r.approve_blocked);
  check("batch approval approved the selected invoices", before.length - after.length === n, `${before.length} -> ${after.length}`);
}

// 8. Export the payment list.
{
  await page.goto(`${B}/?view=approved`, { waitUntil: "networkidle" });
  const ready = (await runs()).filter((r) => r.state === "APPROVED" && !r.exported && !r.export_blocked).length;
  await page.getByRole("button", { name: "Export payment list" }).first().click();
  await shot("f8-export-dialog");
  await axe("export dialog");
  await dialog().getByRole("button", { name: /^Export \d+ invoice/ }).click();
  await page.waitForTimeout(800);
  const csv = await dialog().getByRole("link", { name: "Download CSV" }).count();
  await shot("f8-export-done");
  const exported = (await runs()).filter((r) => r.exported).length;
  check("export: every ready invoice exported, CSV offered", exported === ready && csv === 1, `${exported}/${ready}`);
  await dialog().getByRole("button", { name: "Done" }).click();
}

// 8b. Audit log (gap 15): linked from the exported view, a CSV of every event, matching each invoice's history.
{
  await page.goto(`${B}/?view=exported`, { waitUntil: "networkidle" });
  const link = page.getByRole("link", { name: /Audit log/ });
  check("exported view links the audit log", (await link.count()) === 1 && (await link.getAttribute("href")) === "/api/audit");
  const res = await fetch(`${B}/api/audit`);
  const text = await res.text();
  const lines = text.trim().split("\r\n");
  const all = await runs();
  let events = 0;
  for (const r of all) events += (await detail(r.run_id)).events.length;
  check(
    "audit CSV: a download with one row per recorded event",
    res.ok && /text\/csv/.test(res.headers.get("content-type")) && /attachment/.test(res.headers.get("content-disposition")) && lines.length - 1 === events,
    `${lines.length - 1} rows, ${events} events across ${all.length} invoices`,
  );
  check("audit CSV records the export", lines.some((l) => l.includes('"EXPORTED"')));
}

// 9. Demo inbox: S4 replies to the S3 correction; X1-X3 extra cases.
{
  await page.goto(`${B}/demo`, { waitUntil: "networkidle" });
  await axe("demo inbox");
  for (const t of ["S4", "X1", "X2", "X3"]) {
    await page.getByRole("button", { name: `Send ${t}`, exact: true }).click();
    await page.waitForTimeout(1500);
  }
  await shot("f9-demo-after-sends");
  const s3 = await byFile("S03");
  const s4 = await byFile("S04");
  check("S4 correction supersedes S3", s3.state === "SUPERSEDED" && Boolean(s4), `S3 ${s3.state}, S4 ${s4?.state}`);
  for (const p of ["X1", "X2", "X3"]) {
    const r = await byFile(p);
    await page.goto(`${B}/runs/${r.run_id}`, { waitUntil: "networkidle" });
    await shot(`f9-${p}`);
    console.log(`      ${p}: ${r.state} ${r.primary?.code ?? ""}`);
  }
}

// 9b. Next/previous on the review screen switches the invoice at once (no stale data from the previous one).
{
  await page.goto(B + "/", { waitUntil: "networkidle" });
  const first = page.locator("table tbody tr").first().locator("a").first();
  await first.click();
  await page.getByRole("navigation", { name: "Queue position" }).waitFor({ timeout: 10000 });
  const h1 = async () => (await page.locator("h1").first().innerText()).split("\n")[0];
  const before = await h1();
  const crumb = () => page.locator("nav[aria-label=Breadcrumb] [aria-current=page]").innerText();
  const ref0 = await crumb();
  const next = page.getByRole("link", { name: /^Next: / });
  if (await next.count()) {
    const expected = (await next.getAttribute("aria-label")).replace(/^Next: /, "");
    const url0 = page.url();
    await next.click();
    await page.waitForURL((u) => u.toString() !== url0);
    await page.waitForTimeout(300);
    const after = await h1();
    const ref1 = await crumb();
    check("next arrow opens the next invoice with its own data", after.startsWith(expected) && ref1 !== ref0, `${ref0} ${before} -> ${ref1} ${after} (expected ${expected})`);
  } else check("next arrow present on the review screen", false);
}

// 10. Rules page.
{
  await page.goto(`${B}/settings`, { waitUntil: "networkidle" });
  await axe("rules");
}

// 11. Phone: open the menu, choose a view.
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await phone.newPage();
  await p.goto(B + "/", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Open menu" }).click();
  await p.screenshot({ path: `${out}/f11-phone-menu.png` });
  await p.locator("dialog[open]").getByRole("link", { name: /Ready to approve/ }).click();
  await p.waitForTimeout(500);
  check("phone menu navigates and closes", p.url().includes("view=cleared") && (await p.locator("dialog[open]").count()) === 0, p.url());
  await phone.close();
}

check("no console errors during the flows", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
finish();
