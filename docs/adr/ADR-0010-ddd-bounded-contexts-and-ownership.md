# ADR-0010 — Adopt DDD bounded contexts and explicit service ownership

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Enterprise Architecture Review, Engineering Director
- **Touches:** Principle 2; docs/architecture/22, 23, 04

## Context
The architecture already implies service boundaries ([04](../architecture/04-SYSTEM-OVERVIEW.md)), but for large-team and multi-agent development, boundaries must be **explicit**: which context owns which data, which events it publishes/subscribes to, and who owns each service. Without this, teams/agents accidentally create shared-database coupling and cyclic dependencies over time.

## Decision
Adopt **Domain-Driven Design bounded contexts** as the organizing view ([22](../architecture/22-BOUNDED-CONTEXTS.md)) — each context owns its data and communicates only via published/subscribed events and public APIs — and a **Service Ownership** catalog ([23](../architecture/23-SERVICE-OWNERSHIP.md)) defining, per service, its responsibilities, owned DB, owned APIs, events, dependencies, health, scaling, failure handling, and security responsibilities, plus a **service dependency graph** that must remain acyclic (CI-enforced).

## Alternatives considered
- **Keep boundaries implicit (status quo).** Works at small scale; but erodes as teams/agents grow, leading to shared-DB coupling and cycles. Rejected for the 10-year, many-contributor mandate.
- **Microservice-per-noun immediately.** Maximal isolation; but premature sprawl and ops cost. Rejected — boundaries are defined logically; physical splitting stays a deployment decision.

## Consequences
- Positive: explicit ownership prevents coupling/cycles; clear seams for team/agent assignment; safe independent evolution.
- Negative/cost: two new reference documents to keep current as services land (part of Definition of Done).
- Follow-ups: [22](../architecture/22-BOUNDED-CONTEXTS.md), [23](../architecture/23-SERVICE-OWNERSHIP.md) created; [04](../architecture/04-SYSTEM-OVERVIEW.md) cross-links them; import-graph CI extended to forbid cross-context DB access and cycles.

## Compliance
Formalizes Principle 2 (modular) and the boundary rules in [00 §6](../00-ENGINEERING-CONSTITUTION.md); no philosophy change — it makes existing boundaries explicit and enforceable.
