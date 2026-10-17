# SyncCore Reliability Gate 3: record revision correctness

Status: RED CONTRACT. Gate 2 merged in PR #2 at `6ca2471` after real PostgreSQL
verification. This milestone changes record ordering semantics, not lease storage.

## Problems

- A delete for an unseen ID is discarded, so a delayed older create can resurrect it.
- Repeated deletes do not advance the tombstone's source version, allowing an older
  live record between those delete versions to resurrect it.
- A duplicate source delivery can overwrite a local edit and append a false conflict,
  even though the source has not changed since the last synchronized baseline.
- Different payloads at the same source timestamp are silently applied in arrival
  order. No source revision sequence exists, so timestamp equality cannot order them.

## Decisions

1. Persist unknown deletes as tombstones; preserve the original data of known rows.
2. Repeated newer deletes advance the tombstone timestamp. Only strictly newer live
   revisions may resurrect a tombstone; a tied delete wins over a live record.
3. Equivalent timestamps compare as instants, regardless of string offset/format.
4. An unchanged source baseline never overwrites a local edit; advance timestamp
   metadata when newer, but preserve local data and baseline hash.
5. Two live payloads with the same timestamp and different baseline hashes are
   ambiguous: stop and rollback the entire page, returning a specific error and
   preserving its checkpoint. Never guess ordering or silently overwrite. An
   operator/source must provide a strictly newer revision to resolve the ambiguity.
6. A strictly newer source change still wins and records any overwritten local data.
7. Replay obeys the same rules; ambiguity or storage failure leaves dead letters
   unresolved. A failed page does not publish speculative row counts or conflicts.

## Verification

Shared executable contracts run against both stores. PostgreSQL contracts must run
in CI, alongside all Gate 2 process/crash tests. Cover unknown tombstones, repeated
delete versions, stale resurrection, tied deletion precedence, legitimate resurrection,
unchanged source/local edits, same-instant offsets, ambiguous revisions, atomic page
rollback and replay failure retention. Demonstrate RED before implementation.

## Limits

A timestamp-only source cannot totally order same-timestamp modifications. Failing
closed preserves data, but needs operator attention. This does not solve late arrivals
older than the incremental watermark, source snapshots, direct local SQL races or
field-level conflict merging. Those remain explicit subsequent work.
