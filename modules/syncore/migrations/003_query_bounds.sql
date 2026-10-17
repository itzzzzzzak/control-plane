-- Preserve the exact query associated with a paginated checkpoint.
-- The marker distinguishes legacy absence from a pinned full-run NULL boundary.
ALTER TABLE syncore_state ADD COLUMN IF NOT EXISTS run_since text;
ALTER TABLE syncore_state ADD COLUMN IF NOT EXISTS query_since_set boolean NOT NULL DEFAULT false;
