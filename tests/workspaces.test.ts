import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { markCorrectionSent } from "@/domain/runs/actions";
import { MemoryRunStore } from "@/domain/runs/memory-store";
import type { PipelineDeps } from "@/domain/runs/pipeline";
import { nextRef } from "@/domain/runs/queries";
import { approve, exportApproved } from "@/domain/runs/review";
import type { RunRecord, RunStore } from "@/domain/runs/types";
import type { loadEmail } from "@/fixtures/load";
import { encode } from "@/server/db/codec";
import { PgRunStore } from "@/server/db/pg-store";
import { SCHEMA_SQL } from "@/server/db/schema";
import { MAIN, newSandbox, type Workspace } from "@/server/workspace-id";
import { deliver, makeDeps } from "./support/harness";
import { freshPgSchema, testPool } from "./support/pg";

// Demo workspaces (25 Oct): every visitor works in a private sandbox; the shared inbox ("main") keeps real email.
// One database holds every workspace, so these checks run on both stores: in memory (a store per workspace, as the
// runtime does) and on Postgres (one schema, a store bound to each workspace's rows), when TEST_DATABASE_URL is set.

const pgEnabled = Boolean(process.env.TEST_DATABASE_URL);

interface Backend {
  name: string;
  /** One database; returns the store of a workspace in it. */
  open: () => { storeOf: (ws: Workspace) => RunStore; schema: string | null };
}

const backends: Backend[] = [
  {
    name: "in-memory",
    open: () => {
      const stores = new Map<Workspace, RunStore>();
      return {
        schema: null,
        storeOf: (ws) => {
          let s = stores.get(ws);
          if (!s) stores.set(ws, (s = new MemoryRunStore()));
          return s;
        },
      };
    },
  },
  ...(pgEnabled
    ? [{ name: "Postgres", open: () => { const schema = freshPgSchema(); return { schema, storeOf: (ws: Workspace) => new PgRunStore(testPool(), schema, ws) }; } }]
    : []),
];

/**
 * The deps of one workspace, as the app builds them: its own store, references from that store (nextRef), and run
 * ids unique across the database (the app uses UUIDs; here a per-workspace tag). `seed` fixes the reply-token seed
 * so two workspaces can be made to issue the very same token text.
 */
function depsIn(storeOf: (ws: Workspace) => RunStore, ws: Workspace, seed?: string): PipelineDeps {
  let n = 0;
  const tag = ws === MAIN ? "main" : ws.slice(3, 9);
  return { ...makeDeps({ storeFactory: () => storeOf(ws) }), newId: () => `${tag}-${++n}`, newRef: nextRef, ...(seed ? { newSecret: () => seed } : {}) };
}

const runsOf = (d: PipelineDeps) => d.store.read((s) => [...s.runs.values()]);
const withNewEmailId = (suffix: string) => ({
  emailOverride: (_t: string, e: ReturnType<typeof loadEmail>) => ({ ...e, provider_email_id: `${e.provider_email_id}-${suffix}` }),
});

