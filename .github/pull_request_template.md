## What and why

## Checklist
- [ ] Tests added or updated, including the failure paths (crash, duplicate, bad data)
- [ ] `pnpm test` passes (it also checks module boundaries)
- [ ] The module's design doc in `docs/modules/` is updated if behavior or a decision changed
- [ ] No module reaches into another's internals or tables
- [ ] No secrets in logs or errors
- [ ] PR title is `type: summary` (e.g. `feat(syncore): resume from checkpoint`)
