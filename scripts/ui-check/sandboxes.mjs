// Demo workspaces in a real browser: two visitors (two browser contexts, no cookies set by the script) each get
// their own private sandbox, can open the shared inbox and come back, and "Start again" in a sandbox opens a new one
// without deleting anything. Every result is checked through the API with that visitor's own cookies.
// Local server only, in-memory store and MOCK reader only: it starts by emptying every workspace (guarded in lib.mjs).
// Usage: node scripts/ui-check/sandboxes.mjs [outdir]     (default out/ui-check/sandboxes)
import { B, guard, outDir, playwright, reporter, resetAll } from "./lib.mjs";

await guard();
const out = outDir(process.argv[2], "out/ui-check/sandboxes");
const { check, finish } = reporter();
const { chromium } = playwright();
await resetAll();

const SANDBOX = /^sb-[a-z0-9]{12}$/;
const as = (ws) => ({ cookie: `ps1-ws=${ws}` });
const runsIn = async (ws) => (await (await fetch(`${B}/api/runs`, { headers: as(ws) })).json()).runs;
const replayIn = (ws, test_id) =>
  fetch(`${B}/api/demo/replay`, { method: "POST", headers: { "Content-Type": "application/json", ...as(ws) }, body: JSON.stringify({ test_id }) }).then((r) => r.json());
const settle = () => new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch();
const errors = [];
async function visitor() {
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(B + "/", { waitUntil: "networkidle" });
  return { c, p };
}
const cookieOf = async (c, name) => (await c.cookies(B)).find((k) => k.name === name)?.value ?? null;
const strip = (p) => p.locator("aside");
const workspaceLine = async (p) => ((await strip(p).getByText("Workspace:").count()) ? (await strip(p).getByText("Workspace:").locator("..").innerText()).replace(/\s+/g, " ") : "");

// 1. Two visitors, two private sandboxes.
const a = await visitor();
const b = await visitor();
const wsA = await cookieOf(a.c, "ps1-ws");
const wsB = await cookieOf(b.c, "ps1-ws");
check("each visitor gets a private sandbox of their own", SANDBOX.test(wsA ?? "") && SANDBOX.test(wsB ?? "") && wsA !== wsB, `${wsA} / ${wsB}`);
check("the sandbox is remembered in the second cookie", (await cookieOf(a.c, "ps1-sb")) === wsA && (await cookieOf(b.c, "ps1-sb")) === wsB);
const cookieA = (await a.c.cookies(B)).find((k) => k.name === "ps1-ws");
check("the cookie is httpOnly, SameSite=Lax, for the whole site", cookieA?.httpOnly === true && cookieA?.sameSite === "Lax" && cookieA?.path === "/");
const lineA = await workspaceLine(a.p);
check("side menu says it is a private sandbox", /Workspace: private sandbox, only you see it/.test(lineA), lineA);
check("side menu offers the shared inbox", (await strip(a.p).getByRole("button", { name: "Open the shared inbox" }).count()) === 1);
check("side menu: a sandbox sends no email (stated, not a warning)", (await strip(a.p).getByText("copy and send by hand (a sandbox sends no email)").count()) === 1);
await a.p.screenshot({ path: `${out}/w1-sandbox-desk.png` });

// 2. Visitor A replays S1 from the demo inbox, in the browser.
await a.p.getByLabel("Acting as").selectOption("Divya (AP)");
await a.p.goto(`${B}/demo`, { waitUntil: "networkidle" });
check("demo inbox explains the sandbox", (await a.p.getByText("You're in a private sandbox").count()) === 1);
check("demo inbox: Start again opens a new sandbox, nothing is deleted", (await a.p.getByRole("button", { name: "Start a new sandbox" }).count()) === 1 && (await a.p.getByText("Nothing is deleted").count()) === 1);
check("demo inbox: no shared-inbox reset in a sandbox", (await a.p.getByText("in every private sandbox. This cannot be undone").count()) === 0);
await a.p.screenshot({ path: `${out}/w2-sandbox-demo.png`, fullPage: true });
await a.p.getByRole("button", { name: "Send S1", exact: true }).click();
await settle();
const runsA = await runsIn(wsA);
check("A's replay is in A's sandbox", runsA.length === 1 && (runsA[0].filename ?? "").startsWith("S01"), `${runsA.length} runs`);
check("B's sandbox and the shared inbox are untouched", (await runsIn(wsB)).length === 0 && (await runsIn("main")).length === 0);
await b.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
check("B's desk shows no invoices", (await b.p.getByText("No invoices yet").count()) === 1);

