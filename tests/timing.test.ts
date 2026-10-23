import { describe, expect, it } from "vitest";
import type { MappingProposer } from "@/domain/engine/types";
import type { Extractor } from "@/domain/runs/pipeline";
import { formatSeconds } from "@/lib/format";
import { detail } from "@/server/views";
import { AnswerKeyExtractor, AnswerKeyProposer, deliver, makeDeps, reference } from "./support/harness";

// Review gap 16: the review screen shows how long the reading and the checks took on that invoice, measured in the
// pipeline around each step. Nothing is estimated: with a scripted clock the recorded figures are exactly the time
// that passed inside each step, and the AI line-match proposal (M2) is counted apart from the code checks.

function scripted() {
  let t = 0;
  const clock = () => t;
  const inner = new AnswerKeyExtractor(reference);
  const extractor: Extractor = { label: inner.label, extract: async (i) => ((t += 2400), inner.extract(i)) };
  const p = new AnswerKeyProposer();
  const proposer: MappingProposer = { label: p.label, propose: async (r) => ((t += 1100), p.propose(r)) };
  return { clock, extractor, proposer };
}

describe("step timings", () => {
  it("records the reading time and, apart from the checks, the line-match proposal time (scripted clock, S14)", async () => {
    const s = scripted();
    const deps = { ...makeDeps({ extractor: s.extractor, proposer: s.proposer }), clock: s.clock };
    const run = await deliver(deps, "S14", {});
    expect(run.state).not.toBe("FAILED");
    expect(run.timing!.read_ms).toBe(2400);
    expect(run.timing!.propose_ms).toBeGreaterThan(0);
    expect(run.timing!.propose_ms % 1100).toBe(0);
    expect(run.timing!.check_ms).toBe(0);
  });

  it("with the real clock the code checks on S1 take well under a second, and nothing is negative", async () => {
    const run = await deliver({ ...makeDeps(), clock: undefined }, "S1", {});
    expect(run.timing!.check_ms).toBeGreaterThanOrEqual(0);
    expect(run.timing!.check_ms).toBeLessThan(1000);
    expect(run.timing!.read_ms).toBeGreaterThanOrEqual(0);
    expect(run.timing!.propose_ms).toBe(0);
  });

  it("a reading that fails records no timing", async () => {
    const failing: Extractor = { label: "Gemini gemini-test (extract-v3)", extract: async () => ({ status: "transport_error", error: "503: overloaded", attempts: 3, label: "Gemini gemini-test (extract-v3)" }) };
    const run = await deliver(makeDeps({ extractor: failing }), "S1", {});
    expect(run.state).toBe("FAILED");
    expect(run.timing ?? null).toBeNull();
  });

  it("the review screen states the measured reading time on an AI run, and none on a MOCK run", async () => {
    const s = scripted();
    const ai: Extractor = { label: "Gemini gemini-3.5-flash-lite (extract-v3)", extract: async (i) => ({ ...(await s.extractor.extract(i)), label: "Gemini gemini-3.5-flash-lite (extract-v3)" }) };
    for (const [extractor, expected] of [[ai, "1 call to the model, 2.4 s"], [undefined, "Values from the MOCK answer key for this test file; no AI was called"]] as const) {
      const deps = { ...makeDeps({ extractor }), clock: s.clock };
      const run = await deliver(deps, "S1", {});
      const state = await deps.store.read((st) => ({ runs: st.runs, documents: st.documents, tokens: st.tokens }));
      const d = detail(run, state, await deps.store.logs(run.run_id), reference);
      expect(d.stages.find((x) => x.id === "read")!.notes.map((n) => n.text)[0]).toBe(expected);
      expect(d.timing).toEqual(run.timing);
    }
  });

  it("durations read plainly", () => {
    expect(formatSeconds(2400)).toBe("2.4 s");
    expect(formatSeconds(23.4)).toBe("0.02 s");
    expect(formatSeconds(3)).toBe("under 0.01 s");
    expect(formatSeconds(999)).toBe("1.0 s");
    expect(formatSeconds(994)).toBe("0.99 s");
  });
});
