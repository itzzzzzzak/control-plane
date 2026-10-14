# ControlPlane

A self-hostable control plane for reliable agents and automations, built as a **modular monolith**: one repo, one process, one database, with strictly separated modules.

> Status: day 0. Only the skeleton and the SyncCore design exist. Part of the Sept to Dec 2026 CTO plan; the capstone combines every module.

## Shape

```
apps/server/      the one deployable app (UI and API come later)
modules/
  syncore/        keeps two systems in step (first module)
  ...             durable-run, gatekeeper, trace, sandbox, scheduler follow
docs/             architecture, one design doc per module, the engineering notebook
scripts/          the boundary checker
```

[ConnectorKit](https://github.com/itzzzzzzak/connector-kit) is **not** inside: it is a published library that ControlPlane installs like any user would.

## The one rule

A module may use another module only through `modules/<name>/index.ts`. `pnpm check:boundaries` fails the build otherwise. This is what keeps a monolith from tangling, and it is what makes extracting a module into its own repo cheap later.

## Develop

```bash
pnpm install
pnpm test      # build, boundary check, tests
pnpm start
```

Requires Node 22 or newer. Licensed MIT.
