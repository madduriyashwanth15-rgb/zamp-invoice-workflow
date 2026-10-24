-- The Postgres schema as it was before demo workspaces (src/server/db/schema.ts at commit 457a65c, 23 Oct 2026),
-- copied verbatim for tests/workspaces.test.ts: the live database was created with it.
CREATE TABLE IF NOT EXISTS runs (
  pos         bigserial UNIQUE,
  run_id      text PRIMARY KEY,
  ref         text NOT NULL UNIQUE,
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
  bytes          bytea
);

CREATE TABLE IF NOT EXISTS reply_tokens (
  pos     bigserial UNIQUE,
  token   text PRIMARY KEY,
  run_id  text NOT NULL REFERENCES runs (run_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_key text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq     bigserial PRIMARY KEY,
  run_id  text,
  type    text NOT NULL,
  actor   text NOT NULL,
  at      timestamptz NOT NULL,
  data    jsonb NOT NULL
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
  data         jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  pos         bigserial UNIQUE,
  export_id   text PRIMARY KEY,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL,
  run_ids     text[] NOT NULL,
  data        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS correction_requests (
  id       bigserial PRIMARY KEY,
  run_id   text NOT NULL REFERENCES runs (run_id),
  token    text NOT NULL,
  sent_at  timestamptz NOT NULL,
  data     jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS extraction_cache (
  cache_key   text PRIMARY KEY,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
