# SyncCore Reliability Gate 4: incremental query boundaries

Status: RED CONTRACT. Gate 3 merged in PR #3 after 35 real-database CI tests.

## Contract

- New incremental runs query inclusively from `watermark - lookbackMs`. Default:
  60 seconds. Configurable integer range: 0 to 24 hours. Full initial runs use null.
- Lookback is a bounded late-arrival policy, not a promise to find arbitrarily old
  updates. Reconciliation is still required outside the window. Source adapters must
  implement inclusive timestamps and stable pagination for the supplied query.
- A partial run persists its exact `runSince` with its cursor, rows and checkpoint.
  Changing lookback configuration between workers must not change a resumed query.
- On completion, clear the pinned boundary. Keep the watermark monotonic using the
  previous durable watermark, not the earlier lookback boundary.
- Existing pre-migration checkpoints resume with their original watermark as `since`.
  A marker distinguishes a deliberately persisted null boundary (full initial run)
  from legacy absence. No cursor is reset by migration.
- Reject invalid lookbacks before acquiring ownership or contacting a source.

## Storage

Add numbered migration 003: nullable `run_since text`, plus
`query_since_set boolean NOT NULL DEFAULT false`. The marker preserves compatibility
with legacy checkpoints and distinguishes a pinned full-run null. Async store writes
and reads preserve presence/absence of `SyncState.runSince`; completed states omit it.
Migration must be idempotent and CI must apply it before database tests.

## Verification

Shared memory/PostgreSQL tests: inclusive equal-watermark delivery, late unseen rows
inside the window, stale deliveries without watermark regression, resume after a
source failure/pool restart and changed configuration, legacy checkpoints, deliberate
full-run null, clearing pinned bounds, configuration limits and all prior crash gates.
Real PostgreSQL tests inspect the persisted columns; no mock DB result counts.
