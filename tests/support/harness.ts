import Decimal from "decimal.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MappingProposer, ReferenceData } from "@/domain/engine/types";
import { extractionSchema, type Extraction } from "@/domain/extraction-schema";
import { parseReplyToken, triageEmail } from "@/domain/intake/inbound-email";
import { markCorrectionSent } from "@/domain/runs/actions";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import { ingest, type Extractor, type PipelineDeps } from "@/domain/runs/pipeline";
import type { RunRecord, RunStore } from "@/domain/runs/types";
import { loadAnswerKey, loadEmail, loadReferenceData, TEST_DATA_DIR, type AnswerKeyTest } from "@/fixtures/load";
import { AnswerKeyExtractor, AnswerKeyProposer } from "@/server/extractor/answer-key-extractor";
import { readTextLayer } from "@/server/pdf-text";
import { freshPgStore, usePg } from "./pg";

// Golden-run harness (test matrix A13). MOCK: the extractor returns answer_key expected_extraction and the
// mapping proposer returns ai_mapping_ground_truth. Everything else is the real code path: InboundEmail
// adapter, token parsing, text layer from the real PDF, rule engine, state machine, store.

export const reference: ReferenceData = loadReferenceData();
export const answerKey = loadAnswerKey();
export const tests = new Map(answerKey.tests.map((t) => [t.test_id, t]));
const schema = extractionSchema(reference.settings);

export const parseExtraction = (raw: unknown): Extraction => schema.parse(raw);

type Mutator = (e: Extraction, testId: string) => Extraction;

// The MOCK extractor and proposer live in src/server/extractor/answer-key-extractor.ts (the app uses them too
// when no Gemini key is set); re-exported here for the tests.
export { AnswerKeyExtractor, AnswerKeyProposer };

export interface HarnessOptions {
  mutate?: Mutator;
  /** Store for each fresh "database" (default: in-memory, or Postgres with TEST_STORE=pg). */
  storeFactory?: () => RunStore;
  proposer?: MappingProposer | null;
  /** Default: the MOCK answer-key extractor. The live golden run passes the real Gemini extractor. */
  extractor?: Extractor;
  emailOverride?: (testId: string, email: ReturnType<typeof loadEmail>) => ReturnType<typeof loadEmail>;
}

export function makeDeps(opts: HarnessOptions = {}): PipelineDeps {
  let n = 0;
  let clock = Date.UTC(2026, 9, 22, 9, 0, 0);
  return {
    store: opts.storeFactory ? opts.storeFactory() : usePg ? freshPgStore() : new MemoryRunStore(),
    reference,
    today: () => "2026-10-22",
    now: () => new Date((clock += 1000)).toISOString(),
    newId: () => `run-${String(++n).padStart(3, "0")}`,
    newRef: () => `T${String(n).padStart(4, "0")}`,
    extractor: opts.extractor ?? new AnswerKeyExtractor(reference, opts.mutate),
    proposer: opts.proposer === undefined ? new AnswerKeyProposer() : opts.proposer,
    // Step timings (gap 16) on a stopped clock, so records stay deterministic like the ids and timestamps above;
    // tests/timing.test.ts measures with the real clock and a scripted one.
    clock: () => 0,
  };
}

/** Feed one recorded email through the adapter and the pipeline. */
export async function deliver(deps: PipelineDeps, testId: string, issued: Record<string, string>, opts: HarnessOptions = {}): Promise<RunRecord> {
  let email = loadEmail(testId, issued);
  if (opts.emailOverride) email = opts.emailOverride(testId, email);
  const att = email.attachments[0];
  const bytes = new Uint8Array(readFileSync(path.join(TEST_DATA_DIR, att.path)));
  const triage = triageEmail(email, [{ filename: att.filename, content_type: att.content_type, size_bytes: bytes.length }]);
  const accepted = triage.attachments.find((a) => a.kind === "accept");
  if (!accepted) throw new Error(`${testId}: attachment not accepted`);
  const text = await readTextLayer(bytes, att.content_type);
  return ingest(deps, {
    source: "email", sender_email: triage.sender, uploader_display_name: null,
    provider_email_id: email.provider_email_id, attachment_id: email.attachment_id, filename: att.filename,
    content_type: att.content_type, bytes, subject: email.subject, reply_token: parseReplyToken(email.subject, email.body_text),
    text_layer: text.text, has_text_layer: text.has_text_layer,
  });
}

export interface GoldenEntry {
  test: AnswerKeyTest;
  run: RunRecord;
  before: Record<string, string>;
  after: Record<string, string>;
  store: RunStore;
  byTest: Map<string, string>;
  /** Quantity consumed per PO (CLEARED and APPROVED runs) right after this test's run. */
  consumed: Record<string, string>;
}

const stateOf = (deps: PipelineDeps, byTest: Map<string, string>) =>
  deps.store.read((s) => Object.fromEntries([...byTest].map(([tid, rid]) => [tid, s.runs.get(rid)!.state])));

const consumedNow = (deps: PipelineDeps) =>
  deps.store.read((s) => {
    const q = new Map<string, Decimal>();
    for (const r of s.runs.values()) {
      if (r.state !== "CLEARED" && r.state !== "APPROVED") continue;
      for (const c of r.consumption) q.set(c.po_number, (q.get(c.po_number) ?? new Decimal(0)).plus(c.base_qty));
    }
    return Object.fromEntries(reference.purchaseOrders.map((p) => [p.po_number, (q.get(p.po_number) ?? new Decimal(0)).toString()]));
  });

