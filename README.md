# ControlPlane

A self-hostable control plane for reliable agents and automations, built as a **modular monolith**: one repo, one process, one database, with strictly separated modules.

> Status: early. SyncCore implements one-way sync with checkpoints, conflicts, atomic dead-letter replay, PostgreSQL persistence, fenced leases and heartbeat. A ConnectorKit-backed Zoho CRM source now provides bounded COQL reads and deletion tombstones; live sandbox certification is still pending. Part of a Sept to Dec 2026 engineering plan whose capstone combines every module.

[![CI](https://github.com/itzzzzzzak/control-plane/actions/workflows/ci.yml/badge.svg)](https://github.com/itzzzzzzak/control-plane/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

Requires Node 22 or newer. PostgreSQL setup and recovery: [operations guide](docs/modules/syncore-postgres-operations.md). Local tests without `SYNCORE_TEST_DATABASE_URL` skip database integration tests; CI requires them.

### Run the Zoho vertical slice locally

```bash
docker compose up -d postgres
cp .env.example .env
# Add a short-lived Zoho OAuth access token to .env.
pnpm sync:zoho
```

On a fresh Docker volume the numbered SyncCore migrations run automatically. Existing
databases must be migrated explicitly using the operations guide. The container keeps
its data in the Compose-managed PostgreSQL volume and restarts unless stopped.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)

