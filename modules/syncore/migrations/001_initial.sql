-- SyncCore Gate 2, migration 001: persistent per-sync data and fencing state.
-- Apply under a migration lock; do not drop leases on restart.
CREATE TABLE IF NOT EXISTS syncore_leases (
  sync_name text PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  token uuid,
  expires_at timestamptz,
  CHECK ((token IS NULL) = (expires_at IS NULL))
);

CREATE TABLE IF NOT EXISTS syncore_state (
  sync_name text PRIMARY KEY,
  cursor text,
  max_seen text,
  watermark text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS syncore_rows (
  sync_name text NOT NULL,
  source_id text NOT NULL,
  data jsonb NOT NULL,
  base_hash char(64) NOT NULL,
  source_modified_at text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (sync_name, source_id)
);

CREATE TABLE IF NOT EXISTS syncore_conflicts (
  id uuid PRIMARY KEY,
  sync_name text NOT NULL,
  source_id text NOT NULL,
  overwritten jsonb NOT NULL,
  applied jsonb NOT NULL,
  resolution text NOT NULL CHECK (resolution = 'source-wins'),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS syncore_conflicts_sync_idx ON syncore_conflicts(sync_name, occurred_at);

CREATE TABLE IF NOT EXISTS syncore_dead_letters (
  id uuid PRIMARY KEY,
  sync_name text NOT NULL,
  raw jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS syncore_dead_letters_open_idx
  ON syncore_dead_letters(sync_name, created_at) WHERE resolved_at IS NULL;
