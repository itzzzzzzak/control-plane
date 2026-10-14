# Engineering notebook

## Decisions
- **Modular monolith, ConnectorKit outside** (day 0). One repo and one deploy for the new modules; ConnectorKit remains a published library. Considered: seven separate repos (more setup, slower cross-changes) and everything inside (loses ConnectorKit's identity). Revisit if a module earns users and should be extracted.

## Failures

## Mistakes

## Concepts encountered
- Modular monolith: one deployable, modules with enforced public entry points.
