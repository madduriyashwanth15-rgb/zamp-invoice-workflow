import { beforeAll, describe, expect, it } from "vitest";
import { approve, manualHold, overrideApprove } from "@/domain/runs/review";
import type { PipelineDeps } from "@/domain/runs/pipeline";
import type { RunStore } from "@/domain/runs/types";
import { sumRupees } from "@/lib/format";
import { summarize, type RunSummary } from "@/server/views";
import { deskMetrics, isStraightThrough } from "@/ui/desk-metrics";
import { answerKey, deliver, makeDeps, reference, runGolden, type GoldenEntry } from "./support/harness";

// The desk's metrics strip: straight-through rate, value on hold, top reasons. Built from the run list only.
// MOCK extractor (answer key), as in every default-suite test.

const DIVYA = { actor: "Divya (AP)" };

/** The run list exactly as the desk receives it (service.listRuns: summaries over the stored runs). */
async function listed(store: RunStore, ref: PipelineDeps["reference"]): Promise<RunSummary[]> {
  const state = await store.read((s) => ({ runs: s.runs, documents: s.documents }));
  return [...state.runs.values()].map((r) => summarize(r, ref, state));
}

const one = async (deps: PipelineDeps, runId: string) => (await listed(deps.store, deps.reference)).find((r) => r.run_id === runId)!;

