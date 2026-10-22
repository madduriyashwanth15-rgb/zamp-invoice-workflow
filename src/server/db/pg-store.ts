import type { Pool, PoolClient, QueryResult } from "pg";
import { assertSync } from "@/domain/runs/memory-store";
import type { Approval, AuditEvent, CorrectionRequest, ExportRecord, Logs, RunRecord, RunStore, StoreState, StoredDocument } from "@/domain/runs/types";
import { decode, encode } from "./codec";
import { RUN_TABLES, SCHEMA_SQL } from "./schema";

// Postgres implementation of the store port (plan phase D, spec A11).
//
// Every write transaction takes one transaction-scoped advisory lock before reading, so write transactions on the
// same schema are serialised across all app instances. That is the PO and chain locks of A11 taken as a single
// lock: stricter than needed, simplest to prove, and cheap at this volume (a transaction holds it for a few round
// trips: extraction and AI calls happen between transactions, never inside one). The lock key includes the schema,
// so separate schemas (each test's fresh database) never wait for each other. Stage 8-9 commits still re-check the
// fingerprint, so a decision evaluated on stale state is re-evaluated (T16).
//
// A transaction loads the current state (runs, documents without bytes, tokens, deliveries), runs the domain
// function on it, then writes back only what changed plus the new log entries.
//
// Round trips matter more than query cost here (Neon from India is about 50-80 ms away; measured 22 Oct): opening
// the transaction, taking the lock and loading the state go in one round trip, writes are one statement per table
// that changed, and a read is a single round trip including its COMMIT.

const WRITE_LOCK = 731_001;
const SCHEMA_LOCK = 731_000;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Stable 32-bit key for a schema name (FNV-1a), used as the second half of the advisory lock keys. */
function schemaKey(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h | 0;
}

const LOAD_SQL = [
  "SELECT run_id, data::text AS data FROM runs ORDER BY pos",
  "SELECT run_id, filename, content_type, size_bytes, sha256, has_text_layer, text_layer, body_text FROM documents ORDER BY pos",
  "SELECT token, run_id FROM reply_tokens ORDER BY pos",
  "SELECT delivery_key FROM deliveries",
];

/** Rows from a JSON array parameter, in array order (sequence values follow this order; checked on Postgres 16). */
const ROWS = "jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(v, ord)";

type Loaded = {
  state: StoreState;
  runs: Map<string, string>;
  documents: Map<string, string>;
  tokens: Map<string, string>;
  deliveries: Set<string>;
};

export class PgRunStore implements RunStore {
  private ready: Promise<void> | null = null;
  private lockKey: number;

  constructor(private pool: Pool, private schema = "public") {
    if (!IDENT.test(schema)) throw new Error(`invalid schema name ${schema}`);
    this.lockKey = schemaKey(schema);
  }

  /** Creates the schema and tables if they do not exist. Called lazily before the first query. One round trip. */
  ensureSchema(): Promise<void> {
    this.ready ??= this.withClient(async (c) => {
      try {
        await c.query(
          [
            "BEGIN",
            `SELECT pg_advisory_xact_lock(${SCHEMA_LOCK}, ${this.lockKey})`,
            `CREATE SCHEMA IF NOT EXISTS "${this.schema}"`,
            `SET LOCAL search_path TO "${this.schema}"`,
            SCHEMA_SQL,
            "COMMIT",
          ].join(";\n"),
        );
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        this.ready = null;
        throw e;
      }
    });
    return this.ready;
  }

  /** Empties every run table (demo reset, test setup). Keeps the extraction cache. */
  async reset(): Promise<void> {
    await this.inTx("write", [`TRUNCATE ${RUN_TABLES.join(", ")} RESTART IDENTITY CASCADE`], async () => undefined);
  }

  async transaction<T>(fn: (tx: StoreState) => T): Promise<T> {
    return this.inTx("write", LOAD_SQL, async (c, results) => {
      const loaded = this.toLoaded(results);
      const out = assertSync(fn(loaded.state));
      await this.write(c, loaded);
      return out;
    });
  }

  async read<T>(fn: (state: StoreState) => T): Promise<T> {
    const loaded = await this.inTx("read", LOAD_SQL, async (_c, results) => this.toLoaded(results));
    return assertSync(fn(loaded.state));
  }

