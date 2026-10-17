# SyncCore Reliability Gate 2 — PostgreSQL durability RFC

Status: MERGED in [PR #2](https://github.com/itzzzzzzak/control-plane/pull/2), commit `6ca2471de71b17d54c1e65d3d8a2e7505c3d9a27`. Final-head CI and the adversarial review passed before merge. See [operations](syncore-postgres-operations.md) for setup and recovery. The original design and verification matrix follow; completion evidence is recorded below.

## Existing Gate 1 review (base 1eeb295)

- `SyncStore` is synchronous inside `transaction`: `getRow/putRow/addConflict/addDeadLetter/setState`. PostgreSQL calls are asynchronous. **Do not hide async DB calls behind these signatures**. Evolve `SyncTx` methods to async and await each in the engine, including replay.
- Memory store serializes by sync name in a single process; PostgreSQL must coordinate *across* processes.
- Runner renews only at the start of a page. Slow API fetch may outlast TTL. Add a bounded heartbeat with cancellation and fencing; transaction still checks ownership.
- `replayDeadLetters` applies data then separately removes positional entries. Crash can leave applied work in the queue. Use persistent UUID dead-letter IDs and resolve in the same DB transaction.
- `getState` is called under acquired ownership, but target writes must also enforce ownership inside DB.
- `release` must never undo a newer lease. `now()` injected in engine is for audit timestamps; lease authority is database clock, never local host clock.

## Storage model

All tables are module-owned, prefix `syncore_`, keyed by `sync_name` for multi-tenant isolation.

- `syncore_leases`: one row per sync, `epoch bigint` monotonically increases, `token uuid` nullable, `expires_at timestamptz` nullable. Never delete a lease row: retains fencing epoch after release/restart.
- `syncore_state`: `sync_name PK`, `cursor text`, `max_seen text`, `watermark text` (source timestamp strings are preserved exactly); `updated_at`.
- `syncore_rows`: `(sync_name, source_id)` PK, `data jsonb`, `base_hash text`, `source_modified_at text`, `deleted boolean`.
- `syncore_conflicts`: immutable `id uuid PK`, `sync_name`, `source_id`, `overwritten jsonb`, `applied jsonb`, `resolution`, `occurred_at`.
- `syncore_dead_letters`: immutable `id uuid PK`, `sync_name`, `raw jsonb`, `reason`, `created_at`, `resolved_at` nullable. Retain resolved entries for audit; enumerate only unresolved entries.

Reject arbitrary unbounded JSON payloads at API boundary; set DB connection and statement timeouts. Avoid credentials in logs. Migration runs as an explicit deploy step, not implicitly on every API request.

## Transaction/lease algorithms

**Acquire**: In a short DB transaction, insert lease row if absent; take `SELECT ... FOR UPDATE` on its sync row; compare expiry against PostgreSQL `clock_timestamp()` (not `now()` transaction-start time). If currently held and unexpired, return busy. Else atomically increment epoch and set random token + expiry. Commit. Do not use session locks requiring sticky connections.

**Renew**: atomic conditional update requiring matching `sync_name`, `token`, `epoch`, unexpired lease, returning new DB expiration. A renewal after expiry fails even if nobody has taken over. Keep epoch unchanged.

**Page transaction**: BEGIN; lock lease row `FOR UPDATE`; ensure token, epoch and expiry match using DB time; then read/modify rows + append conflicts/dead letters + advance checkpoint; verify DB lease expiry **again at commit boundary**; COMMIT. Any failure ROLLBACK. No API call while holding DB row lock. A stale owner cannot commit after lease takeover because lock serializes acquisition vs commit.

**Release**: conditional update matching owner and epoch, clear token/expiration but preserve monotonic epoch. Stale release is a no-op.

**Crash/restart**: DB transaction rolls back if process dies before commit. If commit succeeds but caller loses response, retry uses checkpoint and idempotent row upsert. Expired lease can be taken by another worker with larger epoch. Verify exactly *one committed page* semantics, not exactly-once delivery of external API events.

**Dead letters**: read unresolved stable IDs under lease; resolve each in same transaction as the replayed record update. Ensure validation failure leaves unresolved and that stale ownership cannot resolve anything.

**Heartbeat**: runner renews at TTL/3 while active, with one renewal in flight, bounded retries/timeouts, and cancellation on lost ownership. Prevent timer leaks on completion, error and cancellation. Avoid asserting the heartbeat makes remote API requests cancellable unless source supports AbortSignal. Expiration validation in page transaction is the ultimate fence.

## Deterministic integration test matrix (real PostgreSQL)

Test fresh database/schema per test worker or unique sync names with cleanup. Use two independent pools/processes where specified; avoid timing-only sleeps as the sole synchronization.

1. Migration idempotency, schema constraints, persistence after closing/reopening pool.
2. Two competing owners: only one acquisition succeeds for same sync across connections.
3. Distinct sync names proceed simultaneously.
4. Concurrent page writes + checkpoint: transaction all-or-nothing under an injected fault.
5. Stale worker after expiry and takeover: old token/epoch cannot write or release.
6. Renewal before expiry succeeds, after expiry fails; wrong token/epoch fails.
7. Restart with saved middle-page checkpoint and continuation without reapplying rows.
8. Unknown commit outcome (disconnect after COMMIT): replay is idempotent.
9. Dead-letter replay + mark resolved atomically; forced rollback preserves both.
10. Crash mid-transaction via terminated backend/process; new worker resumes after expiry.
11. Slow fetch longer than TTL: heartbeat retains ownership; if renewal fails, no commit.
12. Payload/SQL-injection resistance via parameters, sync name isolation, failed transaction recovery and connection pool exhaustion.

Integration CI must provision PostgreSQL and run all these tests; never count skipped DB tests as a passing durability gate.

## Implementation order

1. Commit this RFC and an executable **RED integration contract** (not green).
2. Introduce async transactional interface and update memory store/tests without regressing Gate 1.
3. Implement SQL migration + parameterized PostgresStore with fencing. Verify tests 1–10.
4. Add heartbeat and cancellation handling, tests 11–12.
5. Run CI on Node 22/24 against real PostgreSQL, inspect logs, conduct security review, then and only then make PR ready and consider merging.

## Non-goals

Not Zoho API adapter, bidirectional sync, event ordering/watermark redesign, UI, or workflow orchestration. Do not claim production readiness before multi-process recovery is validated.


## Implementation and evidence

- `postgres-store.ts`: parameterized `pg` adapter, explicit pool lifecycle, durable
  rows/state/conflicts/dead letters, transactional fences at entry and commit decision.
- Async `SyncTx` methods are awaited by the engine and both stores. Stable dead-letter
  IDs resolve in the same transaction as replay writes; storage errors propagate.
- `heartbeat.ts`: serialized renewal, terminal ownership loss, AbortSignal propagation,
  cancelled fetch waits and timer cleanup. Cleanup failure cannot replace a committed result.
- Connection checkout, query/lock/idle timeouts and callback deadlines bound failures;
  escaped transaction handles reject subsequent operations. Payload byte limits apply.
- First complete integration run: [CI 39026819792](https://github.com/itzzzzzzak/control-plane/actions/runs/39026819792),
  commit `3493b479488925dcd8bc03d57e42af5b3a27f186`, Node 22/24 + PostgreSQL 17,
  26 passing tests, zero skipped, dependency audit clean. This is evidence for that
  commit only; subsequent adversarial regressions require their own green run.
- Integration coverage includes independent processes competing for ownership, SIGKILL
  before commit, process death after commit before runner response, pool reopen and
  checkpoint resume, rollback of rows/state/dead letters, stale epochs/releases,
  sync-name isolation and SQL injection-shaped identifiers.
- Additional review regressions cover renewal blocked across expiry, a real DB heartbeat
  during slow fetch, independent sync transactions, payload limits, backend termination,
  pool exhaustion, callback deadlines and escaped transaction handles.

## Review scope and remaining limits

All database operations use bind parameters; function privileges are invoker-only.
No public API, credential broker, cross-user authorization or production Zoho integration
is introduced. Raw SQL credentials are trusted. Source revision ordering and late-event
watermark behavior remain the next independent gate. Audit-list pagination and deployment
telemetry remain operational work; do not expose unbounded list methods directly as a
public API. See the operations guide for deployment constraints and recovery semantics.

Final implementation evidence: [CI 39026963538](https://github.com/itzzzzzzak/control-plane/actions/runs/39026963538),
commit `c737bc892a7ffb3a965eec408f163d66e0bf3592`, passed Node 22 and 24 against
PostgreSQL 17: **32 tests passed, zero skipped, zero failed**. This includes all
additional adversarial regressions listed above. Both dependency audits reported no
known vulnerabilities. The final documentation commit must also pass exact-head CI.

Review findings corrected before merge: replay's split commit and swallowed storage
failures; renewal clock evaluation before lock acquisition; expired commit fencing;
leaked transaction handles; unbounded transaction callbacks and query waits; cleanup
errors replacing committed outcomes. No unresolved critical findings in Gate 2 scope.
