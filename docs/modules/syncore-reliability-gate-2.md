# SyncCore Reliability Gate 2 — PostgreSQL durability RFC

Status: DESIGN + TEST PLAN ONLY. No PostgreSQL adapter is implemented. This branch must remain draft until green integration CI and security review.

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
- `syncore_state`: `sync_name PK`, `cursor text`, `max_seen timestamptz`, `watermark timestamptz` (precision/format conversion documented); `updated_at`.
- `syncore_rows`: `(sync_name, source_id)` PK, `data jsonb`, `base_hash text`, `source_modified_at timestamptz`, `deleted boolean`.
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
