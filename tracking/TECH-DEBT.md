# Technical Debt Register

> The single place where known shortcuts, deferrals, and "we'll fix this later" decisions are recorded, so no agent rediscovers them the hard way. Adding debt without recording it here is a defect. Pay debt down by referencing its ID in the commit/PR that resolves it.

**How to use:** when you take a deliberate shortcut, add a row with an ID (`TD-NN`), what/why, the risk if left, and the trigger that should force paying it down. When you fix one, move it to **Resolved** with the resolving commit/PR. Sign entries `[<agent/name> · YYYY-MM-DD]`.

## Severity
`high` = correctness/security/scale risk; `medium` = maintainability/perf; `low` = cosmetic/ergonomic.

## Open debt
| ID | Area | What / why (the shortcut) | Risk if left | Pay-down trigger | Sev |
|----|------|---------------------------|--------------|------------------|-----|
| _(none yet — architecture phase)_ | | | | | |

## Resolved debt
| ID | Area | Resolution | Commit/PR | Date |
|----|------|-----------|-----------|------|
| _(none yet)_ | | | | |

## Standing "intentional non-debt" (design choices that look like debt but are not)
These are deliberate, ADR-backed decisions — do **not** "fix" them without an ADR reversal:
- Pooled multi-tenancy by default (siloed only for enterprise) — [ADR-0003](../docs/adr/ADR-0003-tenant-isolation-strategy.md).
- Raw detections are ephemeral (TTL'd), only aggregates/events persist — [18-DATA-ARCHITECTURE](../docs/architecture/18-DATA-ARCHITECTURE.md).
- Smart-clip-only storage (no continuous cloud recording by default) — [12-EVIDENCE-MANAGEMENT](../docs/architecture/12-EVIDENCE-MANAGEMENT.md).
- Eventual consistency between planes (at-least-once + idempotency) — [ADR-0005](../docs/adr/ADR-0005-event-driven-backbone.md).

## Cross-references
[PROGRESS.md](PROGRESS.md) · [TASK-BOARD.md](TASK-BOARD.md) · [../docs/adr/](../docs/adr/)
