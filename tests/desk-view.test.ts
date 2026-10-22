import { describe, expect, it } from "vitest";
import { approve } from "@/domain/runs/review";
import { sumRupees } from "@/lib/format";
import { summarize } from "@/server/views";
import { deliver, makeDeps } from "./support/harness";

// Design pass: the desk's routing-slip strip and ledger sentence are built from recorded data only.

const statuses = (r: ReturnType<typeof summarize>) => Object.fromEntries(r.slip.map((m) => [m.id, m.status]));

describe("the routing slip in brief", () => {
  it("S2: read, held at the vendor check (and the decision), every other check passed, waiting for a reviewer", async () => {
    const deps = makeDeps();
    const s = statuses(summarize(await deliver(deps, "S2", {}), deps.reference));
    expect(s).toEqual({ read: "passed", classify: "passed", document: "passed", vendor: "held", duplicates: "passed", po: "passed", lines: "passed", compare: "passed", decide: "held", review: "waiting" });
  });

  it("S8: the checks after the unknown vendor were not reached", async () => {
    const deps = makeDeps();
    const s = statuses(summarize(await deliver(deps, "S8", {}), deps.reference));
    expect([s.duplicates, s.po, s.lines, s.compare]).toEqual(["not_reached", "not_reached", "not_reached", "not_reached"]);
  });

  it("S1 approved: the reviewer mark is done; a MOCK reading is not marked as AI", async () => {
    const deps = makeDeps();
    const run = await deliver(deps, "S1", {});
    const r = await approve(deps, [run.run_id], { actor: "Divya (AP)" });
    expect(r.ok).toBe(true);
    const sum = summarize((await deps.store.read((st) => st.runs.get(run.run_id)))!, deps.reference);
    expect(statuses(sum).review).toBe("done");
    expect(sum.slip.some((m) => m.ai)).toBe(false);
  });

  it("S9 skipped: rejected nowhere, skipped at the invoice check, no reviewer step", async () => {
    const deps = makeDeps();
    const s = statuses(summarize(await deliver(deps, "S9", {}), deps.reference));
    expect(s.classify).toBe("skipped");
    expect(s.review).toBe("not_reached");
  });
});

describe("sumRupees (the ledger sentence)", () => {
  it("adds exactly in paise and skips totals that were not read", () => {
    expect(sumRupees(["10620.00", "11474.00", null, "0.5", "0.05"])).toBe("22094.55");
    expect(sumRupees([])).toBe("0.00");
    expect(sumRupees(["0.10", "0.20"])).toBe("0.30");
  });
});
