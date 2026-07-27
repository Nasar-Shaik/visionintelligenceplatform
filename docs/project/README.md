# docs/project/ — Program Status & Management

Human-facing program status, backlog, decisions, and timeline. Where `tracking/` already owns a fact, these files **point** to it (no duplication).

| File                                                     | Purpose                                  | Canonical source                     |
| -------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| [CURRENT_SPRINT.md](CURRENT_SPRINT.md)                   | Active sprint + slices                   | this file                            |
| [CURRENT_STATUS.md](CURRENT_STATUS.md)                   | One-glance status                        | → tracking/PROGRESS.md               |
| [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) | What code/scaffolding shipped, per slice | this file                            |
| [NEXT_STEPS.md](NEXT_STEPS.md)                           | Near-term narrative                      | → tracking/TASK-BOARD.md             |
| [BACKLOG.md](BACKLOG.md)                                 | Backlog index                            | → tracking/TASK-BOARD.md, ROADMAP.md |
| [DECISIONS.md](DECISIONS.md)                             | ADR quick-reference                      | → docs/adr/                          |
| [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md)       | Post-freeze change log                   | this file                            |
| [KNOWN_ISSUES.md](KNOWN_ISSUES.md)                       | Active problems/bugs                     | this file                            |
| [TECH_DEBT.md](TECH_DEBT.md)                             | Debt                                     | → tracking/TECH-DEBT.md              |
| [PROJECT_TIMELINE.md](PROJECT_TIMELINE.md)               | Milestone timeline                       | → tracking/ROADMAP.md, MILESTONES.md |
| [DEPENDENCIES.md](DEPENDENCIES.md)                       | Dependency policy + verified versions    | this file                            |

## Governance suite (Architect-mandated · append-only where noted)

> Permanent engineering policy. Every slice updates the applicable files before it is [Done](DEFINITION_OF_DONE.md). See also the reusable [templates](../templates/).

| File                                                       | Purpose                                        |
| ---------------------------------------------------------- | ---------------------------------------------- |
| [ENGINEERING_DECISION_LOG.md](ENGINEERING_DECISION_LOG.md) | All engineering decisions (append-only)        |
| [RISK_REGISTER.md](RISK_REGISTER.md)                       | Risks: impact/probability/severity/mitigation  |
| [ASSUMPTIONS.md](ASSUMPTIONS.md)                           | Working assumptions + validation method        |
| [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)                     | Surfaced uncertainty awaiting decision         |
| [CONSTRAINTS.md](CONSTRAINTS.md)                           | Hard rules future engineers must never violate |
| [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)             | The per-slice DoD checklist                    |
| [QUALITY_GATES.md](QUALITY_GATES.md)                       | Per-sprint PASS/FAIL scorecard                 |
| [API_INVENTORY.md](API_INVENTORY.md)                       | Every API endpoint across services             |
| [../testing/](../testing/)                                 | Per-slice PO-executable test scenarios         |
| [../review/](../review/)                                   | Per-sprint review + Architect handoff          |
| [../templates/](../templates/)                             | Reusable documentation templates               |
