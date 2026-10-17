# SyncCore PostgreSQL operation

Gate 2 implements storage durability and worker coordination. The engine is a library;
there is no authenticated API server or live Zoho source yet.

## Install and migrate

Use Node 22 or 24, `pnpm install --frozen-lockfile`, and PostgreSQL 17 (CI version).
Run migrations using a deployment identity before starting workers. Only one migrator
may run at a time. Wrap both files in one transaction and a migration lock:

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SELECT pg_advisory_xact_lock(734938291);
\i modules/syncore/migrations/001_initial.sql
\i modules/syncore/migrations/002_lease_operations.sql
COMMIT;
SQL
```

The initial migration is idempotent, not a general migration version manager. Future
schema changes need new numbered migrations; do not edit an applied table definition
and expect `CREATE TABLE IF NOT EXISTS` to upgrade it. Lease rows are never deleted:
they retain their monotonic fencing epochs after release and restart. Back up all
`syncore_*` tables together; never restore an old lease table beneath active workers.

Use a separate runtime database identity with only CONNECT, schema USAGE, and required
SELECT/INSERT/UPDATE privileges on `syncore_*` tables plus EXECUTE on the lease
functions. It must not own the schema or have CREATE, DROP, TRUNCATE or superuser
rights. Remove CREATE from untrusted roles in the schema search path. Functions are
security-invoker; they do not elevate privileges. Use TLS with certificate verification
for remote databases. Keep connection strings in environment/secret configuration.

## Use

```ts
import { postgresStore, runSync } from './modules/syncore/index.js'

const store = postgresStore({ connectionString: process.env.DATABASE_URL }, {
  transactionTimeoutMs: 10_000,
  maxPayloadBytes: 1_048_576,
})
try {
  const result = await runSync({ name: 'crm-contacts', store, source, leaseTtlMs: 30_000 })
  // Record result.status and result.stats in the host application's telemetry.
} finally {
  await store.close()
}
```

The store owns its pool when given configuration. When given an existing `pg.Pool`,
the caller owns its lifecycle and idle-connection error reporting. Checkout, queries,
lock waits and transaction callbacks have deadlines. Failed sessions are discarded.
Choose transaction limits comfortably below the lease TTL; large pages that exceed
it stop with their checkpoint unchanged. Do not put source API calls in a transaction.
All `SyncTx` methods return promises and must be awaited. A transaction handle is
invalid after its callback completes or times out.

JSON values larger than the configured limit or values that cannot be JSON-encoded
stop the page with no checkpoint advancement. `listDeadLetters` returns stable UUIDs;
resolution and replay writes commit together, and resolved database entries remain
for audit. Lists currently return all matching entries: production hosts must control
workload size until paginated operator tooling is implemented.

## Guarantees and recovery

- Each page's rows, conflicts, dead letters and checkpoint commit or roll back together.
- Database time governs lease expiry. Claim/renew/release/fence lock the lease row
  before evaluating expiry; different sync names have independent locks.
- The final fence is the transaction's commit decision while holding the lock. A
  successor cannot acquire ownership until that commit or rollback finishes. This
  does not promise that the physical WAL flush occurs before a wall-clock deadline.
- A heartbeat renews at TTL/3 with one renewal in flight. Failure is terminal. The
  runner aborts its wait and passes an AbortSignal to sources; a source that ignores
  the signal may continue its remote request, but cannot obtain a new page commit.
- An abrupt process death rolls back open transactions. After expiry, another worker
  claims a higher epoch and resumes from the saved cursor. A lost COMMIT response is
  an unknown outcome: inspect/resume from durable state, never delete the checkpoint.
- Release is best effort. If cleanup fails after a commit, the committed result is
  preserved and ownership becomes available after expiry.

These are database application guarantees, not an authentication boundary between
hostile users sharing database credentials. A sync name namespaces data; the hosting
application must authorize which names a user may access. Direct SQL writers must
cooperate with lease ownership or use an explicitly designed local-edit protocol.

## Verification

Point `SYNCORE_TEST_DATABASE_URL` at a **disposable** database, apply migrations, and
run `pnpm test`. Integration tests terminate their own backends and child processes;
never run them against a production database. CI supplies PostgreSQL 17 and requires
all DB tests on Node 22 and 24. Without a test URL, local DB tests are visibly skipped
and cannot be used as evidence for this reliability gate.

Next milestones include incremental boundary correctness, same-timestamp revisions,
a real source adapter and reconciliation. Gate 2 does not certify these behaviors.
