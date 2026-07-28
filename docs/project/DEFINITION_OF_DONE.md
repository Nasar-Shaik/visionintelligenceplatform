# Definition of Done

> The canonical checklist. **Every slice must satisfy every applicable item before it is considered Done.** If any item is incomplete, the slice is **NOT Done**. Each slice's review row ([REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md)) records its actual status against this checklist.
>
> Items marked _(when applicable)_ are skipped only when structurally impossible for the slice (e.g. Docker validation for a docs-only slice) — and the skip is stated explicitly with a reason.

## Checklist

| #   | Item                           | Meaning                                                                                           |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| 1   | ✅ Implementation Complete     | The slice's scope is fully implemented; no TODO stubs in shipped paths                            |
| 2   | ✅ Documentation Updated       | Architecture/reference/governance docs reflect the change                                         |
| 3   | ✅ README Updated              | Affected package/service/plugin READMEs are current and accurate                                  |
| 4   | ✅ Unit Tests                  | Logic covered by unit tests; all pass                                                             |
| 5   | ✅ Integration Tests           | Cross-boundary behaviour tested (HTTP inject / Testcontainers) _(when applicable)_                |
| 6   | ✅ Scenario Tests              | A PO-executable scenario doc exists in [docs/testing/](../testing/)                               |
| 7   | ✅ Logging                     | Structured logs with correlation id on the relevant paths _(when applicable)_                     |
| 8   | ✅ Metrics                     | Prometheus metrics exposed / extended _(when applicable)_                                         |
| 9   | ✅ Health Checks               | `/health` + `/ready` behave correctly _(services only)_                                           |
| 10  | ✅ Docker Validation           | Compose config validates / service boots in a container _(when applicable)_                       |
| 11  | ✅ Dependency Review           | New deps registry-verified + recorded in [DEPENDENCIES](DEPENDENCIES.md)                          |
| 12  | ✅ Security Review             | Secrets/SAST considered; no secrets committed; threats noted in [RISK_REGISTER](RISK_REGISTER.md) |
| 13  | ⏳ Architecture Review Pending | Handoff prepared; **left PENDING for the Architect** — never self-approved                        |

## Governance trackers (must all be updated as part of Done)

- [ ] [ENGINEERING_DECISION_LOG](ENGINEERING_DECISION_LOG.md) — new decisions appended
- [ ] [RISK_REGISTER](RISK_REGISTER.md) — new/rescored risks
- [ ] [ASSUMPTIONS](ASSUMPTIONS.md) — new assumptions
- [ ] [OPEN_QUESTIONS](OPEN_QUESTIONS.md) — new/closed questions
- [ ] [QUALITY_GATES](QUALITY_GATES.md) — this sprint's PASS/FAIL recorded
- [ ] [API_INVENTORY](API_INVENTORY.md) — any new/changed endpoints
- [ ] [docs/testing/slice-NNN.md](../testing/) — scenario doc created
- [ ] [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md) — slice review row added, Architect column PENDING
- [ ] [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) + [DAILY_LOG](../tracker/DAILY_LOG.md) + [TASK-BOARD](../../tracking/TASK-BOARD.md) — updated

**Rule:** if any item above is "No", the slice is not complete. The Architect column in [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md) stays PENDING until the Architect signs off — never self-approved.
