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

| #                                                                 | Title                                                            | Status   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| [0001](ADR-0001-capability-composition-over-vertical-features.md) | Capability composition over vertical features                    | Accepted |
| [0002](ADR-0002-model-agnostic-inference.md)                      | Model-agnostic inference via registry selectors                  | Accepted |
| [0003](ADR-0003-tenant-isolation-strategy.md)                     | Pooled-default / siloed-optional tenant isolation                | Accepted |
| [0004](ADR-0004-edge-first-placement.md)                          | Edge-first capability placement, one codebase                    | Accepted |
| [0005](ADR-0005-event-driven-backbone.md)                         | Durable event backbone as the primary coupling                   | Accepted |
| [0006](ADR-0006-composition-layer.md)                             | Introduce a Composition Layer between capabilities and events    | Accepted |
| [0007](ADR-0007-models-as-plugins.md)                             | Models as plugins (model provider extension point + marketplace) | Accepted |
| [0008](ADR-0008-connector-platform.md)                            | Connector Platform for external system integration               | Accepted |
| [0009](ADR-0009-digital-twin.md)                                  | Digital Twin spatial abstraction                                 | Accepted |
| [0010](ADR-0010-ddd-bounded-contexts-and-ownership.md)            | Adopt DDD bounded contexts and explicit service ownership        | Accepted |
| [0011](ADR-0011-control-plane-data-plane-separation.md)           | Explicit Control Plane / Data Plane separation                   | Accepted |
| [0012](ADR-0012-model-adapter-layer.md)                           | Model Adapter Layer between capabilities and models              | Accepted |
| [0013](ADR-0013-policy-engine.md)                                 | Policy Engine (distinct from the Rule Engine)                    | Accepted |
| [0014](ADR-0014-configuration-hierarchy.md)                       | Hierarchical configuration inheritance                           | Accepted |
| [0015](ADR-0015-contract-testing-and-plugin-certification.md)     | Contract testing & plugin certification gate                     | Accepted |
| [0016](ADR-0016-nats-jetstream-event-backbone.md)                 | NATS JetStream as the event backbone & messaging (resolves ND-1) | Accepted |
| [0017](ADR-0017-fastify-control-plane.md)                         | Fastify for Control-Plane / TypeScript services                  | Accepted |

_Add new rows as ADRs are created. Never renumber; never delete._

> ADRs 0006–0010 were produced by the **Enterprise Architecture Review** (2026-07-26). ADRs 0011–0015 were produced by the **Final Architecture Enhancement** (2026-07-27) that froze the architecture as **v1.0**. All are strengthenings that preserve the existing philosophy. **After v1.0 freeze, every architectural change requires a new ADR.**
