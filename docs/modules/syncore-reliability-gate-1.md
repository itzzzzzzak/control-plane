# SyncCore Reliability Gate 1: per-sync coordination and fencing

Status: PROPOSED CONTRACT / RED TESTS ONLY. No production implementation in this branch yet.

## Invariants

1. At most one live owner may commit writes for a given sync name at a time.
2. Different sync names can run independently.
3. The owner has an opaque, immutable token and a monotonically increasing fencing epoch allocated **atomically by the store**.
4. Every transaction that mutates rows, conflicts, dead letters, or checkpoint must validate the owner token/epoch **inside the same transaction**. A lease expiry or newer epoch permanently fences older owners, even if the old worker resumes.
5. Acquire and release are atomic; release is conditional on matching ownership. Release by an old owner may never unlock the new owner.
6. All outcomes (success, exhausted retry, validation/storage failure, cancellation) attempt a best-effort release. Lease expiry enables recovery after a process crash.
7. Acquisition failures return an explicit `busy` result; the runner does not fetch or process a page. A lost lease returns a distinct `lease-lost` outcome and never commits.
8. The checkpoint + all writes for a page remain atomic; an owner cannot commit after its lease expires, even if the page was fetched before expiry.
9. Replay operations must eventually honor the same ownership/fencing rule, rather than bypass the coordinator.

## Proposed API sketch (not implemented)

```ts
interface SyncLease {
  sync: string
  token: string            // unique, unguessable ownership identifier
  epoch: bigint            // monotonically increasing fencing token
  expiresAt: Date
}

interface SyncCoordinator {
  acquire(sync: string, ttlMs: number): Promise<SyncLease | null>
  renew(lease: SyncLease, ttlMs: number): Promise<SyncLease | null>
  release(lease: SyncLease): Promise<boolean>
}

// Store enforcement must be mandatory for write transactions:
// store.transaction(sync, lease, tx => { ... rows + checkpoint ... })
// throws LeaseLostError when lease is absent, expired, or fenced.
```

Do not let callers optionally omit a lease on the production write path. Avoid `getState`-then-lock: acquire before reading state, and keep renewal bounded. Use database time for expiration. Keep source fetches outside DB transactions; validate fencing at commit.

## PostgreSQL strategy

Use a `syncore_leases` row per sync name (primary key `sync_name`), with `epoch BIGINT`, `token`, and `expires_at`. Acquire via an atomic row-level-locking transaction/UPSERT that grants an expired/unowned row and advances epoch. Check `epoch`, `token`, and expiry using DB time while holding the row lock for every page transaction. Renew and release conditionally with the same checks. Postgres uniqueness plus locking serializes competing claims; a fencing counter is required because TTL alone cannot stop a paused worker.

## Trade-offs

- **Lease + fencing over process mutex:** works after crashes and across processes; requires DB round trips and expiration discipline.
- **Fail-fast busy over a queue:** deterministic and easy to operate now; future scheduler can retry busy jobs.
- **Per-sync exclusivity over global lock:** unrelated syncs retain throughput.
- **Finite TTL + renew over indefinite owner lock:** crash recovery works, but long fetches need heartbeat and a failed heartbeat must stop writes.
- **Row-lock check on commit over trust in caller:** stronger consistency at cost of short database lock sections.

## RED tests for the current prototype

`modules/syncore/reliability-gate-1.test.ts` first reproduces overlapping `runSync` calls and concurrent in-memory transaction lost updates. They MUST fail against current code. These tests are diagnostic and are not yet a complete lease/fencing acceptance suite: future tests must cover expiry, renewal, stale owner commits, stale owner release, crash/restart, per-sync independence and replay interactions.

## Later decisions required

- How the sync runner reports `busy` and `lease-lost` without conflating them with ordinary source errors.
- Lock TTL/renewal interval and clock assumptions for production.
- Isolation guarantees for direct store access and local target edits outside SyncCore.
- Robust incremental watermarks and same-timestamp revisions: independent reliability work, not part of Gate 1.
