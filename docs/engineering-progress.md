# Engineering progress

## Completed

| Milestone | PR | Evidence |
| --- | --- | --- |
| SyncCore Gate 1: in-memory coordination | #1 | Merged; serialized ownership and expiry fencing |
| SyncCore Gate 2: PostgreSQL durability | [#2](https://github.com/itzzzzzzak/control-plane/pull/2) | Merged `6ca2471`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39027120382), Node 22/24 + PostgreSQL 17, 32 tests, zero skips; dependency audit clean; adversarial review recorded |

## Current

SyncCore Gate 3: record revision correctness. Unknown/repeated tombstones, duplicate
source deliveries after local edits, and ambiguous same-timestamp revisions.

## Subsequent order

1. Incremental query/watermark boundaries and bounded late-arrival policy.
2. Real source integration through ConnectorKit, with reproducible HTTP contract tests.
3. Reconciliation, operator telemetry/pagination and representative scale verification.
4. Durable-run, gatekeeper, trace, sandbox and scheduler, following `architecture.md`.

Each milestone requires failing regression evidence, working implementation, real
integration checks, exact-head green CI and adversarial review before merge. A live
credential-dependent exercise must not be claimed from fake or HTTP fixture tests.