/** Scenario sequence (one database) then isolated X tests (fresh database each), exactly as the matrix orders them. */
export async function runGolden(opts: HarnessOptions = {}): Promise<GoldenEntry[]> {
  const out: GoldenEntry[] = [];
  const seq = answerKey.tests.filter((t) => t.group === "scenario_sequence").sort((a, b) => (a.order as number) - (b.order as number));
  const deps = makeDeps(opts);
  const byTest = new Map<string, string>();
  const issued: Record<string, string> = {};
  for (const t of seq) {
    const before = await stateOf(deps, byTest);
    const run = await deliver(deps, t.test_id, issued, opts);
    byTest.set(t.test_id, run.run_id);
    out.push({ test: t, run, before, after: await stateOf(deps, byTest), store: deps.store, byTest: new Map(byTest), consumed: await consumedNow(deps) });
    if (t.after_run) issued[t.test_id] = (await markCorrectionSent(deps, run.run_id, "Golden harness (MOCK reviewer)")).token;
  }
  const iso = answerKey.tests.filter((t) => t.group === "isolated").sort((a, b) => (a.order as number) - (b.order as number));
  for (const t of iso) {
    const d = makeDeps(opts);
    const map = new Map<string, string>();
    const iss: Record<string, string> = {};
    const setup = (t.setup as string | null) ?? "";
    if (setup.includes("S3")) {
      const s3 = await deliver(d, "S3", {}, opts);
      map.set("S3", s3.run_id);
      if (setup.includes("correction email")) iss.S3 = (await markCorrectionSent(d, s3.run_id, "Golden harness (MOCK reviewer)")).token;
    }
    const before = await stateOf(d, map);
    const run = await deliver(d, t.test_id, iss, opts);
    map.set(t.test_id, run.run_id);
    out.push({ test: t, run, before, after: await stateOf(d, map), store: d.store, byTest: new Map(map), consumed: await consumedNow(d) });
  }
  return out;
}

/** Matrix pass rule: outcome equal, blocking codes exactly equal, expected info present, side effects observed. */
export function passRule(e: GoldenEntry): { pass: boolean; problems: string[] } {
  const exp = e.test.expected as unknown as {
    outcome: string; blocking: string[]; info: string[]; side_effects: string[]; due_date?: string; expected_po?: string; po_candidates_open?: string[];
  };
  const problems: string[] = [];
  const blocking = [...new Set(e.run.blocking_codes)].sort();
  if (e.run.state !== exp.outcome) problems.push(`outcome ${e.run.state} != ${exp.outcome}`);
  if (JSON.stringify(blocking) !== JSON.stringify([...exp.blocking].sort())) problems.push(`blocking ${blocking.join(",")} != ${exp.blocking.join(",")}`);
  for (const i of exp.info) if (!e.run.info_codes.includes(i as never)) problems.push(`missing info ${i}`);
  for (const se of exp.side_effects) {
    const [subj, cond] = [se.slice(0, se.indexOf(":")), se.slice(se.indexOf(":") + 1)];
    if (subj.startsWith("PO-")) {
      const want = cond.split("=")[1];
      const got = e.consumed[subj];
      if (got !== want) problems.push(`${se}: consumed ${got}`);
    } else if (cond.includes("->")) {
      const [a, b] = cond.split("->");
      if (e.before[subj] !== a || e.after[subj] !== b) problems.push(`${se}: ${e.before[subj]}->${e.after[subj]}`);
    } else if (cond.startsWith("not ")) {
      if (e.after[subj] === cond.slice(4)) problems.push(`${se}: is ${e.after[subj]}`);
    } else if (cond.startsWith("unchanged ")) {
      const st = cond.split(" ")[1];
      if (e.before[subj] !== st || e.after[subj] !== st) problems.push(`${se}: ${e.before[subj]}->${e.after[subj]}`);
    } else if (e.after[subj] !== cond) problems.push(`${se}: is ${e.after[subj]}`);
  }
  if (exp.due_date && e.run.due_date !== exp.due_date) problems.push(`due ${e.run.due_date} != ${exp.due_date}`);
  if (exp.expected_po && e.run.po_number !== exp.expected_po) problems.push(`PO ${e.run.po_number} != ${exp.expected_po}`);
  if (exp.po_candidates_open && JSON.stringify(e.run.engine?.po_candidates) !== JSON.stringify([...exp.po_candidates_open].sort())) {
    problems.push(`open POs considered ${e.run.engine?.po_candidates} != ${exp.po_candidates_open}`);
  }
  return { pass: problems.length === 0, problems };
}

export const oracle: { test_id: string; state: string; blocking: string[]; info: string[] }[] = JSON.parse(
  readFileSync(path.join(TEST_DATA_DIR, "oracle_results.json"), "utf-8"),
);

/**
 * The callback record a reviewer enters before overriding a bank, vendor or sender hold (spec v1.4 row 9), already
 * confirmed a second time. `phone` is the vendor-master number for a known vendor; any number for an unknown one.
 */
export function called(phone = "+91 98450 00000") {
  return { callback: { number_called: phone, spoke_to: "Ravi, accounts", called_at: "2026-10-22T08:30:00.000Z" }, confirmCallback: true };
}

export const masterPhone = (vendorId: string) => reference.vendors.find((v) => v.vendor_id === vendorId)!.phone;
