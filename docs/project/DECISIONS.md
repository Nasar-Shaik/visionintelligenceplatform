# DECISIONS

> Canonical decisions of record: [`docs/adr/`](../adr/) (index + individual ADRs). This is a quick reference; the ADRs are authoritative.

| ADR                                                                      | Decision                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| [0001](../adr/ADR-0001-capability-composition-over-vertical-features.md) | Capability composition over vertical features     |
| [0002](../adr/ADR-0002-model-agnostic-inference.md)                      | Model-agnostic inference via registry selectors   |
| [0003](../adr/ADR-0003-tenant-isolation-strategy.md)                     | Pooled-default / siloed-optional tenant isolation |
| [0004](../adr/ADR-0004-edge-first-placement.md)                          | Edge-first capability placement, one codebase     |
| [0005](../adr/ADR-0005-event-driven-backbone.md)                         | Durable event backbone as primary coupling        |
| [0006](../adr/ADR-0006-composition-layer.md)                             | Composition Layer                                 |
| [0007](../adr/ADR-0007-models-as-plugins.md)                             | Models as plugins / marketplace                   |
| [0008](../adr/ADR-0008-connector-platform.md)                            | Connector Platform                                |
| [0009](../adr/ADR-0009-digital-twin.md)                                  | Digital Twin                                      |
| [0010](../adr/ADR-0010-ddd-bounded-contexts-and-ownership.md)            | DDD bounded contexts + service ownership          |
| [0011](../adr/ADR-0011-control-plane-data-plane-separation.md)           | Control Plane / Data Plane separation             |
| [0012](../adr/ADR-0012-model-adapter-layer.md)                           | Model Adapter Layer                               |
| [0013](../adr/ADR-0013-policy-engine.md)                                 | Policy Engine (distinct from Rule Engine)         |
| [0014](../adr/ADR-0014-configuration-hierarchy.md)                       | Configuration hierarchy inheritance               |
| [0015](../adr/ADR-0015-contract-testing-and-plugin-certification.md)     | Contract testing & plugin certification           |
| [0016](../adr/ADR-0016-nats-jetstream-event-backbone.md)                 | NATS JetStream backbone (resolves ND-1)           |
| [0017](../adr/ADR-0017-fastify-control-plane.md)                         | Fastify for TS services                           |

Post-freeze change log: [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md). New decisions → add an ADR, then a row here.
