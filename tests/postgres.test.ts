import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { Extraction } from "@/domain/extraction-schema";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import type { StoreState } from "@/domain/runs/types";
import { ingest, type ExtractionAttempt, type Extractor, type ExtractorInput, type PipelineDeps } from "@/domain/runs/pipeline";
import { encode } from "@/server/db/codec";
import { PgRunStore } from "@/server/db/pg-store";
import { extractionOf, textFrom } from "./support/direct";
import { makeDeps, reference, runGolden } from "./support/harness";
import { freshPgStore, testPool } from "./support/pg";

// Postgres-specific checks (plan phase D). Needs TEST_DATABASE_URL (the test database); skipped otherwise.
// The whole suite also runs on Postgres with TEST_STORE=pg (golden 18/18, T1, T2, T9, T16 and the rest).

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const extraPools: Pool[] = [];
afterAll(async () => {
  for (const p of extraPools) await p.end();
});

/** MOCK extractor that waits for a gate, so two app instances evaluate at the same moment. */
class GatedExtractor implements Extractor {
  readonly label = "MOCK gated extractor";
  constructor(private docs: Map<string, Extraction>, private gate: Promise<void>) {}
  async extract(input: ExtractorInput): Promise<ExtractionAttempt> {
    await this.gate;
    return { status: "ok", extraction: structuredClone(this.docs.get(input.filename)!), attempts: 1, label: this.label };
  }
}