  /** One statement, so one snapshot and one round trip. */
  async logs(runId?: string): Promise<Logs> {
    await this.ensureSchema();
    const s = `"${this.schema}"`;
    const byRun = "($1::text IS NULL OR run_id = $1)";
    const r = await this.pool.query<{ events: string; approvals: string; exports: string; corrections: string }>(
      `SELECT
         (SELECT coalesce(json_agg(json_build_object('seq', seq::text, 'data', data) ORDER BY seq), '[]') FROM ${s}.audit_events WHERE ${byRun})::text AS events,
         (SELECT coalesce(json_agg(data ORDER BY id), '[]') FROM ${s}.approvals WHERE ${byRun})::text AS approvals,
         (SELECT coalesce(json_agg(data ORDER BY pos), '[]') FROM ${s}.exports WHERE ($1::text IS NULL OR $1 = ANY(run_ids)))::text AS exports,
         (SELECT coalesce(json_agg(data ORDER BY id), '[]') FROM ${s}.correction_requests WHERE ${byRun})::text AS corrections`,
      [runId ?? null],
    );
    const row = r.rows[0];
    return {
      events: decode<{ seq: string; data: Omit<AuditEvent, "seq"> }[]>(row.events).map((e) => ({ ...e.data, seq: Number(e.seq) })),
      approvals: decode<Approval[]>(row.approvals),
      exports: decode<ExportRecord[]>(row.exports),
      corrections: decode<CorrectionRequest[]>(row.corrections),
    };
  }

  async documentBytes(runId: string): Promise<Uint8Array | null> {
    await this.ensureSchema();
    const r = await this.pool.query<{ bytes: Buffer | null }>(`SELECT bytes FROM "${this.schema}".documents WHERE run_id = $1`, [runId]);
    const b = r.rows[0]?.bytes;
    return b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : null;
  }

  // ---- internals ----

