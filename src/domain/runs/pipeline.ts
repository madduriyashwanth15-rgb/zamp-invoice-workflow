import { evaluate } from "../engine/evaluate";
import type { EngineResult, MappingProposer, ReferenceData } from "../engine/types";
import type { Extraction } from "../extraction-schema";
import { deliveryKey } from "../intake/inbound-email";
import { normInvoiceNumber } from "../normalise";
import { pushEvent, transition } from "./state-machine";
import { toPriorRun, type RunRecord, type RunStore, type StoreState } from "./types";

// Stages 0-9 glue: receive a document, run extraction through the injected extractor, evaluate, and apply
// the decision plus its effects on other runs (D2 supersession / return to hold, D3 dispute) in one transaction.

export interface ExtractorInput {
  filename: string;
  content_type: string;
  bytes: Uint8Array;
  text_layer: string;
  sha256: string | null;
}

export type ExtractionAttempt =
  | { status: "ok"; extraction: Extraction; attempts: number; label: string; cached?: boolean }
  | { status: "schema_invalid"; errors: string[]; attempts: number; label: string }
  | { status: "transport_error"; error: string; attempts: number; label: string };

export interface Extractor {
  readonly label: string;
  extract(input: ExtractorInput): Promise<ExtractionAttempt>;
}

export interface PipelineDeps {
  store: RunStore;
  reference: ReferenceData;
  today: () => string;
  now: () => string;
  newId: () => string;
  /** Short human reference for a new run (the reply token is "R-<ref>"); called inside the receiving transaction. */
  newRef: (tx: StoreState) => string;
  extractor: Extractor;
  proposer: MappingProposer | null;
}

export interface IncomingDocument {
  source: "email" | "upload";
  sender_email: string | null;
  uploader_display_name: string | null;
  provider_email_id: string | null;
  attachment_id: string | null;
  filename: string;
  content_type: string;
  bytes: Uint8Array;
  sha256?: string | null;
  subject: string | null;
  body_text?: string | null;
  reply_token: string | null;
  text_layer: string;
  has_text_layer: boolean;
  /** Email only: DMARC result from the provider (false = failed, null = not reported). */
  sender_authenticated?: boolean | null;
}

export type ReceiveResult = { kind: "new"; run_id: string } | { kind: "repeat"; run_id: string };

/** Stage 0: record the run (RECEIVED) and its document. A repeated email delivery is a logged no-op (F7). */
export function receive(deps: PipelineDeps, doc: IncomingDocument): Promise<ReceiveResult> {
  return deps.store.transaction((tx): ReceiveResult => {
    const at = deps.now();
    if (doc.source === "email" && doc.provider_email_id && doc.attachment_id) {
      const key = deliveryKey(doc.provider_email_id, doc.attachment_id);
      if (tx.deliveries.has(key)) {
        const existing = [...tx.runs.values()].find((r) => r.provider_email_id === doc.provider_email_id && r.attachment_id === doc.attachment_id)!;
        pushEvent(tx, { run_id: existing.run_id, type: "DELIVERY_REPEAT_IGNORED", actor: "system", at, details: { key } });
        return { kind: "repeat", run_id: existing.run_id };
      }
      tx.deliveries.add(key);
    }
    // Upload idempotency (spec 11): the same file uploaded again within 60 seconds returns the existing run.
    if (doc.source === "upload" && doc.sha256) {
      const recent = [...tx.runs.values()].find(
        (r) => r.source === "upload" && tx.documents.get(r.run_id)?.sha256 === doc.sha256 && Date.parse(at) - Date.parse(r.created_at) < 60_000,
      );
      if (recent) {
        pushEvent(tx, { run_id: recent.run_id, type: "DELIVERY_REPEAT_IGNORED", actor: "system", at, details: { reason: "same file uploaded again within 60 seconds", sha256: doc.sha256, uploader: doc.uploader_display_name } });
        return { kind: "repeat", run_id: recent.run_id };
      }
    }
    const run: RunRecord = {
      run_id: deps.newId(), ref: deps.newRef(tx), state: "RECEIVED", version: 1, source: doc.source,
      sender_email: doc.sender_email, uploader_display_name: doc.uploader_display_name,
      provider_email_id: doc.provider_email_id, attachment_id: doc.attachment_id, filename: doc.filename,
      subject: doc.subject, reply_token: doc.reply_token, has_text_layer: doc.has_text_layer, g1_bypassed: false,
      sender_authenticated: doc.sender_authenticated ?? null,
      extraction: null, extracted_by: null, engine: null, vendor_id: null, chain_key: null, invoice_number_norm: null, invoice_date: null,
      total_paise: null, po_number: null, blocking_codes: [], info_codes: [], primary_reason: null, consumption: [],
      due_date: null, exported: false, export_id: null, export_blocked: false, export_block_reason: null,
      supersedes_run_ids: [], superseded_by_run_id: null, failure: null, created_at: at, updated_at: at,
    };
    tx.runs.set(run.run_id, run);
    tx.documents.set(run.run_id, {
      run_id: run.run_id, filename: doc.filename, content_type: doc.content_type, size_bytes: doc.bytes.length, sha256: doc.sha256 ?? null,
      text_layer: doc.text_layer, has_text_layer: doc.has_text_layer, body_text: doc.body_text ?? null,
    });
    tx.newFiles.set(run.run_id, doc.bytes);
    pushEvent(tx, { run_id: run.run_id, type: "RUN_RECEIVED", actor: "system", at, details: { source: doc.source, filename: doc.filename, sender: doc.sender_email, uploader: doc.uploader_display_name } });
    return { kind: "new", run_id: run.run_id };
  });
}

