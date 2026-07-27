# ADR-0017 — Fastify for Control-Plane / TypeScript services

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Development kickoff (implements the Master Development Prompt stack)
- **Touches:** Principle 8; docs/reference/TECH-STACK, docs/architecture/23

## Context
[TECH-STACK](../reference/TECH-STACK.md) named "Node.js + Express" as a placeholder for control/data-plane TypeScript services. The approved implementation stack selects **Fastify**, which offers first-class TypeScript types, JSON-Schema-native validation/serialization (aligning with our schema-first contracts, [03](../architecture/03-ARCHITECTURE-PRINCIPLES.md)), high throughput, and a clean plugin model.

## Decision
Adopt **Fastify + TypeScript** as the framework for all Node/TypeScript services (gateway + control-plane + TS data-plane services). JSON Schema (from `packages/contracts`) drives request/response validation and OpenAPI generation natively. Python vision services remain on **FastAPI** (unchanged, matches the polyglot principle).

## Alternatives considered
- **Express (prior placeholder).** Ubiquitous; but weaker native TS/JSON-Schema story and lower throughput. Rejected.
- **NestJS.** Batteries-included; but heavier/opinionated DI framework we don't need over our own layering. Rejected for now.

## Consequences
- Positive: native schema validation ties directly to contract-first design; strong TS types; performance; plugin model matches our modular services.
- Negative/cost: team familiarity; some ecosystem middleware differs from Express.
- Follow-ups: [TECH-STACK](../reference/TECH-STACK.md) updated; the service template ([23](../architecture/23-SERVICE-OWNERSHIP.md)) and P0-7 scaffold use Fastify.

## Compliance
Framework selection under Principle 8 (cloud-native, 12-factor); no philosophy change. Reinforces Law 4 (contract-first) via JSON-Schema-native validation.
