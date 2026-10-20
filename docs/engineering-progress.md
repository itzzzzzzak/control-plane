# Engineering progress

## Completed

| Milestone | PR | Evidence |
| --- | --- | --- |
| SyncCore Gate 1: in-memory coordination | #1 | Merged; serialized ownership and expiry fencing |
| SyncCore Gate 2: PostgreSQL durability | [#2](https://github.com/itzzzzzzak/control-plane/pull/2) | Merged `6ca2471`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39027120382), Node 22/24 + PostgreSQL 17, 32 tests, zero skips; dependency audit clean; adversarial review recorded |

| SyncCore Gate 3: revision correctness | [#3](https://github.com/itzzzzzzak/control-plane/pull/3) | Merged `f4b4f0e`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39027546002), 35 tests, zero skips, Node 22/24 + PostgreSQL 17; security review recorded |

| SyncCore Gate 4: query boundaries | [#4](https://github.com/itzzzzzzak/control-plane/pull/4) | Merged `31fcbd69`; [CI](https://github.com/itzzzzzzak/control-plane/actions/runs/39028017716), 39 tests, zero skips, Node 22/24 + PostgreSQL 17; security review recorded |

## Current

The ConnectorKit v0.7.0 Zoho adapter is integrated with bounded COQL reads, opaque
snapshot cursors, deletion tombstones and HTTP contract tests. The next milestone is
a dedicated sandbox live-acceptance run; no live provider certification is claimed.

## Subsequent order

1. Live Zoho sandbox acceptance with read-only credentials and recorded evidence.
2. Reconciliation, operator telemetry/pagination and representative scale verification.
3. Durable-run, gatekeeper, trace, sandbox and scheduler, following `architecture.md`.

Each milestone requires failing regression evidence, working implementation, real
integration checks, exact-head green CI and adversarial review before merge. A live
credential-dependent exercise must not be claimed from fake or HTTP fixture tests.

## Source integration prerequisites

ConnectorKit's current published dependency is release `v0.7.0`:
`connector-kit-0.7.0.tgz`, SHA-256
`f511cd6b0c31e290d53dd4821d3a3f49de536572d47c41da66119e9b19eaae25`.
The package is installed from the release asset with a reproducible lock; its internals
are not copied into ControlPlane. The current Zoho connector remains docs-based rather
than live-certified. SyncCore uses its `coql.query` action because `records.list` does
not expose a modified-since filter. The adapter bounds `Modified_Time` on both sides,
persists the upper bound in its cursor, and validates provider output against it.

Live acceptance requires a dedicated Zoho CRM sandbox, region, module/field scope and
read-only credentials (including COQL scope if that route is selected). Never use
production workplace CRM records for a public portfolio test or commit credentials.
No live source behavior has been claimed. Contract tests exercise the exact ConnectorKit
release connection and HTTP request shape without using real CRM records.
