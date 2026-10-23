import type { EventCode, ReasonCode } from "../codes";
import type { ConsumptionEntry, EngineResult, PriorRun, RunState } from "../engine/types";
import type { Extraction } from "../extraction-schema";
import type { Paise } from "../money";

// Run records, audit events and the store port (spec 2 and 11). The in-memory store backs the golden
// run and domain tests; a Postgres store implements the same port later (Phase D).

export interface RunRecord {
  run_id: string;
  /** Short human reference used in correction tokens ("[Ref R-<ref>]"). */
  ref: string;
  state: RunState;
  version: number;
  source: "email" | "upload";
  sender_email: string | null;
  uploader_display_name: string | null;
  provider_email_id: string | null;
  attachment_id: string | null;
  filename: string | null;
  subject: string | null;
  reply_token: string | null;
  has_text_layer: boolean;
  g1_bypassed: boolean;
  /** Email only: DMARC result from the provider (false = failed, null = not reported). */
  sender_authenticated?: boolean | null;
  extraction: Extraction | null;
  /** Which extractor and prompt version read the document, after how many provider calls (0 = cache hit). */
  extracted_by: { extractor: string; attempts: number; cached: boolean; retries?: string[] } | null;
  /**
   * How long the last processing took, measured around each step (review gap 16): reading the document, the code
   * checks, and inside the checks any AI line-match proposal (M2), which is counted apart. Absent on runs processed
   * before 23 Oct and on runs whose reading failed.
   */
  timing?: RunTiming | null;
  engine: EngineResult | null;
  vendor_id: string | null;
  chain_key: string | null;
  invoice_number_norm: string | null;
  invoice_date: string | null;
  total_paise: Paise | null;
  po_number: string | null;
  blocking_codes: ReasonCode[];
  info_codes: ReasonCode[];
  primary_reason: ReasonCode | null;
  consumption: ConsumptionEntry[];
  due_date: string | null;
  exported: boolean;
  export_id: string | null;
  export_blocked: boolean;
  export_block_reason: ReasonCode | null;
  supersedes_run_ids: string[];
  superseded_by_run_id: string | null;
  failure: string | null;
  /**
   * Secret random seed for this run's reply tokens (spec v1.4 D2, Q7). Never shown or sent: unlike the run id, which
   * is in every link, it cannot be read from the app. Absent on runs created before v1.4 (the run id is used).
   */
  token_seed?: string;
  created_at: string;
  updated_at: string;
}

export interface RunTiming {
  read_ms: number;
  check_ms: number;
  propose_ms: number;
}

export interface Approval {
  run_id: string;
  approver_display_name: string;
  approved_at: string;
  mode: "individual" | "batch" | "override" | "link-confirmation" | "replacement";
  batch_id: string | null;
  note: string | null;
  /** Override of a bank, vendor or sender hold: the call that confirmed it (spec v1.4 row 9, Q9). */
  callback?: CallbackRecord;
}

/** A reviewer's record of the phone call that confirmed a bank, vendor or sender hold before an override. */
export interface CallbackRecord {
  number_called: string;
  spoke_to: string;
  called_at: string;
  /** The holds the call confirmed. */
  codes: string[];
  /** The vendor-master number the call had to use; null for a vendor not in the master. */
  master_phone: string | null;
}

export interface ExportRecord {
  export_id: string;
  created_by_display_name: string;
  created_at: string;
  run_ids: string[];
}

export interface CorrectionRequest {
  run_id: string;
  token: string;
  sent_at: string;
  channel: "sent" | "marked sent manually";
  /** Where the email went and the provider's message id, when the app sent it itself. */
  to?: string | null;
  provider_message_id?: string | null;
}

export type EventType =
  | "RUN_RECEIVED" | "PROCESSING_STARTED" | "DECIDED" | "STATE_CHANGED" | "EXPORTED" | "CORRECTION_SENT"
  | "NOTE" | EventCode;

export interface AuditEvent {
  seq: number;
  run_id: string | null;
  type: EventType;
  actor: string; // "system" or the demo display name
  at: string;
  from_state?: RunState;
  to_state?: RunState;
  transition?: number;
  code?: ReasonCode;
  note?: string | null;
  details?: Record<string, unknown>;
}

/** The original file's metadata and text layer. The bytes are kept for retries and re-processing (rows 4, 5)
 * but live outside StoreState: write them through `tx.newFiles`, read them with `RunStore.documentBytes`. */
export interface StoredDocument {
  run_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string | null;
  text_layer: string;
  has_text_layer: boolean;
  body_text: string | null;
}

/**
 * What a transaction (or a read) sees. Runs, documents, tokens and deliveries are the current state.
 * The four logs are append-only: inside a transaction they start EMPTY and collect only this transaction's new
 * entries (the store assigns event seq numbers at commit). Query existing log entries with `RunStore.logs`.
 * `newFiles` is write-only: original files received in this transaction, keyed by run id.
 */
export interface StoreState {
  runs: Map<string, RunRecord>;
  documents: Map<string, StoredDocument>;
  tokens: Map<string, string>;
  deliveries: Set<string>;
  events: AuditEvent[];
  approvals: Approval[];
  exports: ExportRecord[];
  corrections: CorrectionRequest[];
  newFiles: Map<string, Uint8Array>;
}

export interface Logs {
  events: AuditEvent[];
  approvals: Approval[];
  exports: ExportRecord[];
  corrections: CorrectionRequest[];
}

export function toPriorRun(r: RunRecord): PriorRun {
  return {
    run_id: r.run_id, state: r.state, vendor_id: r.vendor_id, chain_key: r.chain_key, invoice_date: r.invoice_date,
    total_paise: r.total_paise, exported: r.exported, consumption: r.consumption, invoice_number_norm: r.invoice_number_norm,
  };
}

/**
 * Store port (in-memory for tests, Postgres in the app). `transaction` runs `fn` atomically and serialised with
 * every other transaction: all changes commit together or not at all. `fn` must be synchronous: slow work
 * (extraction, AI calls) happens between transactions, never inside one.
 */
export interface RunStore {
  transaction<T>(fn: (tx: StoreState) => T): Promise<T>;
  /** A consistent snapshot; changes made to it are discarded. Logs are empty here: use `logs`. */
  read<T>(fn: (state: StoreState) => T): Promise<T>;
  /** Log entries, oldest first; with a run id, only that run's (exports: those that include it). */
  logs(runId?: string): Promise<Logs>;
  documentBytes(runId: string): Promise<Uint8Array | null>;
}