describe("straight-through rate", () => {
  it("an empty workspace shows no rate, not 0%", () => {
    const m = deskMetrics([]);
    expect(m).toMatchObject({ decided: 0, straightThrough: 0, ratePct: null, heldNow: 0, heldValue: "0.00", heldUnread: 0, topReasons: [], otherReasons: 0 });
  });

  it("S1 cleared by the checks counts as straight through", async () => {
    const deps = makeDeps();
    await deliver(deps, "S1", {});
    const m = deskMetrics(await listed(deps.store, deps.reference));
    expect(m).toMatchObject({ decided: 1, straightThrough: 1, ratePct: 100, heldNow: 0 });
  });

  it("S1 approved by a reviewer (row 6) still counts: approval of a cleared invoice is not an intervention on a hold", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    expect((await approve(deps, [s1.run_id], DIVYA)).ok).toBe(true);
    const r = await one(deps, s1.run_id);
    expect(r.state).toBe("APPROVED");
    expect(isStraightThrough(r)).toBe(true);
  });

  it("S3 held, then approved by override (row 9): not straight through, because the hold codes stay on the run", async () => {
    const deps = makeDeps();
    const s3 = await deliver(deps, "S3", {});
    expect(isStraightThrough(await one(deps, s3.run_id))).toBe(false);
    const r = await overrideApprove(deps, s3.run_id, { ...DIVYA, note: "Price agreed by phone", confirmFailingChecks: true });
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.reason}`).toBe(true);
    const after = await one(deps, s3.run_id);
    expect(after.state).toBe("APPROVED");
    expect(after.blocking_count).toBeGreaterThan(0);
    expect(isStraightThrough(after)).toBe(false);
    expect(deskMetrics([after])).toMatchObject({ decided: 1, straightThrough: 0, ratePct: 0, heldNow: 0 });
    expect(deskMetrics([after]).topReasons.map((x) => x.code)).toEqual(["PRICE_OVER_TOLERANCE"]);
  });

  it("S1 put on hold by a person (row 7): not straight through, main reason MANUAL_HOLD", async () => {
    const deps = makeDeps();
    const s1 = await deliver(deps, "S1", {});
    expect((await manualHold(deps, s1.run_id, { ...DIVYA, note: "Confirm the delivery date" })).ok).toBe(true);
    const m = deskMetrics([await one(deps, s1.run_id)]);
    expect(m).toMatchObject({ decided: 1, straightThrough: 0, heldNow: 1 });
    expect(m.topReasons).toEqual([expect.objectContaining({ code: "MANUAL_HOLD", count: 1 })]);
  });

  it("S9, not an invoice, is left out of the rate entirely", async () => {
    const deps = makeDeps();
    const s9 = await deliver(deps, "S9", {});
    const r = await one(deps, s9.run_id);
    expect(r.state).toBe("SKIPPED");
    expect(deskMetrics([r])).toMatchObject({ decided: 0, ratePct: null, topReasons: [], otherReasons: 0 });
  });

  it("a skipped document a person sent through as an invoice (row 5) is never straight through, even if the checks clear it", async () => {
    const deps = makeDeps();
    const s1 = await one(deps, (await deliver(deps, "S1", {})).run_id);
    expect(s1.forced_as_invoice).toBe(false);
    expect(isStraightThrough({ ...s1, forced_as_invoice: true })).toBe(false);
  });

  it("failed and still-reading runs are left out of the rate", async () => {
    const deps = makeDeps();
    const s1 = await one(deps, (await deliver(deps, "S1", {})).run_id);
    const runs: RunSummary[] = [
      { ...s1, run_id: "f", state: "FAILED", blocking_count: 0 },
      { ...s1, run_id: "p", state: "PROCESSING", blocking_count: 0 },
      { ...s1, run_id: "r", state: "RECEIVED", blocking_count: 0 },
    ];
    expect(deskMetrics(runs)).toMatchObject({ decided: 0, straightThrough: 0, ratePct: null });
  });

  it("rounds to a whole percent: 1 of 3 is 33%, 2 of 3 is 67%", async () => {
    const deps = makeDeps();
    const s1 = await one(deps, (await deliver(deps, "S1", {})).run_id);
    const held: RunSummary = { ...s1, run_id: "h", state: "ON_HOLD", blocking_count: 1 };
    expect(deskMetrics([s1, held, { ...held, run_id: "h2" }]).ratePct).toBe(33);
    expect(deskMetrics([s1, { ...s1, run_id: "c2" }, held]).ratePct).toBe(67);
  });
});

describe("value on hold", () => {
  it("adds the held totals exactly and counts the ones not read, instead of dropping them silently", async () => {
    const deps = makeDeps();
    const s3 = await one(deps, (await deliver(deps, "S3", {})).run_id);
    expect(s3.state).toBe("ON_HOLD");
    expect(s3.total_rupees).not.toBeNull();
    const waiting: RunSummary = { ...s3, run_id: "w", state: "AWAITING_VENDOR", total_rupees: "0.10" };
    const unread: RunSummary = { ...s3, run_id: "u", total_rupees: null };
    const approved: RunSummary = { ...s3, run_id: "a", state: "APPROVED", total_rupees: "999.99" };
    const m = deskMetrics([s3, waiting, unread, approved]);
    expect(m.heldNow).toBe(3);
    expect(m.heldUnread).toBe(1);
    expect(m.heldValue).toBe(sumRupees([s3.total_rupees, "0.10"]));
  });
});

describe("top reasons", () => {
  it("orders by count, then by the spec's severity order, and keeps runs with no main reason as 'other'", async () => {
    const deps = makeDeps();
    const s3 = await one(deps, (await deliver(deps, "S3", {})).run_id); // PRICE_OVER_TOLERANCE
    const s2 = await one(deps, (await deliver(deps, "S2", {})).run_id); // BANK_DETAILS_CHANGED, more severe
    const noReason: RunSummary = { ...s3, run_id: "n", hold_reason: null };
    const m = deskMetrics([s3, { ...s3, run_id: "s3b" }, s2, noReason]);
    expect(m.topReasons.map((x) => [x.code, x.count])).toEqual([["PRICE_OVER_TOLERANCE", 2], ["BANK_DETAILS_CHANGED", 1]]);
    expect(m.otherReasons).toBe(1);
    // Severity breaks the tie: one each puts the bank change first.
    expect(deskMetrics([s3, s2]).topReasons.map((x) => x.code)).toEqual(["BANK_DETAILS_CHANGED", "PRICE_OVER_TOLERANCE"]);
  });

  it("shows at most three", async () => {
    const deps = makeDeps();
    const runs: RunSummary[] = [];
    for (const id of ["S2", "S3", "S7", "S10"]) runs.push(await one(deps, (await deliver(deps, id, {})).run_id));
    expect(deskMetrics(runs).topReasons).toHaveLength(3);
  });
});

describe("the whole scenario sequence (golden run, one database)", () => {
  let results: GoldenEntry[] = [];
  beforeAll(async () => {
    results = await runGolden();
  });

  it("matches what answer_key.json implies: straight through = expected CLEARED, decided = everything but SKIPPED", async () => {
    const seq = answerKey.tests.filter((t) => t.group === "scenario_sequence");
    const last = results.filter((e) => e.test.group === "scenario_sequence").at(-1)!;
    const runs = await listed(last.store, reference);
    expect(runs).toHaveLength(seq.length);

    // A side effect that changes another run's state (only S3:SUPERSEDED in v2.1) must not turn a cleared run into a held one.
    const superseded = new Set(seq.flatMap((t) => t.expected.side_effects.map(String)).filter((s) => s.endsWith(":SUPERSEDED")).map((s) => s.split(":")[0]));
    for (const id of superseded) expect(seq.find((t) => t.test_id === id)!.expected.outcome).not.toBe("CLEARED");

    const m = deskMetrics(runs);
    const decided = seq.filter((t) => t.expected.outcome !== "SKIPPED").length;
    const straight = seq.filter((t) => t.expected.outcome === "CLEARED").length;
    expect(m.decided).toBe(decided);
    expect(m.straightThrough).toBe(straight);
    expect(m.ratePct).toBe(Math.round((straight * 100) / decided));

    // Held now: the expected holds, less the one a correction replaced.
    const heldIds = seq.filter((t) => t.expected.outcome === "ON_HOLD" && !superseded.has(t.test_id)).map((t) => last.byTest.get(t.test_id)!);
    const held = runs.filter((r) => r.state === "ON_HOLD" || r.state === "AWAITING_VENDOR");
    expect(held.map((r) => r.run_id).sort()).toEqual([...heldIds].sort());
    expect(m.heldNow).toBe(heldIds.length);
    expect(m.heldValue).toBe(sumRupees(held.map((r) => r.total_rupees)));

    // Each not-straight-through invoice is counted once in the reasons (top three plus the rest).
    const counted = m.topReasons.reduce((n, x) => n + x.count, 0);
    expect(counted).toBeLessThanOrEqual(decided - straight);
    expect(m.topReasons.every((x, i, a) => i === 0 || a[i - 1].count >= x.count)).toBe(true);
  });
});