describe.each(backends)("demo workspaces ($name store)", { timeout: 300_000 }, (backend) => {
  it("each workspace sees only its own runs, documents, history, exports and reply tokens", async () => {
    const { storeOf } = backend.open();
    const [a, b] = [newSandbox(), newSandbox()];
    const A = depsIn(storeOf, a);
    const B = depsIn(storeOf, b);
    const M = depsIn(storeOf, MAIN);

    const s1 = await deliver(A, "S1", {});
    expect(s1.state).toBe("CLEARED");
    expect((await approve(A, [s1.run_id], { actor: "Divya (AP)" })).ok).toBe(true);
    const x = await exportApproved(A, { actor: "Ravi (Finance)" });
    expect(x.ok).toBe(true);
    const s3 = await deliver(A, "S3", {});
    const { token } = await markCorrectionSent(A, s3.run_id, "Divya (AP)", "marked sent manually");
    const s6a = await deliver(M, "S6a", {});

    // A: its two runs, their documents, the token, the export and their history.
    expect((await runsOf(A)).map((r) => r.run_id).sort()).toEqual([s1.run_id, s3.run_id].sort());
    expect(await A.store.read((s) => [s.documents.size, [...s.tokens], s.deliveries.size])).toEqual([2, [[token, s3.run_id]], 2]);
    const logsA = await A.store.logs();
    expect(logsA.exports.map((e) => e.run_ids)).toEqual([[s1.run_id]]);
    expect(logsA.approvals.map((p) => p.run_id)).toEqual([s1.run_id]);
    expect(logsA.corrections.map((c) => c.token)).toEqual([token]);
    expect(new Set(logsA.events.map((e) => e.run_id))).toEqual(new Set([s1.run_id, s3.run_id]));
    expect(await A.store.documentBytes(s1.run_id)).not.toBeNull();

    // B sees nothing at all, not even by asking for A's run id.
    expect(await B.store.read((s) => [s.runs.size, s.documents.size, s.tokens.size, s.deliveries.size])).toEqual([0, 0, 0, 0]);
    expect(await B.store.logs()).toEqual({ events: [], approvals: [], exports: [], corrections: [] });
    expect(await B.store.logs(s1.run_id)).toEqual({ events: [], approvals: [], exports: [], corrections: [] });
    expect(await B.store.documentBytes(s1.run_id)).toBeNull();

    // The shared inbox sees only its own run.
    expect((await runsOf(M)).map((r) => r.run_id)).toEqual([s6a.run_id]);
    const logsM = await M.store.logs();
    expect(logsM.exports).toEqual([]);
    expect(new Set(logsM.events.map((e) => e.run_id))).toEqual(new Set([s6a.run_id]));
    expect(await M.store.documentBytes(s1.run_id)).toBeNull();
  });

  it("the same recorded email creates a run in each workspace; a repeat in the same workspace is ignored", async () => {
    const { storeOf } = backend.open();
    const [a, b] = [newSandbox(), newSandbox()];
    const A = depsIn(storeOf, a);
    const B = depsIn(storeOf, b);
    const first = await deliver(A, "S1", {});
    const again = await deliver(A, "S1", {}); // same provider email id and attachment: the same delivery
    expect(again.run_id).toBe(first.run_id);
    expect((await runsOf(A)).length).toBe(1);
    const inB = await deliver(B, "S1", {});
    expect(inB.run_id).not.toBe(first.run_id);
    expect(inB.state).toBe("CLEARED");
    expect((await deliver(B, "S1", {})).run_id).toBe(inB.run_id);
    expect((await runsOf(B)).length).toBe(1);
    expect((await runsOf(depsIn(storeOf, MAIN))).length).toBe(0);
  });

  it("references restart in every workspace (A0001 in each)", async () => {
    const { storeOf } = backend.open();
    const [a, b] = [newSandbox(), newSandbox()];
    const A = depsIn(storeOf, a);
    const B = depsIn(storeOf, b);
    const M = depsIn(storeOf, MAIN);
    expect((await deliver(A, "S1", {})).ref).toBe("A0001");
    expect((await deliver(B, "S3", {})).ref).toBe("A0001");
    expect((await deliver(M, "S6a", {})).ref).toBe("A0001");
    expect((await deliver(A, "S6a", {})).ref).toBe("A0002");
    expect((await runsOf(A)).map((r) => r.ref).sort()).toEqual(["A0001", "A0002"]);
  });

  it("the duplicate rule looks only inside the workspace", async () => {
    const { storeOf } = backend.open();
    const [a, b] = [newSandbox(), newSandbox()];
    const A = depsIn(storeOf, a);
    const B = depsIn(storeOf, b);
    await deliver(A, "S1", {});
    const dup = await deliver(A, "S5", {});
    expect(dup.state).toBe("REJECTED");
    expect(dup.blocking_codes).toEqual(["DUPLICATE_INVOICE"]);
    // B has never seen S1, so the same invoice is not a duplicate there.
    const alone = await deliver(B, "S5", {});
    expect(alone.blocking_codes).not.toContain("DUPLICATE_INVOICE");
    expect(alone.state).toBe("CLEARED");
    // Sending S1 itself again (a new email) in A is a duplicate too; in the shared inbox it is new.
    expect((await deliver(A, "S1", {}, withNewEmailId("again"))).blocking_codes).toEqual(["DUPLICATE_INVOICE"]);
    expect((await deliver(depsIn(storeOf, MAIN), "S1", {}, withNewEmailId("again"))).state).toBe("CLEARED");
  });

  it("PO consumption counts only the workspace's own invoices", async () => {
    const { storeOf } = backend.open();
    const [a, b] = [newSandbox(), newSandbox()];
    const A = depsIn(storeOf, a);
    const B = depsIn(storeOf, b);
    expect((await deliver(A, "S6a", {})).state).toBe("CLEARED");
    const second = await deliver(A, "S6b", {});
    expect(second.state).toBe("ON_HOLD");
    expect([...second.blocking_codes].sort()).toEqual(["PO_AMOUNT_EXCEEDED", "QTY_EXCEEDS_PO"]);
    // In B the PO is untouched, so the same second delivery is not over it.
    const inB = await deliver(B, "S6b", {});
    expect(inB.blocking_codes).not.toContain("QTY_EXCEEDS_PO");
    expect(inB.blocking_codes).not.toContain("PO_AMOUNT_EXCEEDED");
  });

  it("a reply token links only inside the workspace that issued it, even when two workspaces issue the same text", async () => {
    const { storeOf } = backend.open();
    const [a, b, c] = [newSandbox(), newSandbox(), newSandbox()];
    // Same reference (A0001) and the same seed: both workspaces issue the very same token text.
    const A = depsIn(storeOf, a, "fixed-seed");
    const B = depsIn(storeOf, b, "fixed-seed");
    const C = depsIn(storeOf, c, "fixed-seed");
    const s3a = await deliver(A, "S3", {});
    const s3b = await deliver(B, "S3", {});
    const ta = (await markCorrectionSent(A, s3a.run_id, "Divya (AP)", "marked sent manually")).token;
    const tb = (await markCorrectionSent(B, s3b.run_id, "Divya (AP)", "marked sent manually")).token;
    expect(tb).toBe(ta);
    expect(await A.store.read((s) => s.tokens.get(ta))).toBe(s3a.run_id);
    expect(await B.store.read((s) => s.tokens.get(tb))).toBe(s3b.run_id);

    const s4a = await deliver(A, "S4", { S3: ta });
    expect(s4a.state).toBe("CLEARED");
    expect(s4a.info_codes).toContain("CORRECTION_OF");
    const s4b = await deliver(B, "S4", { S3: tb });
    expect(s4b.info_codes).toContain("CORRECTION_OF");
    const s3After = async (d: PipelineDeps, id: string) => d.store.read((s) => s.runs.get(id) as RunRecord);
    expect(await s3After(A, s3a.run_id)).toMatchObject({ state: "SUPERSEDED", superseded_by_run_id: s4a.run_id });
    expect(await s3After(B, s3b.run_id)).toMatchObject({ state: "SUPERSEDED", superseded_by_run_id: s4b.run_id });

    // C never issued that token: the reply links to nothing there.
    const s4c = await deliver(C, "S4", { S3: ta });
    expect(s4c.info_codes).not.toContain("CORRECTION_OF");
  });
});

