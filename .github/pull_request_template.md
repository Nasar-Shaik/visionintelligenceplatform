<!--
PR template — also your solo pre-merge checklist (see CONTRIBUTING.md §3–4).
Keep the checklist; delete guidance comments before submitting.
-->

## What & why
<!-- One paragraph: what this changes and the reason. Link the driving task. -->

- **Task:** <!-- TASK-BOARD id, e.g. P0-2 -->
- **Type:** feat | fix | docs | chore | refactor | test | perf | build | ci
- **Scope:** <!-- services/ai/edge/packages/plugins/infra/tests/tools/docs/tracking or a service/capability -->

## How
<!-- Brief notes on the approach; call out anything non-obvious for the next agent. -->

## Definition of Done (CONTRIBUTING.md §4 / AGENT-ONBOARDING §5)
- [ ] Contract added/updated & versioned (if applicable); implementation matches it
- [ ] **No core → plugin dependency; no industry/customer logic in the core** (Law 1)
- [ ] Tenant isolation preserved; isolation test added for any new data path
- [ ] Unit/integration tests pass; new behavior covered
- [ ] Observability on new paths (metrics/traces/logs)
- [ ] No secrets, no PII in logs, no hardcoded tenant/customer/model constants
- [ ] `PROGRESS.md` + `TASK-BOARD.md` updated; milestone ticked if a gate passed
- [ ] CI green

## Architecture impact
- [ ] No architectural decision made — **or** — ADR added: `ADR-____` and affected `docs/architecture/NN-*.md` updated
- [ ] No breaking contract change — **or** — `BREAKING CHANGE:` noted + deprecation/migration described

## Evidence
<!-- Test output, screenshot, metric, or demo notes proving it works. -->
