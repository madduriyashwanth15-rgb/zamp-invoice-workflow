import type { ReasonCode } from "../codes";
import type { Extraction, ExtractionLine } from "../extraction-schema";
import type { Paise } from "../money";
import type { CatalogItem, PurchaseOrder, Settings, Vendor } from "../types";

// Engine contracts for stages 2-9 (spec section 3). The engine is pure: everything it needs is passed in,
// and it returns a decision plus the effects the run store must apply in one transaction.

export type RunState =
  | "RECEIVED" | "PROCESSING" | "SKIPPED" | "CLEARED" | "ON_HOLD" | "AWAITING_VENDOR"
  | "APPROVED" | "REJECTED" | "SUPERSEDED" | "FAILED";

export type Outcome = "SKIPPED" | "REJECTED" | "ON_HOLD" | "CLEARED";

export type StageId = "classify" | "document" | "vendor" | "duplicates" | "po" | "lines" | "compare" | "decide";

export const STAGE_LABELS: Record<StageId, string> = {
  classify: "Classification guard (G1-G3)",
  document: "Document validation (V1-V5)",
  vendor: "Vendor, sender, bank (K1-K4)",
  duplicates: "Duplicates and corrections (D1-D4)",
  po: "PO match (P1-P2)",
  lines: "Lines, charges, tax basis (M1-M7, T1-T4)",
  compare: "Compare to PO (C1-C5)",
  decide: "Decide and link (section 9)",
};

export type EvidenceValue = string | number | boolean | null | string[];

/** P3: every code carries evidence (expected, actual, source). */
export interface Finding {
  code: ReasonCode;
  stage: StageId;
  message: string;
  evidence: Record<string, EvidenceValue>;
  line_no?: number;
}

export type StageStatus = "passed" | "held" | "skipped" | "not_evaluated" | "rejected";

export interface StageResult {
  stage: StageId;
  label: string;
  status: StageStatus;
  notes: string[];
  findings: Finding[];
}

export interface ReferenceData {
  vendors: Vendor[];
  catalog: CatalogItem[];
  purchaseOrders: PurchaseOrder[];
  settings: Settings;
}

/** One PO line consumed by a CLEARED or APPROVED run (spec 2: base quantity and pre-tax paise). line_no 0 is a
 * PO-level amount with no quantity (a lump-sum line, counted only if a reviewer approves the invoice). */
export interface ConsumptionEntry {
  po_number: string;
  line_no: number;
  base_qty: string;
  amount_paise: Paise;
}

/** What the engine needs to know about earlier runs (read inside the stage 8-9 transaction). */
export interface PriorRun {
  run_id: string;
  state: RunState;
  vendor_id: string | null;
  chain_key: string | null;
  invoice_date: string | null;
  total_paise: Paise | null;
  exported: boolean;
  consumption: ConsumptionEntry[];
  /** Normalised invoice number, also for runs with no chain (vendor not matched). */
  invoice_number_norm?: string | null;
}

export interface DocumentInput {
  source: "email" | "upload";
  sender_email: string | null;
  uploader_display_name: string | null;
  /** Parsed "[Ref R-<id>]" token from the email subject or body (stage 0). */
  reply_token: string | null;
  /** Raw text layer; empty for images and scans. */
  text_layer: string;
  has_text_layer: boolean;
  /** Row 5 "process as invoice": G1 bypassed for this run (A10). */
  g1_bypassed?: boolean;
  /** Email only: the provider's sender authentication (DMARC). false = failed, so the From address cannot be
   * trusted for K3 or D2; null or absent = not reported (recorded test emails). */
  sender_authenticated?: boolean | null;
}

export interface MappingRequest {
  po: PurchaseOrder;
  line: ExtractionLine;
  candidates: PurchaseOrder["lines"];
}

/** M2 proposal (AI). A proposal never maps anything by itself; code verifies it (M3). */
export interface MappingProposal {
  proposed_po_line: number | null;
  pack_size_read: number | null;
  justification: string;
  /** Which model answered, when the proposer can use more than one (shown as evidence). */
  by?: string;
}

export interface MappingProposer {
  readonly label: string;
  propose(request: MappingRequest): Promise<MappingProposal | null>;
}

export interface EngineInput {
  extraction: Extraction;
  document: DocumentInput;
  reference: ReferenceData;
  priorRuns: PriorRun[];
  /** token -> run_id for issued correction tokens. */
  tokens: ReadonlyMap<string, string>;
  /** ISO date used by V5 ("today"). */
  today: string;
  proposer: MappingProposer | null;
}

export interface CorrectionLink {
  kind: "linked" | "unlinked";
  /** Hold-family runs in the chain (ON_HOLD or AWAITING_VENDOR). */
  hold_family_run_ids: string[];
  token: string | null;
  token_target_run_id: string | null;
}

export interface DisputeLink {
  counterpart_run_id: string;
  counterpart_state: RunState;
  counterpart_exported: boolean;
}

/** One invoice line set against the PO: how it was matched and what the comparison found. Decides nothing. */
export interface LineMatch {
  invoice_line: number;
  description: string;
  qty: string | null;
  uom: string | null;
  unit_price: string | null;
  amount: string;
  /** matched: compared on price and quantity; charge: accepted against a PO charge line; held: not compared. */
  status: "matched" | "charge" | "lump_sum" | "held";
  hold_code?: ReasonCode;
  po_line: number | null;
  po_description: string | null;
  po_uom: string | null;
  /** PO pre-tax price per PO unit. */
  po_unit_price: string | null;
  ordered: string | null;
  via: string | null;
  /** Invoice quantity in PO units, and the invoice's pre-tax price per PO unit. */
  base_qty: string | null;
  price_per_po_unit: string | null;
  price_diff_pct: string | null;
  price_result: "within" | "over" | "below" | null;
  already_billed: string | null;
  qty_result: "within" | "over" | null;
}

export interface EngineResult {
  outcome: Outcome;
  blocking: Finding[];
  info: Finding[];
  primary_reason: ReasonCode | null;
  stages: StageResult[];
  vendor_id: string | null;
  chain_key: string | null;
  invoice_number_norm: string | null;
  invoice_date: string | null;
  total_paise: Paise | null;
  po_number: string | null;
  po_match_method: "reference" | "inferred" | null;
  po_candidates: string[] | null;
  due_date: string | null;
  /** Counted only once the run is CLEARED or APPROVED. */
  consumption: ConsumptionEntry[];
  /** Each invoice line against the PO (stages 7-8), for the reviewer's table. Absent on runs decided before v1.4. */
  line_matches?: LineMatch[];
  correction: CorrectionLink | null;
  dispute: DisputeLink | null;
}