describe.skipIf(!pgEnabled)("demo workspaces: Postgres schema and keys", { timeout: 300_000 }, () => {
  const columns = async (schema: string) =>
    (await testPool().query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'workspace' ORDER BY table_name", [schema],
    )).rows.map((r) => r.table_name);
  const constraintsAndIndexes = async (schema: string) => ({
    refKey: (await testPool().query("SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND c.conname = 'runs_ref_key'", [schema])).rowCount,
    indexes: (await testPool().query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname LIKE '%workspace%' ORDER BY indexname", [schema])).rows.map((r) => r.indexname),
  });
  const TABLES = ["approvals", "audit_events", "correction_requests", "deliveries", "documents", "exports", "reply_tokens", "runs"];
  const INDEXES = [...TABLES.map((t) => `${t}_workspace_idx`), "runs_workspace_ref_key"].sort();
  const applySchema = (schema: string, sql: string) => testPool().query(`BEGIN; SET LOCAL search_path TO "${schema}"; ${sql}; COMMIT;`);

  it("a sandbox's delivery keys and reply tokens are stored with its id in front; the shared inbox's are not", async () => {
    const schema = freshPgSchema();
    const sb = newSandbox();
    const S = depsIn((ws) => new PgRunStore(testPool(), schema, ws), sb, "fixed-seed");
    const M = depsIn((ws) => new PgRunStore(testPool(), schema, ws), MAIN, "fixed-seed");
    for (const d of [S, M]) {
      const s3 = await deliver(d, "S3", {});
      await markCorrectionSent(d, s3.run_id, "Divya (AP)", "marked sent manually");
    }
    const rows = async (sql: string) => (await testPool().query<{ k: string; workspace: string }>(sql)).rows;
    const dels = await rows(`SELECT delivery_key AS k, workspace FROM "${schema}".deliveries ORDER BY workspace`);
    const toks = await rows(`SELECT token AS k, workspace FROM "${schema}".reply_tokens ORDER BY workspace`);
    expect(dels.map((r) => r.workspace)).toEqual(["main", sb]);
    expect(dels[1].k).toBe(`${sb}|${dels[0].k}`);
    expect(toks.map((r) => r.workspace)).toEqual(["main", sb]);
    expect(toks[1].k).toBe(`${sb}|${toks[0].k}`);
    expect(toks[0].k).toMatch(/^R-A0001[0-9A-Z]{4}$/);
  });

  it("the schema can be applied twice (and again on every start) without changing anything", async () => {
    const schema = freshPgSchema();
    await new PgRunStore(testPool(), schema).ensureSchema();
    expect(await columns(schema)).toEqual(TABLES);
    expect(await constraintsAndIndexes(schema)).toEqual({ refKey: 0, indexes: INDEXES });
    await applySchema(schema, SCHEMA_SQL);
    await applySchema(schema, SCHEMA_SQL);
    expect(await columns(schema)).toEqual(TABLES);
    expect(await constraintsAndIndexes(schema)).toEqual({ refKey: 0, indexes: INDEXES });
  });

  it("over the schema from before workspaces: old rows stay in the shared inbox and keep working", async () => {
    const schema = freshPgSchema();
    const pool = testPool();
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const before = readFileSync(fileURLToPath(new URL("./support/schema-before-workspaces.sql", import.meta.url)), "utf-8");
    await applySchema(schema, before);
    expect(await columns(schema)).toEqual([]);
    expect((await constraintsAndIndexes(schema)).refKey).toBe(1);

    // Rows as the code before workspaces wrote them: run S1 in memory, then insert with the old columns.
    const mem = { ...depsIn(() => new MemoryRunStore(), MAIN), newId: () => "before-1" };
    const old = await deliver(mem, "S1", {});
    const st = await mem.store.read((s) => ({ doc: s.documents.get(old.run_id)!, deliveries: [...s.deliveries] }));
    const bytes = await mem.store.documentBytes(old.run_id);
    const q = (sql: string, params: unknown[]) => pool.query(sql.replaceAll("{s}", `"${schema}"`), params);
    await q(
      `INSERT INTO {s}.runs (run_id, ref, state, version, source, vendor_id, chain_key, po_number, created_at, updated_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [old.run_id, old.ref, old.state, old.version, old.source, old.vendor_id, old.chain_key, old.po_number, old.created_at, old.updated_at, encode(old)],
    );
    const d = st.doc;
    await q(
      `INSERT INTO {s}.documents (run_id, filename, content_type, size_bytes, sha256, has_text_layer, text_layer, body_text, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [d.run_id, d.filename, d.content_type, d.size_bytes, d.sha256, d.has_text_layer, d.text_layer, d.body_text, bytes ? Buffer.from(bytes) : null],
    );
    for (const k of st.deliveries) await q("INSERT INTO {s}.deliveries (delivery_key) VALUES ($1)", [k]);
    await q("INSERT INTO {s}.reply_tokens (token, run_id) VALUES ($1, $2)", ["R-A0001OLD1", old.run_id]);
    await q("INSERT INTO {s}.audit_events (run_id, type, actor, at, data) VALUES ($1, 'RECEIVED', 'system', now(), '{}'::jsonb)", [old.run_id]);

    // The new code migrates on first use: the old rows are the shared inbox's.
    const M = depsIn((ws) => new PgRunStore(pool, schema, ws), MAIN);
    expect(await M.store.read((s) => [[...s.runs.keys()], s.documents.size, [...s.tokens], [...s.deliveries]])).toEqual([
      [old.run_id], 1, [["R-A0001OLD1", old.run_id]], st.deliveries,
    ]);
    expect(JSON.parse(encode((await M.store.read((s) => s.runs.get(old.run_id)))!))).toEqual(JSON.parse(encode(old)));
    expect(await M.store.documentBytes(old.run_id)).toEqual(bytes);
    expect((await M.store.logs(old.run_id)).events.length).toBe(1);
    expect(await columns(schema)).toEqual(TABLES);
    expect(await constraintsAndIndexes(schema)).toEqual({ refKey: 0, indexes: INDEXES });
    const rows = await pool.query<{ workspace: string }>(`SELECT DISTINCT workspace FROM "${schema}".runs`);
    expect(rows.rows).toEqual([{ workspace: "main" }]);

    // The old delivery is still recognised (no second run), the duplicate rule still sees the old invoice, and
    // references continue from it.
    expect((await deliver(M, "S1", {})).run_id).toBe(old.run_id);
    const dup = await deliver(M, "S5", {});
    expect(dup.blocking_codes).toEqual(["DUPLICATE_INVOICE"]);
    expect(dup.ref).toBe("A0002");
    // A sandbox starts empty, with its own A0001 (the old UNIQUE(ref) would have refused this row).
    const S = depsIn((ws) => new PgRunStore(pool, schema, ws), newSandbox());
    expect(await S.store.read((s) => s.runs.size)).toBe(0);
    const first = await deliver(S, "S1", {});
    expect(first.ref).toBe("A0001");
    expect(first.state).toBe("CLEARED");
  });
});
