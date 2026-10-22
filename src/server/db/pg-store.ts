import type { Pool, PoolClient } from "pg";
import { assertSync } from "@/domain/runs/memory-store";
import type { Approval, AuditEvent, CorrectionRequest, ExportRecord, Logs, RunRecord, RunStore, StoreState, StoredDocument } from "@/domain/runs/types";
import { decode, encode } from "./codec";
import { RUN_TABLES, SCHEMA_SQL } from "./schema";

// Postgres implementation of the store port (plan phase D, spec A11).
//
// Every write transaction takes one transaction-scoped advisory lock before reading, so write transactions are
// serialised across all app instances. That is the PO and chain locks of A11 taken as a single lock: stricter than
// needed, simplest to prove, and cheap at this volume (a transaction holds it for milliseconds: extraction and AI
// calls happen between transactions, never inside one). Stage 8-9 commits still re-check the fingerprint, so a
// decision evaluated on stale state is re-evaluated (T16).
//
// A transaction loads the current state (runs, documents without bytes, tokens, deliveries), runs the domain
// function on it, then writes back only what changed plus the new log entries.

const WRITE_LOCK = 731_001;
const SCHEMA_LOCK = 731_000;
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

type Loaded = {
  state: StoreState;
  runs: Map<string, string>;
  documents: Map<string, string>;
  tokens: Map<string, string>;
  deliveries: Set<string>;
};

export class PgRunStore implements RunStore {
  private ready: Promise<void> | null = null;

  constructor(private pool: Pool, private schema = "public") {
    if (!IDENT.test(schema)) throw new Error(`invalid schema name ${schema}`);
  }