function applyDecision(tx: StoreState, run: RunRecord, engine: EngineResult, at: string) {
  const ex = run.extraction;
  run.engine = engine;
  run.vendor_id = engine.vendor_id;
  run.chain_key = engine.chain_key;
  run.invoice_number_norm = engine.invoice_number_norm ?? (ex?.invoice_number ? normInvoiceNumber(ex.invoice_number) : null);
  run.invoice_date = engine.invoice_date;
  run.total_paise = engine.total_paise;
  run.po_number = engine.po_number;
  run.blocking_codes = [...new Set(engine.blocking.map((f) => f.code))];
  run.info_codes = [...new Set(engine.info.map((f) => f.code))];
  run.primary_reason = engine.primary_reason;
  run.consumption = engine.consumption;
  run.due_date = engine.due_date;
  run.failure = null;
  transition(tx, run, 2, engine.outcome, { actor: "system", at, code: engine.primary_reason ?? undefined });
  pushEvent(tx, { run_id: run.run_id, type: "DECIDED", actor: "system", at, details: { outcome: engine.outcome, blocking: run.blocking_codes, info: run.info_codes, extracted_by: run.extracted_by } });

  // D2 effects (spec 5): a token-linked correction that cleared supersedes every hold-family run (row 15);
  // in every hold case an AWAITING_VENDOR original returns to ON_HOLD (row 12).
  const c = engine.correction;
  if (c) {
    for (const id of c.hold_family_run_ids) {
      const original = tx.runs.get(id)!;
      if (c.kind === "linked" && engine.outcome === "CLEARED") {
        transition(tx, original, 15, "SUPERSEDED", { actor: "system", at, details: { superseded_by: run.run_id, token: c.token } });
        original.superseded_by_run_id = run.run_id;
        run.supersedes_run_ids.push(id);
      } else if (original.state === "AWAITING_VENDOR") {
        transition(tx, original, 12, "ON_HOLD", { actor: "system", at, details: { vendor_reply_run: run.run_id } });
      }
    }
  }
  // D3 effects: a CLEARED counterpart returns to hold (row 8; its consumption stops counting because consumption
  // counts only CLEARED and APPROVED runs); an APPROVED, unexported counterpart is export-blocked; an exported one is unchanged.
  const d = engine.dispute;
  if (d) {
    const counterpart = tx.runs.get(d.counterpart_run_id)!;
    if (counterpart.state === "CLEARED") {
      transition(tx, counterpart, 8, "ON_HOLD", { actor: "system", at, code: "RELATED_INVOICE_DISPUTE", details: { disputed_by: run.run_id } });
      if (!counterpart.blocking_codes.includes("RELATED_INVOICE_DISPUTE")) counterpart.blocking_codes.push("RELATED_INVOICE_DISPUTE");
      counterpart.primary_reason = "RELATED_INVOICE_DISPUTE";
    } else if (counterpart.state === "APPROVED" && !counterpart.exported) {
      counterpart.export_blocked = true;
      counterpart.export_block_reason = "RELATED_INVOICE_DISPUTE";
      counterpart.version += 1;
      pushEvent(tx, { run_id: counterpart.run_id, type: "NOTE", actor: "system", at, code: "RELATED_INVOICE_DISPUTE", details: { export_blocked_by: run.run_id } });
    }
  }
}

