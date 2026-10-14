# Engineering notebook

## Decisions
- **Modular monolith, ConnectorKit outside** (day 0). One repo and one deploy for the new modules; ConnectorKit remains a published library. Considered: seven separate repos (more setup, slower cross-changes) and everything inside (loses ConnectorKit's identity). Revisit if a module earns users and should be extracted.

- **Source of truth: Zoho wins; one-way first; resume from checkpoint** (day 1). Conflicts overwrite the database but record what was overwritten. One page of records and its checkpoint commit in one transaction, which is the whole resume guarantee.

## Failures
- A mutation check that removed the retry cap made the test run loop forever instead of failing: a reminder that a missing limit shows up as a hang, and that tests for retry limits need a timeout.

## Mistakes

## Concepts encountered
- Modular monolith: one deployable, modules with enforced public entry points.
