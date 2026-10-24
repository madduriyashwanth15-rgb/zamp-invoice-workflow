// Postgres schema for the run store (plan phase D). Idempotent: safe to apply on every start and from `npm run db:setup`.
// Rows keep the domain record as JSONB in `data` plus a few plain columns for querying and inspection.
// `pos` preserves insertion order so iteration order matches the in-memory store exactly.

// Demo workspaces (25 Oct): every run row belongs to one workspace; rows from before are the shared inbox ('main').
// The migration is additive and idempotent, and does work (and takes table locks) only while something is missing:
// once applied, starting the app again locks nothing new. An unconditional ALTER on every start would deadlock with
// another instance's write (postgres.test.ts T16 runs exactly that race). It runs twice in SCHEMA_SQL:
//   first, before any other statement, so an existing database is migrated while this transaction holds no other
//     lock, taking the tables in the order a write transaction does (runs, documents, ... correction_requests);
//   last, for a new database, whose tables the CREATE statements have just made (indexes only).
const WORKSPACES_SQL = `DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['runs', 'documents', 'reply_tokens', 'deliveries', 'audit_events', 'approvals', 'exports', 'correction_requests'] LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', current_schema(), t)) IS NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'workspace') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN workspace text NOT NULL DEFAULT %L', t, 'main');
    END IF;
    IF t = 'runs' THEN
      -- References (A0001...) restart in every workspace: unique per workspace, no longer across the whole table.
      IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = current_schema() AND c.conname = 'runs_ref_key') THEN
        ALTER TABLE runs DROP CONSTRAINT runs_ref_key;
      END IF;
      IF to_regclass(format('%I.%I', current_schema(), 'runs_workspace_ref_key')) IS NULL THEN
        CREATE UNIQUE INDEX runs_workspace_ref_key ON runs (workspace, ref);
      END IF;
    END IF;
    IF to_regclass(format('%I.%I', current_schema(), t || '_workspace_idx')) IS NULL THEN
      EXECUTE format('CREATE INDEX %I ON %I (workspace)', t || '_workspace_idx', t);
    END IF;
  END LOOP;
END
$$;`;

export const SCHEMA_SQL = `
${WORKSPACES_SQL}

CREATE TABLE IF NOT EXISTS runs (
  pos         bigserial UNIQUE,
  run_id      text PRIMARY KEY,
  workspace   text NOT NULL DEFAULT 'main',
  ref         text NOT NULL,
  state       text NOT NULL,
  version     integer NOT NULL,
  source      text NOT NULL,
  vendor_id   text,
  chain_key   text,
  po_number   text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  data        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_state_idx ON runs (state);
CREATE INDEX IF NOT EXISTS runs_chain_idx ON runs (chain_key);

CREATE TABLE IF NOT EXISTS documents (
  pos            bigserial UNIQUE,
  run_id         text PRIMARY KEY REFERENCES runs (run_id),
  filename       text NOT NULL,
  content_type   text NOT NULL,
  size_bytes     integer NOT NULL,
  sha256         text,
  has_text_layer boolean NOT NULL,
  text_layer     text NOT NULL,
  body_text      text,
  bytes          bytea,
  workspace      text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS reply_tokens (
  pos     bigserial UNIQUE,
  token   text PRIMARY KEY,
  run_id  text NOT NULL REFERENCES runs (run_id),
  workspace text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_key text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  workspace    text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq     bigserial PRIMARY KEY,
  run_id  text,
  type    text NOT NULL,
  actor   text NOT NULL,
  at      timestamptz NOT NULL,
  data    jsonb NOT NULL,
  workspace text NOT NULL DEFAULT 'main'
);
CREATE INDEX IF NOT EXISTS audit_events_run_idx ON audit_events (run_id, seq);

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_no_change ON audit_events;
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TABLE IF NOT EXISTS approvals (
  id           bigserial PRIMARY KEY,
  run_id       text NOT NULL REFERENCES runs (run_id),
  approver     text NOT NULL,
  approved_at  timestamptz NOT NULL,
  mode         text NOT NULL,
  data         jsonb NOT NULL,
  workspace    text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS exports (
  pos         bigserial UNIQUE,
  export_id   text PRIMARY KEY,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  run_ids     text[] NOT NULL,
  data        jsonb NOT NULL,
  workspace   text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS correction_requests (
  id       bigserial PRIMARY KEY,
  run_id   text NOT NULL REFERENCES runs (run_id),
  token    text NOT NULL,
  sent_at  timestamptz NOT NULL,
  data     jsonb NOT NULL,
  workspace text NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS extraction_cache (
  cache_key   text PRIMARY KEY,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

${WORKSPACES_SQL}
`;

/**
 * Tables emptied by a reset of the shared inbox (TRUNCATE does not fire the append-only trigger). This empties every
 * workspace, sandboxes included. The extraction cache is kept. Listed in the order a write transaction takes them
 * (the TRUNCATE locks them in this order), so a reset and a sandbox's write, which hold different advisory locks,
 * wait for each other instead of deadlocking.
 */
export const RUN_TABLES = ["runs", "documents", "reply_tokens", "deliveries", "audit_events", "approvals", "exports", "correction_requests"];
