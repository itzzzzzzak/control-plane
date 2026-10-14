# SyncCore: design

Status: **draft, waiting for the owner's answers** (marked OPEN). No code until these are settled.

## Problem
Calling an API is simple. Keeping two systems consistent over time, through crashes, rate limits, duplicate events and concurrent edits, is not.

First target: **Zoho CRM to PostgreSQL**, later two-way.

## Questions the design must answer
1. **Source of truth.** DECIDED: **Zoho wins** (owner: "Phone A"). When both sides changed the same field, Zoho's value overwrites the database's. Consequences to design for: the overwritten database value must not be lost silently (keep it in a conflict log so it can be reviewed or replayed), and this rule is per source system, so a later two-way mode must say which fields each side owns.
2. **Direction.** One way first (Zoho to Postgres), two-way later? OPEN. Suggested: yes.
3. **Failure.** If the run dies at record 30,000 of 50,000, what does a restart do? OPEN. Suggested: resume from the last checkpoint, never from zero, and never apply a record twice.

## Concepts to learn on the way
Eventual consistency, watermarks, checkpoints, idempotency, change detection, reconciliation, conflict resolution, dead-letter records, replay.

## Failure scenarios to create on purpose
API unavailable halfway; duplicate event; record deleted remotely; 50,000 records; malformed record; rate limit hit; schema change; both sides changed the same field.

## Not in v1
Bidirectional sync, more than one source type, a UI.