/**
 * Everything a decision depends on outside the run itself: decided runs of the same vendor (duplicates, chains,
 * corrections: D1-D4), runs consuming the same POs (C2/C3), and the reply tokens. If any of that changed while we
 * evaluated, evaluate again. Runs still being read carry no vendor or consumption yet, so they are not in it:
 * whichever of two related runs commits second sees the first in its own fingerprint and re-evaluates.
 */
function fingerprint(s: Pick<StoreState, "runs" | "tokens">, runId: string, engine: EngineResult): string {
  const pos = new Set([...engine.consumption.map((c) => c.po_number), ...(engine.po_number ? [engine.po_number] : []), ...(engine.po_candidates ?? [])]);
  const relevant = (r: RunRecord) =>
    r.run_id !== runId && engine.vendor_id !== null &&
    (r.vendor_id === engine.vendor_id || (r.po_number !== null && pos.has(r.po_number)) || r.consumption.some((c) => pos.has(c.po_number)));
  return JSON.stringify([...s.runs.values()].filter(relevant).map((r) => [r.run_id, r.state, r.version, r.exported])) + JSON.stringify([...s.tokens]);
}

const MAX_REEVALUATIONS = 5;

/**
 * Stages 1-9: extract, evaluate, decide. A RECEIVED run starts with row 1; a run already put in PROCESSING by a
 * reviewer action (row 4 retry, row 5 process as invoice) continues from there.
 */