// 3. The same recorded email in B: its own run, with its own reference A0001.
await b.p.getByLabel("Acting as").selectOption("Meera (Finance)");
await b.p.goto(`${B}/demo`, { waitUntil: "networkidle" });
await b.p.getByRole("button", { name: "Send S1", exact: true }).click();
await settle();
const runsB = await runsIn(wsB);
check("the same email in B creates B's own run", runsB.length === 1 && runsB[0].run_id !== runsA[0].run_id && runsB[0].state === "CLEARED", runsB.map((r) => r.state).join());
check("references restart in each sandbox", runsA[0].ref === "A0001" && runsB[0].ref === "A0001");
await b.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
check("B's desk lists exactly B's invoice", (await b.p.locator(`a[href="/runs/${runsB[0].run_id}"]`).count()) > 0 && (await b.p.locator(`a[href="/runs/${runsA[0].run_id}"]`).count()) === 0);
await b.p.goto(`${B}/runs/${runsA[0].run_id}`, { waitUntil: "networkidle" });
await b.p.screenshot({ path: `${out}/w2b-other-sandbox-link.png` });
const apiStatus = (await fetch(`${B}/api/runs/${runsA[0].run_id}`, { headers: as(wsB) })).status;
check(
  "B cannot open A's invoice, even with its link, and is told why",
  apiStatus === 404 && (await b.p.getByRole("button", { name: /Approve/ }).count()) === 0 && (await b.p.getByText("It may be in another visitor's private sandbox").count()) === 1,
  `API ${apiStatus}`,
);

// 4. A opens the shared inbox and comes back.
await replayIn("main", "S6a");
await settle();
await a.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
await strip(a.p).getByRole("button", { name: "Open the shared inbox" }).click();
await a.p.waitForURL(`${B}/`);
await a.p.waitForLoadState("networkidle");
const lineMain = await workspaceLine(a.p);
check("switching: the side menu says shared AP inbox", /Workspace: shared AP inbox, real emails arrive here/.test(lineMain), lineMain);
check("switching: the cookie names the shared inbox, the sandbox is remembered", (await cookieOf(a.c, "ps1-ws")) === "main" && (await cookieOf(a.c, "ps1-sb")) === wsA);
const mainRun = (await runsIn("main"))[0];
await a.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
check("the shared inbox shows its own invoice, not A's", (await a.p.locator(`a[href="/runs/${mainRun.run_id}"]`).count()) > 0 && (await a.p.locator(`a[href="/runs/${runsA[0].run_id}"]`).count()) === 0);
await a.p.screenshot({ path: `${out}/w3-shared-desk.png` });
await a.p.goto(`${B}/demo`, { waitUntil: "networkidle" });
check("shared inbox: Start again warns it empties every sandbox too", (await a.p.getByText("in the shared inbox and in every private sandbox").count()) === 1);
check("shared inbox: the real-email notice is back", (await a.p.getByText("Try a real email instead").count()) === 1);
await strip(a.p).getByRole("button", { name: "Back to my sandbox" }).click();
await a.p.waitForURL(`${B}/`);
await a.p.waitForLoadState("networkidle");
await a.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
check("back: A is in the same sandbox, with its invoice", (await cookieOf(a.c, "ps1-ws")) === wsA && (await a.p.locator(`a[href="/runs/${runsA[0].run_id}"]`).count()) > 0);

// 5. Start again in A's sandbox: a new, empty sandbox; nothing deleted.
await a.p.goto(`${B}/demo`, { waitUntil: "networkidle" });
await a.p.getByRole("button", { name: "Start a new sandbox" }).click();
await a.p.getByText("A new, empty sandbox is ready").waitFor({ timeout: 5000 }).catch(() => undefined);
await a.p.screenshot({ path: `${out}/w4-new-sandbox.png` });
const wsA2 = await cookieOf(a.c, "ps1-ws");
check("Start again: says a new sandbox is ready", (await a.p.getByText("A new, empty sandbox is ready").count()) === 1);
check("Start again: a new sandbox id in both cookies", SANDBOX.test(wsA2 ?? "") && wsA2 !== wsA && (await cookieOf(a.c, "ps1-sb")) === wsA2, `${wsA} -> ${wsA2}`);
check("Start again: the new sandbox is empty", (await runsIn(wsA2)).length === 0);
await a.p.goto(`${B}/?view=all`, { waitUntil: "networkidle" });
check("Start again: the desk is empty", (await a.p.getByText("No invoices yet").count()) === 1);
check("Start again: nothing was deleted (old sandbox, B and the shared inbox keep theirs)", (await runsIn(wsA)).length === 1 && (await runsIn(wsB)).length === 1 && (await runsIn("main")).length === 1);

// 6. Phone: the workspace line is in the menu.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c.addCookies([{ name: "ps1-ws", value: wsB, url: B }, { name: "ps1-sb", value: wsB, url: B }]);
  const p = await c.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(B + "/", { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Open menu" }).click();
  const menu = p.locator("dialog[open]");
  await p.screenshot({ path: `${out}/w5-phone-menu.png` });
  check("phone: the menu shows the workspace and the switch", (await menu.getByText("private sandbox, only you see it").count()) === 1 && (await menu.getByRole("button", { name: "Open the shared inbox" }).count()) === 1);
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("phone: no sideways scroll with the menu open", !sideways);
  await c.close();
}

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
finish();
