import { beforeAll, describe, expect, it } from "vitest";
import { oracle, passRule, runGolden, type GoldenEntry } from "./support/harness";

// Golden run (test matrix A13): all 18 S/X tests through the InboundEmail adapter with recorded payloads,
// real PDF text layers, the full rule engine and state effects. MOCK extractor = answer_key expected_extraction.

let results: GoldenEntry[] = [];
beforeAll(async () => {
  results = await runGolden();
}, 60_000);

describe("golden run: pass rule against answer_key.json", () => {
  it("covers exactly the 18 tests in matrix order", () => {
    expect(results.map((r) => r.test.test_id)).toEqual([
      "S1", "S2", "S3", "S4", "S5", "S6a", "S6b", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "X1", "X2", "X3",
    ]);
  });
  const ids = ["S1", "S2", "S3", "S4", "S5", "S6a", "S6b", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "X1", "X2", "X3"];
  for (const id of ids) {
    it(`${id} passes`, () => {
      const e = results.find((r) => r.test.test_id === id)!;
      const verdict = passRule(e);
      expect(verdict.problems, `${id}: ${e.run.state} [${e.run.blocking_codes}] info [${e.run.info_codes}]`).toEqual([]);
    });
  }
});

describe("golden run: agreement with the oracle (validate_test_data.py)", () => {
  for (const o of oracle) {
    it(`${o.test_id}: same outcome, same blocking codes, same info codes`, () => {
      const e = results.find((r) => r.test.test_id === o.test_id)!;
      expect(e.run.state).toBe(o.state);
      expect([...new Set(e.run.blocking_codes)].sort()).toEqual([...new Set(o.blocking)].sort());
      expect([...new Set(e.run.info_codes)].sort()).toEqual([...new Set(o.info)].sort());
    });
  }
});

describe("golden run: every hold carries evidence (P3)", () => {
  it("each blocking finding has a message and at least one evidence field", () => {
    for (const e of results) {
      for (const f of e.run.engine?.blocking ?? []) {
        expect(f.message.length, `${e.test.test_id} ${f.code}`).toBeGreaterThan(10);
        expect(Object.keys(f.evidence).length, `${e.test.test_id} ${f.code}`).toBeGreaterThan(0);
      }
    }
  });
  it("every run has a full stage trace ending in decide", () => {
    for (const e of results) {
      const stages = e.run.engine!.stages.map((s) => s.stage);
      expect(stages[0]).toBe("classify");
      expect(stages.at(-1)).toBe("decide");
      expect(stages).toHaveLength(8);
    }
  });
});