export async function processRun(deps: PipelineDeps, runId: string): Promise<RunRecord> {
  const doc = await deps.store.transaction((tx) => {
    const run = tx.runs.get(runId)!;
    if (run.state === "RECEIVED") transition(tx, run, 1, "PROCESSING", { actor: "system", at: deps.now() });
    else if (run.state !== "PROCESSING") throw new Error(`run ${runId} is ${run.state}, not RECEIVED or PROCESSING`);
    return tx.documents.get(runId)!;
  });
  const bytes = await deps.store.documentBytes(runId);
  if (!bytes) throw new Error(`run ${runId}: original file missing`);
  const attempt = await deps.extractor.extract({ filename: doc.filename, content_type: doc.content_type, bytes, text_layer: doc.text_layer, sha256: doc.sha256 });

  if (attempt.status === "transport_error") {
    return deps.store.transaction((tx) => {
      const run = tx.runs.get(runId)!;
      if (run.state !== "PROCESSING") return run; // already failed by the stuck-run sweep; a retry starts again
      run.failure = `PROCESSING_ERROR: ${attempt.error} (${attempt.attempts} attempts)`;
      run.extracted_by = { extractor: attempt.label, attempts: attempt.attempts, cached: false };
      run.primary_reason = "PROCESSING_ERROR";
      transition(tx, run, 3, "FAILED", { actor: "system", at: deps.now(), code: "PROCESSING_ERROR", details: { attempts: attempt.attempts, extractor: attempt.label, error: attempt.error } });
      return run;
    });
  }
  if (attempt.status === "schema_invalid") {
    return deps.store.transaction((tx) => {
      const run = tx.runs.get(runId)!;
      if (run.state !== "PROCESSING") return run;
      const at = deps.now();
      run.blocking_codes = ["EXTRACTION_FAILED"];
      run.extracted_by = { extractor: attempt.label, attempts: attempt.attempts, cached: false };
      run.primary_reason = "EXTRACTION_FAILED";
      run.engine = null;
      transition(tx, run, 2, "ON_HOLD", { actor: "system", at, code: "EXTRACTION_FAILED", details: { errors: attempt.errors, attempts: attempt.attempts, extractor: attempt.label } });
      pushEvent(tx, { run_id: runId, type: "DECIDED", actor: "system", at, details: { outcome: "ON_HOLD", blocking: ["EXTRACTION_FAILED"], errors: attempt.errors } });
      return run;
    });
  }

  // Optimistic stage 8-9 commit (A11): evaluate on a snapshot, commit only if nothing the decision depends on
  // changed meanwhile, otherwise evaluate again. The Postgres store gets the same guarantee from PO and chain
  // locks taken inside the transaction (test T16).
  for (let i = 0; i < MAX_REEVALUATIONS; i++) {
    const snap = await deps.store.read((s) => ({
      state: { runs: s.runs, tokens: s.tokens },
      prior: [...s.runs.values()].filter((r) => r.run_id !== runId).map(toPriorRun),
      tokens: new Map(s.tokens),
      run: s.runs.get(runId)!,
    }));
    let engine: EngineResult;
    try {
      engine = await evaluate({
      extraction: attempt.extraction,
      document: {
        source: snap.run.source, sender_email: snap.run.sender_email, uploader_display_name: snap.run.uploader_display_name,
        reply_token: snap.run.reply_token, text_layer: doc.text_layer, has_text_layer: doc.has_text_layer, g1_bypassed: snap.run.g1_bypassed,
        sender_authenticated: snap.run.sender_authenticated ?? null,
      },
      reference: deps.reference, priorRuns: snap.prior, tokens: snap.tokens, today: deps.today(), proposer: deps.proposer,
    });
    } catch (e) {
      // The evaluation itself could not finish (for example the AI line proposal was unreachable): row 3, retryable.
      const message = e instanceof Error ? e.message : String(e);
      return deps.store.transaction((tx) => {
        const run = tx.runs.get(runId)!;
        if (run.state !== "PROCESSING") return run;
        run.failure = `PROCESSING_ERROR: ${message}`;
        run.primary_reason = "PROCESSING_ERROR";
        transition(tx, run, 3, "FAILED", { actor: "system", at: deps.now(), code: "PROCESSING_ERROR", details: { error: message } });
        return run;
      });
    }
    const fp = fingerprint(snap.state, runId, engine);
    const committed = await deps.store.transaction((tx) => {
      const run = tx.runs.get(runId)!;
      if (run.state !== "PROCESSING") return run; // failed by the sweep meanwhile: this late result is discarded
      if (fingerprint(tx, runId, engine) !== fp) return null;
      run.extraction = attempt.extraction;
      run.extracted_by = { extractor: attempt.label, attempts: attempt.attempts, cached: attempt.cached ?? false };
      applyDecision(tx, run, engine, deps.now());
      return run;
    });
    if (committed) return committed;
  }
  // Liveness guard: never leave a run in PROCESSING. Row 3 with the reason; a reviewer can retry (row 4).
  return deps.store.transaction((tx) => {
    const run = tx.runs.get(runId)!;
    if (run.state !== "PROCESSING") return run;
    run.failure = `PROCESSING_ERROR: related invoices kept changing during ${MAX_REEVALUATIONS} evaluations; retry to decide`;
    run.primary_reason = "PROCESSING_ERROR";
    transition(tx, run, 3, "FAILED", { actor: "system", at: deps.now(), code: "PROCESSING_ERROR", details: { reason: "re-evaluation limit", attempts: MAX_REEVALUATIONS } });
    return run;
  });
}

/**
 * Stage 0 outcomes without a readable document (spec 3 row 0): no attachment, unsupported type or over 4 MB
 * (SKIPPED via rows 1 and 2), or an attachment that could not be fetched after 3 attempts (FAILED via rows 1
 * and 3). The run is recorded either way, so it appears in the history with its reason.
 */