describe.skipIf(!enabled)("Postgres store", { timeout: 300_000 }, () => { // network round trips to Neon: see vitest.pg.config.mts
  it("golden run on Postgres equals the in-memory golden run, record for record", async () => {
    const mem = await runGolden({ storeFactory: () => new MemoryRunStore() });
    const pg = await runGolden({ storeFactory: () => freshPgStore() });
    expect(pg.map((e) => e.run.state)).toEqual(mem.map((e) => e.run.state));
    for (let i = 0; i < mem.length; i++) {
      expect(JSON.parse(encode(pg[i].run)), mem[i].test.test_id).toEqual(JSON.parse(encode(mem[i].run)));
      expect(pg[i].consumed).toEqual(mem[i].consumed);
    }
    const s1 = pg.find((e) => e.test.test_id === "S1")!;
    expect(typeof s1.run.total_paise).toBe("bigint");
  });

  it("T16 across two app instances (two connection pools): one invoice clears, the other holds", async () => {
    const shared = freshPgStore();
    await shared.ensureSchema();
    const schema = (shared as unknown as { schema: string }).schema;
    const second = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
    extraPools.push(second);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const docs = new Map<string, Extraction>();
    const a = extractionOf("S6a");
    const b = extractionOf("S6a");
    b.invoice_number = "BF-3399";
    b.invoice_date = "2026-10-11";
    docs.set("6a.pdf", a).set("6a-copy.pdf", b);
    let n = 0;
    const instance = (store: PgRunStore, tag: string): PipelineDeps => ({
      ...makeDeps(), store, extractor: new GatedExtractor(docs, gate), newId: () => `${tag}-${++n}`, newRef: () => `${tag.toUpperCase()}${n}`,
    });
    // Force the race: each instance takes its pre-decision snapshot, then waits until the other has taken its
    // snapshot too, so both evaluate before either commits. Only the commit-time re-check can then keep the PO honest.
    let arrived = 0;
    let release!: () => void;
    const bothSnapshotted = new Promise<void>((r) => (release = r));
    const racing = (store: PgRunStore): PgRunStore => {
      let first = true;
      return Object.assign(Object.create(store), {
        read: async <T,>(fn: (s: StoreState) => T) => {
          const out = await store.read(fn);
          if (first) {
            first = false;
            if (++arrived === 2) release();
            await bothSnapshotted;
          }
          return out;
        },
      });
    };
    const depsA = instance(racing(shared), "a");
    const depsB = instance(racing(new PgRunStore(second, schema)), "b");
    const send = (deps: PipelineDeps, name: string, e: Extraction) =>
      ingest(deps, {
        source: "email", sender_email: reference.vendors.find((v) => v.gstin === e.vendor_gstin)!.registered_senders[0], uploader_display_name: null, provider_email_id: `p-${name}`, attachment_id: "a-1",
        filename: name, content_type: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]), subject: null, reply_token: null,
        text_layer: textFrom(e), has_text_layer: true,
      });
    const both = Promise.all([send(depsA, "6a.pdf", a), send(depsB, "6a-copy.pdf", b)]);
    open();
    const runs = await both;
    expect(runs.map((r) => r.state).sort()).toEqual(["CLEARED", "ON_HOLD"]);
    expect(runs.find((r) => r.state === "ON_HOLD")!.blocking_codes.sort()).toEqual(["PO_AMOUNT_EXCEEDED", "QTY_EXCEEDS_PO"]);
  });

  it("a transaction that throws changes nothing (atomic)", async () => {
    const store = freshPgStore();
    const deps: PipelineDeps = { ...makeDeps(), store };
    const run = await ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "x.pdf", content_type: "application/pdf", bytes: new Uint8Array([1, 2, 3]), subject: null, reply_token: null, text_layer: "", has_text_layer: false,
    });
    const before = await store.read((s) => encode([...s.runs.values()]));
    const logsBefore = (await store.logs()).events.length;
    await expect(store.transaction((tx) => {
      tx.runs.get(run.run_id)!.state = "APPROVED";
      tx.events.push({ seq: 0, run_id: run.run_id, type: "NOTE", actor: "test", at: "2026-10-22T00:00:00Z" });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await store.read((s) => encode([...s.runs.values()]))).toBe(before);
    expect((await store.logs()).events.length).toBe(logsBefore);
    expect([...(await store.documentBytes(run.run_id))!]).toEqual([1, 2, 3]);
  });

  it("audit events are append-only in the database itself", async () => {
    const store = freshPgStore();
    const deps: PipelineDeps = { ...makeDeps(), store };
    await ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "y.pdf", content_type: "application/pdf", bytes: new Uint8Array([1]), subject: null, reply_token: null, text_layer: "", has_text_layer: false,
    });
    const schema = (store as unknown as { schema: string }).schema;
    await expect(testPool().query(`UPDATE "${schema}".audit_events SET actor = 'someone else'`)).rejects.toThrow(/append-only/);
    await expect(testPool().query(`DELETE FROM "${schema}".audit_events`)).rejects.toThrow(/append-only/);
  });

  it("batched writes: a changed document and late file bytes are written back; several events keep their order", async () => {
    const store = freshPgStore();
    const deps: PipelineDeps = { ...makeDeps(), store };
    const run = await ingest(deps, {
      source: "upload", sender_email: null, uploader_display_name: "Divya (AP)", provider_email_id: null, attachment_id: null,
      filename: "z.pdf", content_type: "application/pdf", bytes: new Uint8Array([9]), subject: null, reply_token: null, text_layer: "", has_text_layer: false,
    });
    const before = (await store.logs(run.run_id)).events.length;
    await store.transaction((tx) => {
      const d = tx.documents.get(run.run_id)!;
      tx.documents.set(run.run_id, { ...d, body_text: "it's a test: quotes ' and \\ backslash" });
      tx.newFiles.set(run.run_id, new Uint8Array([4, 5, 6]));
      for (const actor of ["first", "second", "third"]) tx.events.push({ seq: 0, run_id: run.run_id, type: "NOTE", actor, at: "2026-10-22T00:00:00Z" });
    });
    expect(await store.read((s) => s.documents.get(run.run_id)!.body_text)).toBe("it's a test: quotes ' and \\ backslash");
    expect([...(await store.documentBytes(run.run_id))!]).toEqual([4, 5, 6]);
    const events = (await store.logs(run.run_id)).events;
    expect(events.slice(before).map((e) => e.actor)).toEqual(["first", "second", "third"]);
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });
});
