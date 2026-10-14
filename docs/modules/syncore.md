# SyncCore: design

Status: **decided for v1**. Engine and in-memory store first; Postgres store and the Zoho source (via ConnectorKit) next.

## Problem
Calling an API is simple. Keeping two systems consistent over time, through crashes, rate limits, duplicate events and concurrent edits, is not.

First target: **Zoho CRM to PostgreSQL**, later two-way.

## Questions the design must answer
1. **Source of truth.** DECIDED: **Zoho wins** (owner: "Phone A"). When both sides changed the same field, Zoho's value overwrites the database's. Consequences to design for: the overwritten database value must not be lost silently (keep it in a conflict log so it can be reviewed or replayed), and this rule is per source system, so a later two-way mode must say which fields each side owns.
2. **Direction.** DECIDED: one way first (Zoho to Postgres); two-way later.
3. **Failure.** DECIDED: a restart resumes from the last checkpoint, never from zero, and never applies a record twice.

## Concepts to learn on the way
Eventual consistency, watermarks, checkpoints, idempotency, change detection, reconciliation, conflict resolution, dead-letter records, replay.

## Failure scenarios to create on purpose
API unavailable halfway; duplicate event; record deleted remotely; 50,000 records; malformed record; rate limit hit; schema change; both sides changed the same field.

## Not in v1
Bidirectional sync, more than one source type, a UI.

## Design (v1)
**Parts.** A `Source` returns pages of raw records and an opaque next cursor. A `SyncStore` holds the synced rows, the sync state (cursor, watermark), the conflict log and the dead letters, and runs a transaction. `runSync` ties them together.

**One page = one transaction.** Applying a page's records and saving the checkpoint (the next cursor) happen together or not at all. A crash can therefore never leave "records applied, checkpoint not saved" (which would re-apply them) or the reverse (which would skip them). That is the whole resume guarantee.

**Idempotent apply.** Each row remembers the source's `modifiedAt` and a hash of the data last synced. A record older than the row is skipped; an equal one with the same data is "unchanged". Re-delivering a page or a duplicate event changes nothing.

**Full, then incremental.** The first run walks every page. When the last page is done, the highest `modifiedAt` seen becomes the **watermark**; the next run asks the source only for changes since then. The watermark moves only when a run completes, so a resumed run uses the same `since` as the one it continues.

**Conflicts (Zoho wins).** If the database row's data no longer matches the hash of what was last synced, someone edited it locally. Zoho's value still overwrites it, and the overwritten value is written to the conflict log first.

**Bad records.** A record that fails validation goes to the dead-letter list with the reason and the sync continues. `replayDeadLetters` retries them (after a fix or a schema change).

**Deletes.** A record deleted at the source becomes a tombstone (`deleted: true`) in the database, not a physical delete, so it can be audited.

**Source failures.** Retryable errors (rate limit, 5xx) are retried with backoff, honoring `retryAfter`. Anything else stops the run **with the checkpoint intact**; `runSync` returns `status: "stopped"` instead of throwing, because stopping partway is an expected outcome.
