import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractionDiffs } from "@/domain/evaluation/extraction-diff";
import type { Extraction } from "@/domain/extraction-schema";
import type { PipelineDeps } from "@/domain/runs/pipeline";
import { GeminiExtractor, GeminiMappingProposer, MemoryExtractionCache } from "@/server/extractor/gemini-extractor";
import { transportFromEnv } from "@/server/extractor/gemini-transport";
import { deliver, makeDeps, reference, tests } from "../support/harness";

// LIVE extraction run (plan phase E acceptance): S1, S7 and S14 read by the real Gemini API, then decided by the
// real pipeline. Field differences from the answer key are recorded (and fail softly) so a wrong read is never
// hidden behind a right outcome. Results go to reports/live-extraction.json. Needs GEMINI_API_KEY and GEMINI_MODEL.

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;

const FIELDS = [
  "doc_type", "vendor_name", "vendor_gstin", "invoice_number", "invoice_date", "po_reference", "price_basis",
  "lines[].description", "lines[].qty", "lines[].uom", "lines[].unit_price", "lines[].amount", "lines[].gst_rate",
  "subtotal", "cgst", "sgst", "tax_total", "total", "bank_account_last4",
];

describe.skipIf(!key || !model)("LIVE Gemini extraction (S1, S7, S14)", () => {
  const results: Record<string, unknown>[] = [];

  for (const id of ["S1", "S7", "S14"]) {
    it(`${id}: read by ${model}, decided by the pipeline`, async () => {
      const transport = transportFromEnv(key!);
      const deps: PipelineDeps = {
        ...makeDeps(),
        extractor: new GeminiExtractor({ model: model!, transport, reference, cache: new MemoryExtractionCache() }),
        proposer: new GeminiMappingProposer({ model: model!, transport, reference }),
      };
      const t = tests.get(id)!;
      const started = Date.now();
      const run = await deliver(deps, id, {});
      const ms = Date.now() - started;
      const expected = t.expected as { outcome: string; blocking: string[]; info: string[] };
      const diffs = run.extraction ? extractionDiffs(t.expected_extraction as Extraction, run.extraction, (t.critical_fields as string[] | null) ?? FIELDS) : null;
      results.push({
        test_id: id, model, api: process.env.GEMINI_API ?? "interactions", ms, extracted_by: run.extracted_by, state: run.state, blocking: run.blocking_codes, info: run.info_codes,
        expected_outcome: expected.outcome, expected_blocking: expected.blocking, expected_info: expected.info, po: run.po_number, diffs, failure: run.failure,
      });
      expect(run.state, run.failure ?? "").not.toBe("FAILED");
      expect.soft(diffs, `${id} field differences`).toEqual([]);
      expect.soft(run.state, `${id} outcome`).toBe(expected.outcome);
      expect.soft([...run.blocking_codes].sort(), `${id} blocking`).toEqual([...expected.blocking].sort());
      for (const code of expected.info) expect.soft(run.info_codes, `${id} info`).toContain(code);
      await new Promise((r) => setTimeout(r, 4000)); // stay well inside free-tier requests per minute
    });
  }

  it("records the results", () => {
    mkdirSync("reports", { recursive: true });
    writeFileSync("reports/live-extraction.json", JSON.stringify({ at: new Date().toISOString(), model, results }, null, 2));
    expect(results.length).toBe(3);
  });
});
