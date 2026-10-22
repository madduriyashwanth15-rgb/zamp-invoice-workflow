import { evaluate } from "@/domain/engine/evaluate";
import type { DocumentInput, EngineResult, MappingProposer, PriorRun, ReferenceData } from "@/domain/engine/types";
import type { Extraction } from "@/domain/extraction-schema";
import { AnswerKeyProposer, parseExtraction, reference, tests } from "./harness";

// Direct engine evaluation for rule-level tests: no PDF, no store. By default the text layer is built from the
// extraction itself so V3 passes and the test isolates the rule under test.

export function extractionOf(testId: string): Extraction {
  return parseExtraction(structuredClone(tests.get(testId)!.expected_extraction));
}

export function textFrom(e: Extraction): string {
  const parts = [e.document_title, e.number_label, e.invoice_number, e.vendor_name, e.vendor_gstin, e.po_reference, e.subtotal, e.cgst, e.sgst, e.tax_total, e.total, e.bank_account_last4];
  for (const l of e.lines) parts.push(l.description, l.qty, l.uom, l.unit_price, l.amount);
  return parts.filter(Boolean).join("\n");
}

export interface DirectOptions {
  document?: Partial<DocumentInput>;
  priorRuns?: PriorRun[];
  tokens?: Map<string, string>;
  reference?: ReferenceData;
  proposer?: MappingProposer | null;
  today?: string;
}

const senderOf = (e: Extraction, ref: ReferenceData) => {
  const v = ref.vendors.find((x) => x.gstin === e.vendor_gstin || x.legal_name === e.vendor_name);
  return v?.registered_senders[0] ?? "unknown@nowhere.example";
};

export function evalDirect(e: Extraction, o: DirectOptions = {}): Promise<EngineResult> {
  const ref = o.reference ?? reference;
  return evaluate({
    extraction: e,
    document: {
      source: "email", sender_email: senderOf(e, ref), uploader_display_name: null, reply_token: null,
      text_layer: textFrom(e), has_text_layer: true, ...o.document,
    },
    reference: ref,
    priorRuns: o.priorRuns ?? [],
    tokens: o.tokens ?? new Map(),
    today: o.today ?? "2026-10-22",
    proposer: o.proposer === undefined ? new AnswerKeyProposer() : o.proposer,
  });
}

export const codes = (r: EngineResult) => [...new Set(r.blocking.map((f) => f.code))].sort();
export const infos = (r: EngineResult) => [...new Set(r.info.map((f) => f.code))].sort();

export function prior(p: Partial<PriorRun> & { run_id: string }): PriorRun {
  return { state: "CLEARED", vendor_id: null, chain_key: null, invoice_date: null, total_paise: null, exported: false, consumption: [], ...p };
}
