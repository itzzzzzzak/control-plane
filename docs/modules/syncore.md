# SyncCore: design

Status: engine and PostgreSQL durability are implemented. See [engineering progress](../engineering-progress.md). Live Zoho source integration remains subsequent work.

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

**Idempotent apply.** Each row remembers the source's `modifiedAt` and a hash of the data last synced. A record older than the row is skipped; an equal source baseline is skipped even if the row was locally edited. Newer metadata with unchanged source content preserves local edits. Different live payloads at the same instant stop and roll back the page: a timestamp-only source cannot order them. See [Gate 3](syncore-reliability-gate-3.md).

**Full, then incremental.** The first run walks every page. When the last page is done, the greater of the previous watermark and the highest `modifiedAt` seen becomes the **watermark**; the next run asks the source inclusively from that watermark minus a bounded lookback (60 seconds by default, configurable from 0 to 24 hours). The exact query is pinned with unfinished cursors, so a restart or configuration change cannot alter the query associated with the cursor. Events outside that window still require reconciliation. The watermark moves only when a run completes, so a resumed run uses the same `since` as the one it continues.

**Conflicts (Zoho wins).** If the database row's data no longer matches the hash of what was last synced, someone edited it locally. If the source also changed from its baseline, Zoho's value overwrites it, and the overwritten value is written to the conflict log first.

**Bad records.** A record that fails validation goes to the dead-letter list with the reason and the sync continues. `replayDeadLetters` retries them (after a fix or a schema change).

**Deletes.** A record deleted at the source becomes a tombstone (`deleted: true`), including unseen IDs. Repeated deletes advance its timestamp; only a strictly newer live revision can resurrect it. A delete wins a timestamp tie. Known row data remains available for audit.

**Source failures.** Retryable errors (rate limit, 5xx) are retried with backoff, honoring `retryAfter`. Anything else stops the run **with the checkpoint intact**; `runSync` returns `status: "stopped"` instead of throwing, because stopping partway is an expected outcome.

