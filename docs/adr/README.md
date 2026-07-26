# Architecture Decision Records (ADRs)

An ADR captures **one architecturally significant decision**: its context, the decision, the alternatives considered, and the consequences. ADRs are **immutable and append-only** — you never edit an accepted ADR's decision; you supersede it with a new one that links back.

## When an ADR is required
Any decision that changes: a **contract**, a **boundary/dependency rule**, a **technology** (from [reference/TECH-STACK](../reference/TECH-STACK.md)), a **principle/law** ([00-ENGINEERING-CONSTITUTION](../00-ENGINEERING-CONSTITUTION.md)), or a **cross-cutting pattern** (isolation, event schema policy, deployment strategy).

## Process
1. Copy [`ADR-TEMPLATE.md`](ADR-TEMPLATE.md) → `ADR-NNNN-short-title.md` (next number).
2. Status starts `Proposed`; move to `Accepted` when ratified (or `Rejected`/`Superseded`).
3. Link the ADR from the affected `docs/architecture/NN-*.md` section(s).
4. Only then change code.

## Status values
`Proposed` · `Accepted` · `Rejected` · `Superseded by ADR-NNNN` · `Deprecated`

## Index
| # | Title | Status |
|---|-------|--------|
| [0001](ADR-0001-capability-composition-over-vertical-features.md) | Capability composition over vertical features | Accepted |
| [0002](ADR-0002-model-agnostic-inference.md) | Model-agnostic inference via registry selectors | Accepted |
| [0003](ADR-0003-tenant-isolation-strategy.md) | Pooled-default / siloed-optional tenant isolation | Accepted |
| [0004](ADR-0004-edge-first-placement.md) | Edge-first capability placement, one codebase | Accepted |
| [0005](ADR-0005-event-driven-backbone.md) | Durable event backbone as the primary coupling | Accepted |

_Add new rows as ADRs are created. Never renumber; never delete._
