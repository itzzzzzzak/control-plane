# Architecture

ControlPlane is a modular monolith ([decision](#why-a-monolith)). One deployable app (`apps/server`) imports modules from `modules/`. Modules call each other as plain functions in one process and share one PostgreSQL database; each owns its own tables, prefixed with its name (`syncore_*`).

## Modules (planned order)
1. **syncore**: keeps two systems in step (initial and incremental sync, checkpoints, reconciliation, conflicts, dead letters, replay).
2. **durable-run**: workflows that survive crashes without repeating steps.
3. **gatekeeper**: permissions and approvals between agents and tools (MCP).
4. **trace**: traces, logs and costs for agent runs.
5. **sandbox**: isolated execution of agent-run code.
6. **scheduler**: triggers and timing.

## External
- **ConnectorKit** (separate library, installed from its GitHub release) provides the SaaS connectors.
- **PostgreSQL** holds all state.

## Rules
- A module is used only through `modules/<name>/index.ts` (checked by `scripts/check-boundaries.mjs`).
- A module never reads or writes another module's tables.
- Each module has a design doc in `docs/modules/` written before code, and failure scenarios tested deliberately.

## Why a monolith
One repo, one setup and one deploy while the pieces are still being learned; cross-module changes are one commit. Strict boundaries keep the option to extract a module later. ConnectorKit stays outside because it is already a published project with its own users.
