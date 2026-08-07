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

## Product engineering (2026-08-07 — the transition out of platform engineering)

> Written at the close of [P-9 Track A](P9_TRACK_A_CLOSEOUT.md). **These plan work; they authorise
> none of it.** Each milestone is still authorised at review, in sequence.

| File                                                               | Purpose                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [PRODUCT_READINESS.md](PRODUCT_READINESS.md)                       | What is production-ready, demo-ready, hardware-gated, verification-only — and what a customer can use today. Three deployment shapes |
| [PRODUCT_IMPLEMENTATION_ORDER.md](PRODUCT_IMPLEMENTATION_ORDER.md) | **⭐ Start here.** Dependency graph, critical path, parallel lanes, durations, and the single recommendation                         |
| [OFFLINE_VIDEO_PLAN.md](OFFLINE_VIDEO_PLAN.md)                     | P-8 Phase 8 — upload an MP4, get incidents. Closes C-21 / TD-9 G-2                                                                   |
| [RETAIL_CAPABILITY_PACK.md](RETAIL_CAPABILITY_PACK.md)             | Nine retail capabilities against the primitives that exist, and the four that do not                                                 |
| [DEMO_MODE_PLAN.md](DEMO_MODE_PLAN.md)                             | Runtime Preview vs Product Demonstration, and the two requested panels that do not exist                                             |

## Governance suite (Architect-mandated · append-only where noted)

> Permanent engineering policy. Every slice updates the applicable files before it is [Done](DEFINITION_OF_DONE.md). See also the reusable [templates](../templates/).

| File                                                                                     | Purpose                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [ENGINEERING_DECISION_LOG.md](ENGINEERING_DECISION_LOG.md)                               | All engineering decisions (append-only)                       |
| [RISK_REGISTER.md](RISK_REGISTER.md)                                                     | Risks: impact/probability/severity/mitigation                 |
| [ASSUMPTIONS.md](ASSUMPTIONS.md)                                                         | Working assumptions + validation method                       |
| [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md)                                                   | Surfaced uncertainty awaiting decision                        |
| [CONSTRAINTS.md](CONSTRAINTS.md)                                                         | Hard rules future engineers must never violate                |
| [FOUNDATIONS.md](FOUNDATIONS.md)                                                         | **The canonical register of frozen foundations — start here** |
| [FOUNDATION_PRINCIPLES.md](FOUNDATION_PRINCIPLES.md)                                     | **Mandatory reading before modifying a foundation**           |
| [PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md)                                           | **Mandatory reading before adding a product feature**         |
| [PLATFORM_ROADMAP.md](PLATFORM_ROADMAP.md)                                               | The four layers and what sits in each (governance)            |
| [INDEX_POLICY.md](INDEX_POLICY.md)                                                       | When an index exists, when it must not, write cost            |
| [../architecture/PLATFORM_BOUNDARIES.md](../architecture/PLATFORM_BOUNDARIES.md)         | Permanent component ownership                                 |
| [../architecture/CAMERA_FOUNDATION_V1.md](../architecture/CAMERA_FOUNDATION_V1.md)       | Camera Foundation v1.0 freeze record                          |
| [../architecture/HIERARCHY_FOUNDATION_V1.md](../architecture/HIERARCHY_FOUNDATION_V1.md) | Location Hierarchy v1.0 freeze record                         |
| [DEFINITION_OF_DONE.md](DEFINITION_OF_DONE.md)                                           | The per-slice DoD checklist                                   |
| [QUALITY_GATES.md](QUALITY_GATES.md)                                                     | Per-sprint PASS/FAIL scorecard                                |
| [API_INVENTORY.md](API_INVENTORY.md)                                                     | Every API endpoint across services                            |
| [../testing/](../testing/)                                                               | Per-slice PO-executable test scenarios                        |
| [../tracker/REVIEW_HISTORY.md](../tracker/REVIEW_HISTORY.md)                             | Per-slice review + Architect handoff                          |
| [../templates/](../templates/)                                                           | Reusable documentation templates                              |
