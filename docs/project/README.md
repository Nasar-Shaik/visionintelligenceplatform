# docs/project/ — Program Status & Management

Human-facing program **policy, decisions, and reference** (governance suite, dependencies, roadmap). Where another file already owns a fact, these files **point** to it (no duplication).

> **Live status / sprint / next-step / backlog / what-shipped** are **not** here — they live in the single canonical tracker **[`docs/tracker/`](../tracker/)**: [MASTER_PROGRESS](../tracker/MASTER_PROGRESS.md) (dashboard — status, current slice, next, blockers) · [REVIEW_HISTORY](../tracker/REVIEW_HISTORY.md) (per-slice, what shipped) · [DAILY_LOG](../tracker/DAILY_LOG.md) (narrative). Backlog/roadmap: [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) · [`tracking/ROADMAP.md`](../../tracking/ROADMAP.md). The former `CURRENT_SPRINT`/`CURRENT_STATUS`/`NEXT_STEPS`/`BACKLOG`/`IMPLEMENTATION_PROGRESS` stubs were removed 2026-07-30 ([ED-0032](ENGINEERING_DECISION_LOG.md)).

| File                                               | Purpose                               | Canonical source                     |
| -------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| [DECISIONS.md](DECISIONS.md)                       | ADR quick-reference                   | → docs/adr/                          |
| [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md) | Post-freeze change log                | this file                            |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md)                 | Active problems/bugs                  | this file                            |
| [TECH_DEBT.md](TECH_DEBT.md)                       | Debt                                  | → tracking/TECH-DEBT.md              |
| [PROJECT_TIMELINE.md](PROJECT_TIMELINE.md)         | Milestone timeline                    | → tracking/ROADMAP.md, MILESTONES.md |
| [DEPENDENCIES.md](DEPENDENCIES.md)                 | Dependency policy + verified versions | this file                            |
| [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md)           | Top-level phase map (0→4)             | this file                            |

> **Phase 1 blueprint:** [`../architecture/phase1/`](../architecture/phase1/README.md) — full pre-implementation architecture (awaiting Architect approval).

## Governance suite (Architect-mandated · append-only where noted)

> Permanent engineering policy. Every slice updates the applicable files before it is [Done](DEFINITION_OF_DONE.md). See also the reusable [templates](../templates/).

| File                                                         | Purpose                                        |
| ------------------------------------------------------------ | ---------------------------------------------- |
| [ENGINEERING_DECISION_LOG.md](ENGINEERING_DECISION_LOG.md)   | All engineering decisions (append-only)        |
| [RISK_REGISTER.md](RISK_REGISTER.md)                         | Risks: impact/probability/severity/mitigation  |
| [ASSUMPTIONS.md](ASSUMPTIONS.md)                             | Working assumptions + validation method        |
| [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)                       | Surfaced uncertainty awaiting decision         |
| [CONSTRAINTS.md](CONSTRAINTS.md)                             | Hard rules future engineers must never violate |
| [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)               | The per-slice DoD checklist                    |
| [QUALITY_GATES.md](QUALITY_GATES.md)                         | Per-sprint PASS/FAIL scorecard                 |
| [API_INVENTORY.md](API_INVENTORY.md)                         | Every API endpoint across services             |
| [../testing/](../testing/)                                   | Per-slice PO-executable test scenarios         |
| [../tracker/REVIEW_HISTORY.md](../tracker/REVIEW_HISTORY.md) | Per-slice review + Architect handoff           |
| [../templates/](../templates/)                               | Reusable documentation templates               |