export async function receiveUnreadable(
  deps: PipelineDeps,
  doc: Omit<IncomingDocument, "text_layer" | "has_text_layer" | "bytes" | "content_type" | "filename"> & { filename: string | null; content_type: string | null; size_bytes: number | null },
  code: "NO_ATTACHMENT" | "UNSUPPORTED_FILE" | "ATTACHMENT_FETCH_FAILED",
  reason: string,
): Promise<RunRecord> {
  return deps.store.transaction((tx) => {
    const at = deps.now();
    if (doc.source === "email" && doc.provider_email_id) {
      const key = deliveryKey(doc.provider_email_id, doc.attachment_id ?? "none");
      if (tx.deliveries.has(key)) {
        const existing = [...tx.runs.values()].find((r) => r.provider_email_id === doc.provider_email_id && r.attachment_id === doc.attachment_id)!;
        pushEvent(tx, { run_id: existing.run_id, type: "DELIVERY_REPEAT_IGNORED", actor: "system", at, details: { key } });
        return existing;
      }
      tx.deliveries.add(key);
    }
    const run: RunRecord = {
      run_id: deps.newId(), ref: deps.newRef(tx), state: "RECEIVED", version: 1, source: doc.source,
      sender_email: doc.sender_email, uploader_display_name: doc.uploader_display_name,
      provider_email_id: doc.provider_email_id, attachment_id: doc.attachment_id, filename: doc.filename,
      subject: doc.subject, reply_token: doc.reply_token, has_text_layer: false, g1_bypassed: false,
      extraction: null, extracted_by: null, engine: null, vendor_id: null, chain_key: null, invoice_number_norm: null, invoice_date: null,
      total_paise: null, po_number: null, blocking_codes: [], info_codes: [], primary_reason: code, consumption: [],
      due_date: null, exported: false, export_id: null, export_blocked: false, export_block_reason: null,
      supersedes_run_ids: [], superseded_by_run_id: null, failure: reason, created_at: at, updated_at: at,
    };
    tx.runs.set(run.run_id, run);
    pushEvent(tx, { run_id: run.run_id, type: "RUN_RECEIVED", actor: "system", at, details: { source: doc.source, filename: doc.filename, content_type: doc.content_type, size_bytes: doc.size_bytes, sender: doc.sender_email, uploader: doc.uploader_display_name } });
    transition(tx, run, 1, "PROCESSING", { actor: "system", at });
    if (code === "ATTACHMENT_FETCH_FAILED") {
      transition(tx, run, 3, "FAILED", { actor: "system", at, code, details: { reason } });
    } else {
      transition(tx, run, 2, "SKIPPED", { actor: "system", at, code, details: { reason } });
      pushEvent(tx, { run_id: run.run_id, type: "DECIDED", actor: "system", at, details: { outcome: "SKIPPED", code, reason } });
    }
    return run;
  });
}

/**
 * Row 3 for runs whose processing was interrupted (for example a serverless function stopped mid-extraction or
 * before it started): a run still RECEIVED or PROCESSING after `olderThanMs` is FAILED with PROCESSING_ERROR, so a
 * reviewer can retry it (row 4). A late result for such a run is then discarded (see processRun).
 */
export async function failStuckRuns(deps: PipelineDeps, olderThanMs: number): Promise<string[]> {
  const nowMs = Date.parse(deps.now());
  const stale = (r: RunRecord) => (r.state === "PROCESSING" || r.state === "RECEIVED") && nowMs - Date.parse(r.updated_at) > olderThanMs;
  const stuck = await deps.store.read((s) => [...s.runs.values()].filter(stale).map((r) => r.run_id));
  if (!stuck.length) return [];
  return deps.store.transaction((tx) => {
    const done: string[] = [];
    for (const id of stuck) {
      const run = tx.runs.get(id)!;
      if (!stale(run)) continue;
      const at = deps.now();
      // A run that was recorded but never started (the function stopped first) goes through row 1, then row 3.
      if (run.state === "RECEIVED") transition(tx, run, 1, "PROCESSING", { actor: "system", at });
      run.failure = `PROCESSING_ERROR: processing stopped before a decision (no result after ${Math.round(olderThanMs / 60_000)} minutes); retry to read it again`;
      run.primary_reason = "PROCESSING_ERROR";
      transition(tx, run, 3, "FAILED", { actor: "system", at, code: "PROCESSING_ERROR", details: { reason: "interrupted", waited_ms: olderThanMs } });
      done.push(id);
    }
    return done;
  });
}

/** Receive + process in one call (email adapter and upload both use this). A repeat delivery returns the existing run. */
export async function ingest(deps: PipelineDeps, doc: IncomingDocument): Promise<RunRecord> {
  const r = await receive(deps, doc);
  if (r.kind === "repeat") return deps.store.read((s) => s.runs.get(r.run_id)!);
  return processRun(deps, r.run_id);
}
