import { beforeAll, describe, expect, it } from "vitest";
import { REASON_CODES, type ReasonCode } from "@/domain/codes";
import type { RunRecord } from "@/domain/runs/types";
import { TIER_ORDER, sortTiers, tierOf } from "@/lib/issue-tier";
import { detail, summarize, type RunDetail, type RunSummary } from "@/server/views";
import { VIEWS, ageText, daysBetween, defaultSort, dueInDays, dueText, homeView, sortRuns } from "@/ui/queue";
import { istDate } from "@/lib/format";
import { makeDeps, runGolden, type GoldenEntry } from "./support/harness";

// UI redesign: the risk tier and the figure at stake on each hold, and the desk's views and ordering. Presentation
// only: built from the recorded findings and evidence; nothing here changes a decision. MOCK reader throughout.

async function view(e: GoldenEntry): Promise<RunDetail> {
  const state = await e.store.read((s) => ({ runs: s.runs, documents: s.documents, tokens: s.tokens }));
  return detail(e.run, state, await e.store.logs(e.run.run_id), makeDeps().reference);
}

describe("risk tiers", () => {
  it("every blocking, reject, skip and failed code has a tier; info codes have none", () => {
    for (const [code, meta] of Object.entries(REASON_CODES) as [ReasonCode, { kind: string }][]) {
      if (meta.kind === "info") expect(tierOf(code), code).toBeNull();
      else expect(tierOf(code), code).not.toBeNull();
    }
  });

  it("an unread bank account (K4b) is a bank check, any other missing field a document problem", () => {
    expect(tierOf("MISSING_REQUIRED_FIELD", "bank account")).toBe("identity");
    expect(tierOf("MISSING_REQUIRED_FIELD", "invoice number")).toBe("document");
    expect(tierOf("BANK_DETAILS_CHANGED")).toBe("identity");
    expect(tierOf("POSSIBLE_DOUBLE_BILLING")).toBe("twice");
  });

  it("sortTiers removes repeats and orders the most serious first", () => {
    expect(sortTiers(["check", "po", null, "identity", "po"])).toEqual(["identity", "po", "check"]);
    expect(TIER_ORDER[0]).toBe("identity");
  });
});

describe("held golden scenarios: tier and figure at stake on each issue", () => {
  let golden: GoldenEntry[];
  const by = (id: string) => golden.find((g) => g.test.test_id === id)!;
  beforeAll(async () => {
    golden = await runGolden();
  });

  it("S3: a PO discrepancy, ₹200.00 above the PO price before GST", async () => {
    const d = await view(by("S3"));
    const i = d.issues.find((x) => x.codes[0] === "PRICE_OVER_TOLERANCE")!;
    expect(i.tier).toBe("po");
    expect(i.impact).toBe("₹200.00 above the PO price, before GST");
    expect(d.tiers).toEqual(["po"]);
  });

  it("S2: an identity or bank check that names both accounts", async () => {
    const d = await view(by("S2"));
    const i = d.issues.find((x) => x.codes[0] === "BANK_DETAILS_CHANGED")!;
    expect(i.tier).toBe("identity");
    expect(i.impact).toBe("Pays an account ending 0091, not 2290");
    expect(d.tiers).toEqual(["identity"]);
  });

  it("S6b: two cylinders more than ordered and ₹3,000.00 over the PO limit (50,000 + 2% cap)", async () => {
    const d = await view(by("S6b"));
    expect(d.issues.find((x) => x.codes[0] === "QTY_EXCEEDS_PO")!.impact).toBe("2 cyl more than ordered");
    expect(d.issues.find((x) => x.codes[0] === "PO_AMOUNT_EXCEEDED")!.impact).toBe("₹3,000.00 over the PO limit, before GST");
  });

  it("S8: unknown vendor and unregistered sender are identity checks; S7 and S12 need a person's check", async () => {
    expect((await view(by("S8"))).tiers).toEqual(["identity"]);
    expect((await view(by("S7"))).tiers[0]).toBe("check");
    expect((await view(by("S12"))).tiers).toContain("check");
  });

  it("every held issue has a tier, and every figure is a plain sentence with no blanks", async () => {
    for (const e of golden.filter((g) => g.run.state === "ON_HOLD")) {
      const d = await view(e);
      for (const i of d.issues) {
        expect(i.tier, `${e.test.test_id} ${i.codes[0]}`).not.toBeNull();
        if (i.impact) expect(i.impact, `${e.test.test_id} ${i.codes[0]}`).not.toMatch(/undefined|null|NaN|-₹/);
      }
    }
  });

  it("cleared, approved and skipped invoices carry no tiers", () => {
    for (const e of golden.filter((g) => ["CLEARED", "APPROVED", "SKIPPED", "REJECTED"].includes(g.run.state))) {
      expect(summarize(e.run, makeDeps().reference).tiers, e.test.test_id).toEqual([]);
    }
  });
});

