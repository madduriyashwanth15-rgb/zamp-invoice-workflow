import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractionDiffs } from "@/domain/evaluation/extraction-diff";
import type { Extraction } from "@/domain/extraction-schema";
import { GeminiExtractor, GeminiMappingProposer, MemoryExtractionCache } from "@/server/extractor/gemini-extractor";
import { transportFromEnv, type GeminiRequest, type GeminiResponse, type GeminiTransport } from "@/server/extractor/gemini-transport";
import { passRule, reference, runGolden } from "../support/harness";

// LIVE golden run: all 18 test invoices (S1-S14, X1-X3) read by the real Gemini model and decided by the real
// pipeline, in matrix order, scored with the same pass rule as the MOCK golden run plus field-by-field differences
// from the answer key. Uses about 23 calls of the free-tier daily quota, so it only runs on request:
//   npm run test:live:golden        (GEMINI_API_KEY and GEMINI_MODEL from .env.local)
// Results: reports/live-golden-<model>.json. A wrong read fails softly and is listed, never hidden.

const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL;

const FIELDS = [
  "doc_type", "vendor_name", "vendor_gstin", "invoice_number", "invoice_date", "po_reference", "price_basis",
  "lines[].description", "lines[].qty", "lines[].uom", "lines[].unit_price", "lines[].amount", "lines[].gst_rate",
  "subtotal", "cgst", "sgst", "tax_total", "total", "bank_account_last4",
];

/**
 * The answer key sometimes holds a value the document does not print (live run, 22 Oct: "0.00" CGST/SGST for the
 * GST-exempt Kumar invoices, which print no tax lines; a bank account for the S9 quotation, which prints none). A
 * null read where the document has no such label at all is the correct transcription, so it is reported separately
 * as "not printed", not as a misread. Only for documents with a text layer: on a scan nothing can be checked this way.
 */
const LABELS: Record<string, RegExp> = {
  cgst: /\bCGST\b/i,
  sgst: /\bSGST\b/i,
  igst: /\bIGST\b/i,
  tax_total: /total\s*(gst|tax)|(gst|tax)\s*total/i,
  bank_account_last4: /a\/c|account\s*(no|number)/i,
};

/** Spaces calls out to stay under the free tier's requests-per-minute limit. */
class PacedTransport implements GeminiTransport {
  calls = 0;
  private last = 0;
  constructor(private inner: GeminiTransport, private gapMs: number) {}
  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    this.calls++;
    return this.inner.generate(req);
  }
}

describe.skipIf(!key || !model)("LIVE golden run: 18 test invoices read by the real model", () => {
  it(`all 18 through the real pipeline with ${model}`, async () => {
    const transport = new PacedTransport(transportFromEnv(key!), Number(process.env.LIVE_GAP_MS ?? 4500));
    const extractor = new GeminiExtractor({ model: model!, transport, reference, cache: new MemoryExtractionCache() });
    const proposer = new GeminiMappingProposer({ model: model!, transport, reference });
    const started = Date.now();
    const results = await runGolden({ extractor, proposer });
    const rows = [];
    for (const e of results) {
      const t = e.test;
      const exp = t.expected as { outcome: string; blocking: string[]; info: string[] };
      const pr = passRule(e);
      const all = e.run.extraction ? extractionDiffs(t.expected_extraction as Extraction, e.run.extraction, (t.critical_fields as string[] | null) ?? FIELDS) : null;
      const doc = await e.store.read((s) => s.documents.get(e.run.run_id));
      const text = doc?.has_text_layer ? doc.text_layer : null;
      const notPrinted = (d: { field: string; actual: unknown }) => text !== null && d.actual == null && LABELS[d.field] !== undefined && !LABELS[d.field].test(text);
      const diffs = all ? all.filter((d) => !notPrinted(d)) : null;
      rows.push({
        test_id: t.test_id, pass: pr.pass, problems: pr.problems, field_differences: diffs,
        not_printed_on_document: all ? all.filter(notPrinted) : [],
        state: e.run.state, blocking: e.run.blocking_codes, info: e.run.info_codes,
        expected_outcome: exp.outcome, expected_blocking: exp.blocking, expected_info: exp.info,
        extracted_by: e.run.extracted_by, failure: e.run.failure,
      });
    }
    const summary = {
      model, api: process.env.GEMINI_API ?? "interactions", at: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
      provider_calls: transport.calls, tests: rows.length, passed_pass_rule: rows.filter((r) => r.pass).length,
      tests_with_field_differences: rows.filter((r) => r.field_differences === null || r.field_differences.length > 0).length,
      tests_with_answer_key_values_not_printed: rows.filter((r) => r.not_printed_on_document.length > 0).length,
    };
    mkdirSync("reports", { recursive: true });
    writeFileSync(`reports/live-golden-${model!.replace(/[^a-z0-9.-]/gi, "_")}.json`, JSON.stringify({ summary, results: rows }, null, 2));

    expect(rows).toHaveLength(18);
    for (const r of rows) {
      expect.soft(r.pass, `${r.test_id}: ${r.problems.join("; ")}`).toBe(true);
      expect.soft(r.field_differences ?? ["not read"], `${r.test_id} field differences`).toEqual([]);
    }
  });
});
