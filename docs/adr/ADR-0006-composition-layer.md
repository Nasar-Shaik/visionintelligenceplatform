# ADR-0006 — Introduce a Composition Layer between capabilities and events

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Enterprise Architecture Review
- **Touches:** Law 2, Law 3; docs/architecture/05, 24, 09; docs/00 §5

## Context

Capabilities ([05](../architecture/05-CAPABILITY-ARCHITECTURE.md)) are atomic (person-detection, tracking, zone). Many verticals need the _same_ mid-level business capabilities — people counting, queue analytics, occupancy, perimeter/intrusion monitoring, safety monitoring — each a small, reusable **composition** of atomic capabilities that emits higher-order events. Today those compositions would be re-expressed in every tenant's rules, duplicating logic and losing reuse. The enterprise review flagged this as the single highest-value addition.

## Decision

Introduce an explicit, reusable **Composition Layer** sitting between raw capabilities and the Event Platform. A **composition** declares required capabilities, generated (higher-order) events, supported rule hooks, outputs, and a reusable API — as a versioned, model-agnostic, tenant-neutral unit. The five-layer composition model becomes six: **Capability → Composition → Event → Rule → Workflow → Industry Pack.** Compositions carry **no** industry identity (Law 1) and communicate only via events/contracts (Law 3).

## Alternatives considered

- **Keep everything in rules.** No new layer; but every tenant re-authors "count people crossing this line," and complex analytics (queue, occupancy) become unwieldy rule graphs. Rejected — destroys reuse.
- **Bake compositions into capabilities.** Fewer moving parts; but conflates atomic perception with business aggregation, bloats capabilities, and breaks single-responsibility. Rejected.

## Consequences

- Positive: business-level building blocks are reused across all verticals; rules get simpler (subscribe to `composition.*` events); analytics standardize.
- Negative/cost: one more layer to design, register, schedule, and version; the capability↔composition dependency graph must be explicit and acyclic.
- Follow-ups: [24-COMPOSITION-FRAMEWORK](../architecture/24-COMPOSITION-FRAMEWORK.md) created; [05](../architecture/05-CAPABILITY-ARCHITECTURE.md) and [00 §5](../00-ENGINEERING-CONSTITUTION.md) updated; compositions register like capabilities and are entitlement-gated.

## Compliance

Preserves the philosophy: compositions are reusable, model-agnostic, industry-neutral, event-driven building blocks — an extension of Law 2, not a change to it.