describe("desk views and ordering", () => {
  const run = (over: Partial<RunSummary>): RunSummary =>
    ({
      run_id: Math.random().toString(36),
      ref: "A0000",
      state: "ON_HOLD",
      tiers: [],
      total_rupees: null,
      created_at: "2026-10-23T10:00:00Z",
      exported: false,
      export_blocked: false,
      ...over,
    }) as RunSummary;

  it("each state sits in exactly one working view (besides All invoices)", () => {
    const states: RunRecord["state"][] = ["RECEIVED", "PROCESSING", "SKIPPED", "CLEARED", "ON_HOLD", "AWAITING_VENDOR", "APPROVED", "REJECTED", "SUPERSEDED", "FAILED"];
    for (const state of states) {
      for (const exported of state === "APPROVED" ? [false, true] : [false]) {
        const r = run({ state, exported });
        expect(VIEWS.filter((v) => v.id !== "all" && v.test(r)).length, `${state} exported=${exported}`).toBe(1);
        expect(homeView(r).id).not.toBe("all");
      }
    }
  });

  it("most serious first: identity, then repeats, then PO, newest first within a tier", () => {
    const a = run({ ref: "po-old", tiers: ["po"], created_at: "2026-10-23T09:00:00Z" });
    const b = run({ ref: "po-new", tiers: ["po"], created_at: "2026-10-23T11:00:00Z" });
    const c = run({ ref: "bank", tiers: ["identity", "po"] });
    const d = run({ ref: "none", tiers: [] });
    expect(sortRuns([a, d, b, c], "serious").map((r) => r.ref)).toEqual(["bank", "po-new", "po-old", "none"]);
    expect(defaultSort("review")).toBe("serious");
    expect(defaultSort("cleared")).toBe("newest");
  });

  it("amount sorting is exact in paise and puts unread totals last", () => {
    const rs = [
      run({ ref: "a", total_rupees: "999.99" }),
      run({ ref: "b", total_rupees: null }),
      run({ ref: "c", total_rupees: "1000.00" }),
      run({ ref: "d", total_rupees: "1000.01" }),
    ];
    expect(sortRuns(rs, "amount").map((r) => r.ref)).toEqual(["d", "c", "a", "b"]);
  });
});

describe("ageing on the desk (review gap 12): display only, from dates already on the run", () => {
  const run = (over: Partial<RunSummary>): RunSummary =>
    ({ run_id: Math.random().toString(36), ref: "A0000", state: "CLEARED", tiers: [], total_rupees: null, created_at: "2026-10-23T10:00:00Z", exported: false, export_blocked: false, due_per_terms: null, ...over }) as RunSummary;

  it("calendar days across a month end and a year end", () => {
    expect(daysBetween("2026-10-23", "2026-10-25")).toBe(2);
    expect(daysBetween("2026-10-25", "2026-10-23")).toBe(-2);
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("due wording and tone: overdue, today, tomorrow, within 3 days, later", () => {
    expect(dueText(-1)).toEqual({ text: "overdue by 1 day", tone: "overdue" });
    expect(dueText(-4)).toEqual({ text: "overdue by 4 days", tone: "overdue" });
    expect(dueText(0)).toEqual({ text: "due today", tone: "soon" });
    expect(dueText(1)).toEqual({ text: "due tomorrow", tone: "soon" });
    expect(dueText(3)).toEqual({ text: "due in 3 days", tone: "soon" });
    expect(dueText(4)).toEqual({ text: "due in 4 days", tone: "later" });
  });

  it("the due date is tracked only while the invoice waits for payment (not exported, rejected or replaced)", () => {
    const due = "2026-10-25";
    expect(dueInDays(run({ state: "ON_HOLD", due_per_terms: due }), "2026-10-23")).toBe(2);
    expect(dueInDays(run({ state: "APPROVED", due_per_terms: due }), "2026-10-23")).toBe(2);
    expect(dueInDays(run({ state: "APPROVED", exported: true, due_per_terms: due }), "2026-10-23")).toBeNull();
    for (const state of ["REJECTED", "SUPERSEDED", "SKIPPED"] as const) expect(dueInDays(run({ state, due_per_terms: due }), "2026-10-23")).toBeNull();
    expect(dueInDays(run({ state: "ON_HOLD", due_per_terms: null }), "2026-10-23")).toBeNull();
  });

  it("due soonest first; no due date last, newest first among those", () => {
    const rs = [
      run({ ref: "none-old", created_at: "2026-10-22T10:00:00Z" }),
      run({ ref: "late", due_per_terms: "2026-11-10" }),
      run({ ref: "exported", state: "APPROVED", exported: true, due_per_terms: "2026-10-01" }),
      run({ ref: "soon", state: "ON_HOLD", due_per_terms: "2026-10-23" }),
      run({ ref: "none-new", created_at: "2026-10-23T11:00:00Z" }),
    ];
    expect(sortRuns(rs, "due").map((r) => r.ref)).toEqual(["soon", "late", "none-new", "exported", "none-old"]);
  });

  it("age by India calendar date: 23:30 IST on the 22nd is yesterday on the 23rd", () => {
    expect(istDate(new Date("2026-10-22T18:00:00Z"))).toBe("2026-10-22"); // 23:30 IST
    expect(istDate(new Date("2026-10-22T18:31:00Z"))).toBe("2026-10-23"); // 00:01 IST
    expect(ageText("2026-10-22", "2026-10-23")).toBe("yesterday");
    expect(ageText("2026-10-23", "2026-10-23")).toBe("today");
    expect(ageText("2026-10-18", "2026-10-23")).toBe("5 days ago");
  });

  it("golden data: S3 held (16 Oct, 7 days' terms) is due per terms on the 23rd; nothing is recorded on the run for it", async () => {
    const golden = await runGolden();
    const s3 = golden.find((g) => g.test.test_id === "S3")!;
    const sum = summarize(s3.run, makeDeps().reference);
    expect(s3.run.due_date).toBeNull();
    expect(sum.due_per_terms).toBe("2026-10-23");
    expect(dueText(dueInDays(sum, "2026-10-23")!).text).toBe("due today");
    // A cleared invoice shows the due date the engine recorded; an unknown vendor has no terms, so none.
    const s1 = golden.find((g) => g.test.test_id === "S1")!;
    expect(summarize(s1.run, makeDeps().reference).due_per_terms).toBe(s1.run.due_date);
    expect(summarize(golden.find((g) => g.test.test_id === "S8")!.run, makeDeps().reference).due_per_terms).toBeNull();
  });
});
