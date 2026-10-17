# Engineering notebook

## Decisions
- **Modular monolith, ConnectorKit outside** (day 0). One repo and one deploy for the new modules; ConnectorKit remains a published library. Considered: seven separate repos (more setup, slower cross-changes) and everything inside (loses ConnectorKit's identity). Revisit if a module earns users and should be extracted.

- **Source of truth: Zoho wins; one-way first; resume from checkpoint** (day 1). Conflicts overwrite the database but record what was overwritten. One page of records and its checkpoint commit in one transaction, which is the whole resume guarantee.

## Failures
- A mutation check that removed the retry cap made the test run loop forever instead of failing: a reminder that a missing limit shows up as a hang, and that tests for retry limits need a timeout.

## Mistakes

## Concepts encountered
- Modular monolith: one deployable, modules with enforced public entry points.


## 2026-10-17 reliability gates

- Gates 2–4 merged through PRs #2, #3 and #4. Exact-head CI ran Node 22/24 with
  PostgreSQL 17; final suite: 39 passed, zero skipped. Author-side adversarial reviews
  were recorded; no independent maintainer approval was claimed.
- A lease renewal can wait on a row lock after its predicate was evaluated. Lock first,
  then evaluate database wall time; otherwise an expired owner may be revived.
- Crash durability needs process death and commit-response-loss tests, not merely
  pool mocks. Stable dead-letter IDs allow replay and resolution to commit together.
- Preserve deletion versions, including unseen IDs. A timestamp-only source cannot
  order different payloads at the same instant; stop and roll back instead of guessing.
- Query boundaries belong to the durable cursor. A configurable overlap without a
  persisted boundary can change a resumed query and silently skip data.
- Test fixtures that terminate database backends must identify their own connections;
  broad pg_stat_activity queries can interfere with parallel suites.
- Next source acceptance needs a sandbox. Existing ConnectorKit v0.7.0 listing does
  not expose modified-since; release access and query design must be resolved first.
