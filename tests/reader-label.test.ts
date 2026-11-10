import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTRACTION_PROMPT_VERSION } from "@/server/extractor/prompt";
import { modelName, readerLabel } from "@/lib/reader-label";
import { detail } from "@/server/views";
import { makeDeps, runGolden } from "./support/harness";

// Review gap 8: screens named the model twice ("Read by Gemini gemini-3.5-flash-lite"). Display only: the label
// stored on the run and in the audit trail is unchanged.

describe("the reader label names the model once", () => {
  it.each([
    ["Gemini gemini-3.5-flash-lite (extract-v3)", "gemini-3.5-flash-lite, prompt extract-v3"],
    ["Gemini gemini-3.8-flash (map-v2)", "gemini-3.8-flash, prompt map-v2"],
    ["Gemini some-model (extract-v3)", "Gemini some-model, prompt extract-v3"],
    ["Gemini gemini-3.5-flash-lite", "gemini-3.5-flash-lite"],
    ["MOCK answer key", "MOCK answer key"],
  ])("%s -> %s", (stored, shown) => {
    expect(readerLabel(stored)).toBe(shown);
  });

  it("no label stays absent; a model id is shown as configured", () => {
    expect(readerLabel(null)).toBeNull();
    expect(modelName("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(modelName("flash-x")).toBe("Gemini flash-x");
  });

  it("the review screen's read step shows the model once and still counts as AI; the stored label is untouched", async () => {
    const e = (await runGolden()).find((g) => g.test.test_id === "S1")!;
    const stored = `Gemini gemini-3.5-flash-lite (${EXTRACTION_PROMPT_VERSION})`;
    const run = { ...e.run, extracted_by: { extractor: stored, attempts: 1, cached: false, retries: [] } };
    const state = await e.store.read((s) => ({ runs: s.runs, documents: s.documents, tokens: s.tokens }));
    const d = detail(run, state, await e.store.logs(run.run_id), makeDeps().reference);
    const read = d.stages.find((s) => s.id === "read")!;
    expect(read.by).toBe(`gemini-3.5-flash-lite, prompt ${EXTRACTION_PROMPT_VERSION}`);
    expect(read.by_ai).toBe(true);
    expect(d.extracted_by?.extractor).toBe(stored);
  });
});

describe("the Rules page names the reader this deployment runs (review gap 1)", () => {
  it("has no hard-coded MOCK text: the Read step shows <ReaderWho />, which reads the server's setup like the sidebar", () => {
    const page = readFileSync("src/app/settings/page.tsx", "utf-8");
    expect(page).not.toMatch(/MOCK answer key on a test setup/);
    expect(page).toContain("<ReaderWho />");
    const strip = readFileSync("src/ui/system-strip.tsx", "utf-8");
    expect(strip).toMatch(/export function ReaderWho\(\)[\s\S]*useRuntimeInfo\(\)/);
  });
});
