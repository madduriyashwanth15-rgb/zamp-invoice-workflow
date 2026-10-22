import path from "node:path";
import type { MappingProposal, MappingProposer, MappingRequest, ReferenceData } from "@/domain/engine/types";
import { extractionSchema, type Extraction } from "@/domain/extraction-schema";
import type { ExtractionAttempt, Extractor, ExtractorInput } from "@/domain/runs/pipeline";
import { loadAnswerKey } from "@/fixtures/load";

// MOCK providers, used by the golden run and by the app when no Gemini key is configured. They do not read the
// document: they look the file up by name in the test-data answer key. Any other file fails with that reason.

export const MOCK_EXTRACTOR_LABEL = "MOCK answer-key extractor (no AI; test files only)";

export class AnswerKeyExtractor implements Extractor {
  readonly label = MOCK_EXTRACTOR_LABEL;
  private key = loadAnswerKey();
  private schema;
  constructor(reference: ReferenceData, private mutate?: (e: Extraction, testId: string) => Extraction) {
    this.schema = extractionSchema(reference.settings);
  }
  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    const t = this.key.tests.find((x) => path.basename(x.file as string) === input.filename);
    if (!t) {
      return { status: "transport_error", error: `the MOCK extractor only knows the 18 test-data files by name; "${input.filename}" is not one (configure GEMINI_API_KEY to read real documents)`, attempts: 1, label: this.label };
    }
    let e = this.schema.parse(structuredClone(t.expected_extraction));
    if (this.mutate) e = this.schema.parse(this.mutate(structuredClone(e), t.test_id));
    return { status: "ok", extraction: e, attempts: 1, label: this.label };
  }
}

/** MOCK M2 proposer: ground-truth proposals from the answer key (only S14 has one). */
export class AnswerKeyProposer implements MappingProposer {
  readonly label = "MOCK answer-key mapping proposer";
  private key = loadAnswerKey();
  constructor(private override?: (req: MappingRequest) => MappingProposal | null) {}
  async propose(req: MappingRequest): Promise<MappingProposal | null> {
    if (this.override) return this.override(req);
    for (const t of this.key.tests) {
      const gt = t.ai_mapping_ground_truth as { invoice_line: number; proposed_po_line: number; pack_size_read: number; justification: string }[] | null;
      if (!gt) continue;
      const ex = t.expected_extraction as Extraction;
      const hit = gt.find((g) => ex.lines.find((l) => l.line_no === g.invoice_line)?.description === req.line.description);
      if (hit) return { proposed_po_line: hit.proposed_po_line, pack_size_read: hit.pack_size_read, justification: hit.justification };
    }
    return null;
  }
}