  private async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  /**
   * Opens the transaction, takes the lock (writes) and runs `sql` in one round trip. A read also commits in that
   * same round trip; a write commits after `fn` has written its changes.
   */
  private async inTx<T>(mode: "read" | "write", sql: string[], fn: (c: PoolClient, results: QueryResult[]) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    return this.withClient(async (c) => {
      const prelude = [
        mode === "read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
        `SET LOCAL search_path TO "${this.schema}"`,
        ...(mode === "write" ? [`SELECT pg_advisory_xact_lock(${WRITE_LOCK}, ${this.lockKey})`] : []),
      ];
      try {
        const res = (await c.query([...prelude, ...sql, ...(mode === "read" ? ["COMMIT"] : [])].join(";\n"))) as unknown as QueryResult | QueryResult[];
        const results = (Array.isArray(res) ? res : [res]).slice(prelude.length, prelude.length + sql.length);
        const out = await fn(c, results);
        if (mode === "write") await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  private toLoaded([runs, docs, toks, dels]: QueryResult[]): Loaded {
    const state: StoreState = {
      runs: new Map(), documents: new Map(), tokens: new Map(),
      deliveries: new Set((dels.rows as { delivery_key: string }[]).map((r) => r.delivery_key)),
      events: [], approvals: [], exports: [], corrections: [], newFiles: new Map(),
    };
    const loaded: Loaded = { state, runs: new Map(), documents: new Map(), tokens: new Map(), deliveries: new Set(state.deliveries) };
    for (const r of runs.rows as { run_id: string; data: string }[]) {
      const run = decode<RunRecord>(r.data);
      state.runs.set(r.run_id, run);
      loaded.runs.set(r.run_id, encode(run));
    }
    for (const d of docs.rows as StoredDocument[]) {
      state.documents.set(d.run_id, d);
      loaded.documents.set(d.run_id, encode(d));
    }
    for (const t of toks.rows as { token: string; run_id: string }[]) {
      state.tokens.set(t.token, t.run_id);
      loaded.tokens.set(t.token, t.run_id);
    }
    return loaded;
  }

  /** Writes what changed: one statement per table that has changes. */
  private async write(c: PoolClient, loaded: Loaded): Promise<void> {
    const s = loaded.state;
    for (const id of loaded.runs.keys()) if (!s.runs.has(id)) throw new Error(`store: runs are never deleted (${id})`);
    const batch = async (sql: string, rows: unknown[]) => {
      if (rows.length > 0) await c.query(sql, [JSON.stringify(rows)]);
    };

    const runs: unknown[] = [];
    for (const [id, run] of s.runs) {
      const enc = encode(run);
      if (loaded.runs.get(id) === enc) continue;
      runs.push({
        run_id: id, ref: run.ref, state: run.state, version: run.version, source: run.source, vendor_id: run.vendor_id,
        chain_key: run.chain_key, po_number: run.po_number, created_at: run.created_at, updated_at: run.updated_at, data: enc,
      });
    }
    await batch(
      `INSERT INTO runs (run_id, ref, state, version, source, vendor_id, chain_key, po_number, created_at, updated_at, data)
       SELECT v->>'run_id', v->>'ref', v->>'state', (v->>'version')::int, v->>'source', v->>'vendor_id', v->>'chain_key',
              v->>'po_number', (v->>'created_at')::timestamptz, (v->>'updated_at')::timestamptz, (v->>'data')::jsonb
       FROM ${ROWS} ORDER BY ord
       ON CONFLICT (run_id) DO UPDATE SET ref = EXCLUDED.ref, state = EXCLUDED.state, version = EXCLUDED.version,
         source = EXCLUDED.source, vendor_id = EXCLUDED.vendor_id, chain_key = EXCLUDED.chain_key, po_number = EXCLUDED.po_number,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, data = EXCLUDED.data`,
      runs,
    );

    const newDocs: unknown[] = [];
    const changedDocs: unknown[] = [];
    for (const [id, d] of s.documents) {
      const before = loaded.documents.get(id);
      const bytes = s.newFiles.get(id);
      if (before === encode(d) && !bytes) continue;
      const row = {
        run_id: id, filename: d.filename, content_type: d.content_type, size_bytes: d.size_bytes, sha256: d.sha256,
        has_text_layer: d.has_text_layer, text_layer: d.text_layer, body_text: d.body_text,
        ...(bytes ? { bytes: Buffer.from(bytes).toString("base64") } : {}),
      };
      (before === undefined ? newDocs : changedDocs).push(row);
    }
    await batch(
      `INSERT INTO documents (run_id, filename, content_type, size_bytes, sha256, has_text_layer, text_layer, body_text, bytes)
       SELECT v->>'run_id', v->>'filename', v->>'content_type', (v->>'size_bytes')::int, v->>'sha256', (v->>'has_text_layer')::boolean,
              v->>'text_layer', v->>'body_text', decode(v->>'bytes', 'base64')
       FROM ${ROWS} ORDER BY ord`,
      newDocs,
    );
    await batch(
      `UPDATE documents d SET filename = v->>'filename', content_type = v->>'content_type', size_bytes = (v->>'size_bytes')::int,
         sha256 = v->>'sha256', has_text_layer = (v->>'has_text_layer')::boolean, text_layer = v->>'text_layer', body_text = v->>'body_text',
         bytes = CASE WHEN v ? 'bytes' THEN decode(v->>'bytes', 'base64') ELSE d.bytes END
       FROM ${ROWS} WHERE d.run_id = v->>'run_id'`,
      changedDocs,
    );

    const tokens: unknown[] = [];
    for (const [token, runId] of s.tokens) if (loaded.tokens.get(token) !== runId) tokens.push({ token, run_id: runId });
    await batch(
      `INSERT INTO reply_tokens (token, run_id) SELECT v->>'token', v->>'run_id' FROM ${ROWS} ORDER BY ord
       ON CONFLICT (token) DO UPDATE SET run_id = EXCLUDED.run_id`,
      tokens,
    );

    const deliveries = [...s.deliveries].filter((k) => !loaded.deliveries.has(k));
    await batch(`INSERT INTO deliveries (delivery_key) SELECT v #>> '{}' FROM ${ROWS} ORDER BY ord ON CONFLICT DO NOTHING`, deliveries);

    await batch(
      `INSERT INTO audit_events (run_id, type, actor, at, data)
       SELECT v->>'run_id', v->>'type', v->>'actor', (v->>'at')::timestamptz, (v->>'data')::jsonb FROM ${ROWS} ORDER BY ord`,
      s.events.map((e) => {
        const { seq: _seq, ...rest } = e;
        void _seq;
        return { run_id: e.run_id, type: e.type, actor: e.actor, at: e.at, data: encode(rest) };
      }),
    );
    await batch(
      `INSERT INTO approvals (run_id, approver, approved_at, mode, data)
       SELECT v->>'run_id', v->>'approver', (v->>'approved_at')::timestamptz, v->>'mode', (v->>'data')::jsonb FROM ${ROWS} ORDER BY ord`,
      s.approvals.map((a) => ({ run_id: a.run_id, approver: a.approver_display_name, approved_at: a.approved_at, mode: a.mode, data: encode(a) })),
    );
    await batch(
      `INSERT INTO exports (export_id, created_by, created_at, run_ids, data)
       SELECT v->>'export_id', v->>'created_by', (v->>'created_at')::timestamptz, ARRAY(SELECT jsonb_array_elements_text(v->'run_ids')), (v->>'data')::jsonb
       FROM ${ROWS} ORDER BY ord`,
      s.exports.map((x) => ({ export_id: x.export_id, created_by: x.created_by_display_name, created_at: x.created_at, run_ids: x.run_ids, data: encode(x) })),
    );
    await batch(
      `INSERT INTO correction_requests (run_id, token, sent_at, data)
       SELECT v->>'run_id', v->>'token', (v->>'sent_at')::timestamptz, (v->>'data')::jsonb FROM ${ROWS} ORDER BY ord`,
      s.corrections.map((r) => ({ run_id: r.run_id, token: r.token, sent_at: r.sent_at, data: encode(r) })),
    );
  }
}