  /** Creates the schema and tables if they do not exist. Called lazily before the first query. */
  ensureSchema(): Promise<void> {
    this.ready ??= this.withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK]);
        await c.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
        await c.query(`SET LOCAL search_path TO "${this.schema}"`);
        await c.query(SCHEMA_SQL);
        await c.query("COMMIT");
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
    await this.inTx("write", (c) => c.query(`TRUNCATE ${RUN_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
  }

  async transaction<T>(fn: (tx: StoreState) => T): Promise<T> {
    return this.inTx("write", async (c) => {
      const loaded = await this.load(c);
      const out = assertSync(fn(loaded.state));
      await this.write(c, loaded);
      return out;
    });
  }

  async read<T>(fn: (state: StoreState) => T): Promise<T> {
    const loaded = await this.inTx("read", (c) => this.load(c));
    return assertSync(fn(loaded.state));
  }

  async logs(runId?: string): Promise<Logs> {
    return this.inTx("read", async (c) => {
      const byRun = runId ? " WHERE run_id = $1" : "";
      const args = runId ? [runId] : [];
      const ev = await c.query<{ seq: string; data: string }>(`SELECT seq, data::text AS data FROM audit_events${byRun} ORDER BY seq`, args);
      const ap = await c.query<{ data: string }>(`SELECT data::text AS data FROM approvals${byRun} ORDER BY id`, args);
      const ex = await c.query<{ data: string }>(`SELECT data::text AS data FROM exports${runId ? " WHERE $1 = ANY(run_ids)" : ""} ORDER BY pos`, args);
      const co = await c.query<{ data: string }>(`SELECT data::text AS data FROM correction_requests${byRun} ORDER BY id`, args);
      return {
        events: ev.rows.map((r) => ({ ...decode<Omit<AuditEvent, "seq">>(r.data), seq: Number(r.seq) })),
        approvals: ap.rows.map((r) => decode<Approval>(r.data)),
        exports: ex.rows.map((r) => decode<ExportRecord>(r.data)),
        corrections: co.rows.map((r) => decode<CorrectionRequest>(r.data)),
      };
    });
  }

  async documentBytes(runId: string): Promise<Uint8Array | null> {
    return this.inTx("read", async (c) => {
      const r = await c.query<{ bytes: Buffer | null }>("SELECT bytes FROM documents WHERE run_id = $1", [runId]);
      const b = r.rows[0]?.bytes;
      return b ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice() : null;
    });
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

  private async inTx<T>(mode: "read" | "write", fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    return this.withClient(async (c) => {
      await c.query(mode === "read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
      try {
        await c.query(`SET LOCAL search_path TO "${this.schema}"`);
        if (mode === "write") await c.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    });
  }

  private async load(c: PoolClient): Promise<Loaded> {
    const runs = await c.query<{ run_id: string; data: string }>("SELECT run_id, data::text AS data FROM runs ORDER BY pos");
    const docs = await c.query<StoredDocument>(
      "SELECT run_id, filename, content_type, size_bytes, sha256, has_text_layer, text_layer, body_text FROM documents ORDER BY pos",
    );
    const toks = await c.query<{ token: string; run_id: string }>("SELECT token, run_id FROM reply_tokens ORDER BY pos");
    const dels = await c.query<{ delivery_key: string }>("SELECT delivery_key FROM deliveries");
    const state: StoreState = {
      runs: new Map(), documents: new Map(), tokens: new Map(), deliveries: new Set(dels.rows.map((r) => r.delivery_key)),
      events: [], approvals: [], exports: [], corrections: [], newFiles: new Map(),
    };
    const loaded: Loaded = { state, runs: new Map(), documents: new Map(), tokens: new Map(), deliveries: new Set(state.deliveries) };
    for (const r of runs.rows) {
      const run = decode<RunRecord>(r.data);
      state.runs.set(r.run_id, run);
      loaded.runs.set(r.run_id, encode(run));
    }
    for (const d of docs.rows) {
      state.documents.set(d.run_id, d);
      loaded.documents.set(d.run_id, encode(d));
    }
    for (const t of toks.rows) {
      state.tokens.set(t.token, t.run_id);
      loaded.tokens.set(t.token, t.run_id);
    }
    return loaded;
  }

  private async write(c: PoolClient, loaded: Loaded): Promise<void> {
    const s = loaded.state;
    for (const id of loaded.runs.keys()) if (!s.runs.has(id)) throw new Error(`store: runs are never deleted (${id})`);
    for (const [id, run] of s.runs) {
      const enc = encode(run);
      const before = loaded.runs.get(id);
      if (before === enc) continue;
      const cols = [run.ref, run.state, run.version, run.source, run.vendor_id, run.chain_key, run.po_number, run.created_at, run.updated_at, enc];
      if (before === undefined) {
        await c.query(
          `INSERT INTO runs (run_id, ref, state, version, source, vendor_id, chain_key, po_number, created_at, updated_at, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
          [id, ...cols],
        );
      } else {
        await c.query(
          `UPDATE runs SET ref = $2, state = $3, version = $4, source = $5, vendor_id = $6, chain_key = $7, po_number = $8,
           created_at = $9, updated_at = $10, data = $11::jsonb WHERE run_id = $1`,
          [id, ...cols],
        );
      }
    }
    for (const [id, d] of s.documents) {
      const enc = encode(d);
      const before = loaded.documents.get(id);
      if (before === enc) continue;
      const cols = [d.filename, d.content_type, d.size_bytes, d.sha256, d.has_text_layer, d.text_layer, d.body_text];
      if (before === undefined) {
        const bytes = s.newFiles.get(id);
        await c.query(
          `INSERT INTO documents (run_id, filename, content_type, size_bytes, sha256, has_text_layer, text_layer, body_text, bytes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, ...cols, bytes ? Buffer.from(bytes) : null],
        );
      } else {
        await c.query(
          `UPDATE documents SET filename = $2, content_type = $3, size_bytes = $4, sha256 = $5, has_text_layer = $6, text_layer = $7, body_text = $8
           WHERE run_id = $1`,
          [id, ...cols],
        );
      }
    }
    for (const [id, bytes] of s.newFiles) {
      if (loaded.documents.has(id)) await c.query("UPDATE documents SET bytes = $2 WHERE run_id = $1", [id, Buffer.from(bytes)]);
    }
    for (const [token, runId] of s.tokens) {
      if (loaded.tokens.get(token) === runId) continue;
      await c.query("INSERT INTO reply_tokens (token, run_id) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET run_id = EXCLUDED.run_id", [token, runId]);
    }
    for (const key of s.deliveries) {
      if (loaded.deliveries.has(key)) continue;
      await c.query("INSERT INTO deliveries (delivery_key) VALUES ($1) ON CONFLICT DO NOTHING", [key]);
    }
    for (const e of s.events) {
      const { seq: _seq, ...rest } = e;
      void _seq;
      await c.query("INSERT INTO audit_events (run_id, type, actor, at, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [e.run_id, e.type, e.actor, e.at, encode(rest)]);
    }
    for (const a of s.approvals) {
      await c.query("INSERT INTO approvals (run_id, approver, approved_at, mode, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [a.run_id, a.approver_display_name, a.approved_at, a.mode, encode(a)]);
    }
    for (const x of s.exports) {
      await c.query("INSERT INTO exports (export_id, created_by, created_at, run_ids, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [x.export_id, x.created_by_display_name, x.created_at, x.run_ids, encode(x)]);
    }
    for (const r of s.corrections) {
      await c.query("INSERT INTO correction_requests (run_id, token, sent_at, data) VALUES ($1, $2, $3, $4::jsonb)", [r.run_id, r.token, r.sent_at, encode(r)]);
    }
  }
}
