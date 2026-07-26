# Progress — Current State of the World

> **The first thing any agent reads to know "where are we."** Update it every working session. Sign entries `[<agent/name> · YYYY-MM-DD]`. Write for a stranger with zero context.

## Snapshot
- **Current phase:** Phase 0 — Program Setup & Architecture ([ROADMAP](ROADMAP.md#phase-0--program-setup--architecture-current--34-weeks)).
- **Architecture:** **Ratified v1.0** — full docs set in [`../docs/`](../docs/). Changes now go through [ADRs](../docs/adr/).
- **Code:** Not yet started. Directory skeleton + self-documenting READMEs in place.
- **Next concrete work:** stand up the monorepo + `packages/contracts` + CI skeleton (see [TASK-BOARD → Now](TASK-BOARD.md#now)).

## Phase status
| Phase | Status | Notes |
|---|---|---|
| P0 Program Setup & Architecture | 🟡 In progress | Architecture ratified; monorepo/CI/contracts pipeline still to build |
| P1 SaaS Foundation | ⚪ Not started | Blocked on P0 exit |
| P2 Video & Ingestion | ⚪ Not started | |
| P3 Capability & Inference Platform | ⚪ Not started | |
| P4 Event/Rule/Alert Platform | ⚪ Not started | First sellable increment |
| P5 Workflow & Command Center | ⚪ Not started | |
| P6 Analytics & Search | ⚪ Not started | |
| P7 Extensibility & Industry Packs | ⚪ Not started | |
| P8 Enterprise & Compliance | ⚪ Not started | |
| P9 MLOps & Model Expansion | ⚪ Not started | |
| P10 Production, Scale & GA | ⚪ Not started | |

Legend: ✅ done · 🟢 on track · 🟡 in progress · 🔴 blocked · ⚪ not started

## Capability status (fills in during P3+)
Track each capability from [reference/AI-CAPABILITY-CATALOG](../docs/reference/AI-CAPABILITY-CATALOG.md): `not-started → contract → implemented → tested → GA`. None started yet.

| Capability | Contract | Impl | Tests | GA |
|---|---|---|---|---|
| _(add rows as capabilities begin in P3)_ | | | | |

## Decisions of record
Seed ADRs accepted: [0001](../docs/adr/ADR-0001-capability-composition-over-vertical-features.md) capability composition · [0002](../docs/adr/ADR-0002-model-agnostic-inference.md) model-agnostic inference · [0003](../docs/adr/ADR-0003-tenant-isolation-strategy.md) isolation strategy · [0004](../docs/adr/ADR-0004-edge-first-placement.md) edge-first placement · [0005](../docs/adr/ADR-0005-event-driven-backbone.md) event backbone.

## Open risks / landmines (carry forward)
- None recorded yet beyond the standing risk register in [ROADMAP](ROADMAP.md) and section-level tradeoffs. Add anything you hit here so the next agent doesn't rediscover it.

## Changelog
- `[Architecture · 2026-07-26]` Harvested remaining implementation detail from the legacy analyses into three professional reference docs — [DEV-ENVIRONMENT](../docs/reference/DEV-ENVIRONMENT.md), [HARDWARE-SIZING](../docs/reference/HARDWARE-SIZING.md), [MODEL-REFERENCE](../docs/reference/MODEL-REFERENCE.md) — then archived the legacy folder to [`../docs/_archive/`](../docs/_archive/) (frozen provenance; not authoritative). Added root `.gitignore`. `docs/` is now the complete single source of truth.
- `[Architecture · 2026-07-26]` Ratified architecture v1.0: merged three prior analyses (Fable/Grok/Gemini) into the Engineering Constitution + 21 architecture sections + reference + 5 ADRs; created the tracking system and self-documenting repo skeleton. Prior analyses moved to "superseded / provenance." Phase 0 opened.
