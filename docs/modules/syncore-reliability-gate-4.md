# SyncCore Reliability Gate 4: incremental query boundaries

Status: MERGED in [PR #4](https://github.com/itzzzzzzak/control-plane/pull/4), commit `31fcbd6974d13659d6a36a5a74932f5ad1d8528d`. [Final CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39028017716) passed 39 tests, zero skipped, Node 22/24 + PostgreSQL 17; author-side adversarial review recorded. Gate 3 merged in PR #3 after 35 real-database CI tests.

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

## Evidence and deployment review

- RED [CI 39027723129](https://github.com/itzzzzzzak/control-plane/actions/runs/39027723129)
  reproduced missing lookback/resume behavior in both stores and missing input bounds.
- Implementation `187331228ff4e2e4918e89e769d087f2fc89a731` passed
  [CI 39027835752](https://github.com/itzzzzzzak/control-plane/actions/runs/39027835752):
  Node 22 and 24, PostgreSQL 17, **39 tests passed, zero skipped**, clean dependency audit.
  Migration idempotency and populated legacy upgrade execute on PostgreSQL.
- No new dependencies, external endpoints, permissions or dynamic production SQL.
  Lookback bounds are validated before acquiring a lease; query metadata remains inside
  the existing fenced page transaction. Final documentation/refactor head requires CI.
- Deployment must stop/drain old workers, migrate, then start the new version. Do not
  mix old code that ignores `runSince` with unfinished new-format cursors. The migration
  preserves data but cannot make old engine code understand new query semantics.
- Source identity, field configuration and snapshot guarantees are the host/source
  adapter's responsibility. Events outside the configured lookback need reconciliation.
