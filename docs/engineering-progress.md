# Engineering progress

## Completed

| Milestone | PR | Evidence |
| --- | --- | --- |
| SyncCore Gate 1: in-memory coordination | #1 | Merged; serialized ownership and expiry fencing |
| SyncCore Gate 2: PostgreSQL durability | [#2](https://github.com/itzzzzzzak/control-plane/pull/2) | Merged `6ca2471`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39027120382), Node 22/24 + PostgreSQL 17, 32 tests, zero skips; dependency audit clean; adversarial review recorded |

| SyncCore Gate 3: revision correctness | [#3](https://github.com/itzzzzzzak/control-plane/pull/3) | Merged `f4b4f0e`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39027546002), 35 tests, zero skips, Node 22/24 + PostgreSQL 17; security review recorded |

## Current

SyncCore Gate 4: bounded late arrivals and persistent incremental query boundaries.
Pinned cursor queries, compatible legacy migration and restart after configuration changes.

## Subsequent order

1. Real source integration through ConnectorKit, with reproducible HTTP contract tests.
2. Reconciliation, operator telemetry/pagination and representative scale verification.
3. Durable-run, gatekeeper, trace, sandbox and scheduler, following `architecture.md`.

Each milestone requires failing regression evidence, working implementation, real
integration checks, exact-head green CI and adversarial review before merge. A live
credential-dependent exercise must not be claimed from fake or HTTP fixture tests.
