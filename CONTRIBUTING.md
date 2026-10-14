# Contributing

Thanks for helping. ControlPlane is a modular monolith: one repo, one app, separate modules with strict boundaries. Read [docs/architecture.md](docs/architecture.md) first.

## Ground rules
- **Design before code.** Each module has a design doc in `docs/modules/`. A change to behavior starts with a change (or question) there.
- **Respect the boundary.** A module is used only through `modules/<name>/index.ts`, and never touches another module's tables. `pnpm check:boundaries` enforces the import rule.
- **Test the failures.** Every feature needs tests for what goes wrong: crashes midway, duplicates, bad data, outages. The happy path alone is not enough.
- **No silent data loss.** If the system overwrites or drops something, it records what and why.

## Develop
```bash
pnpm install
pnpm test      # build, boundary check, all tests
pnpm start
```
Node 22 or newer.

## Pull requests
Small and focused. Title them `type: summary` (`feat(syncore): ...`, `fix: ...`, `docs: ...`). Fill in the PR template. CI must be green (Node 22 and 24).

## Security
Do not open a public issue for a vulnerability; see [SECURITY.md](SECURITY.md).

By contributing you agree your work is licensed under the [MIT License](LICENSE) and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
