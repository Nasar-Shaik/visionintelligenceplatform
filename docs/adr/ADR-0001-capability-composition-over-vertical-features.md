# ADR-0001 — Capability composition over vertical features

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Architecture (initial ratification)
- **Touches:** Law 1, Law 2; docs/architecture/05, 13

## Context

The prior analyses (Fable/Grok/Gemini, archived under `docs/_archive/`) framed the product around named vertical solutions ("theft detection," "hospital monitoring") and a fixed set of "engines." That framing hardcodes verticals into the core and does not scale to "any industry for 10 years." The mandate is an industry-agnostic platform of reusable building blocks.

## Decision

We will build the system as a set of reusable, model-agnostic **capabilities** composed via **events + rules + workflows + Industry Packs**. The core carries **no** industry or customer logic; verticals are delivered exclusively as declarative plugins.

## Alternatives considered

- **Vertical-first product (prior blueprints).** Fast to a first demo; but every new industry is a code fork and the core rots into a pile of `if industry == …`. Rejected — violates the 10-year mandate.
- **Config-heavy monolith (no plugin isolation).** Some flexibility, but no hard boundary; industry logic leaks into core over time. Rejected — no enforcement.

## Consequences

- Positive: new verticals cost a plugin, not a fork; one capability fix benefits all verticals; testable generic core.
- Negative/cost: up-front investment in capability contracts, a registry, an orchestrator, and rich declarative surfaces (rules/workflows/dashboards as data).
- Follow-ups: CI import-graph checks enforce no core→plugin dependency; "delete all plugins → core still builds/tests" is a standing gate.

## Compliance

Directly implements Laws 1 and 2. All subsequent design assumes this decision.
