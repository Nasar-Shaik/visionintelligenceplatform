# CURRENT ARCHITECTURE

> Pointer file — the **canonical** architecture is [`docs/README.md`](../README.md) (sections 00–28 + reference + ADRs). Frozen **v1.0**; change only via [ADR](../adr/). Do not duplicate content here.

## One-glance summary
- **Layers:** `Capability → Composition → Event → Rule → Workflow → Evidence → Dashboard`.
- **Planes:** Control Plane (business) vs Data Plane (video/AI) — [27](../architecture/27-CONTROL-DATA-PLANE.md).
- **Pillars:** Plugins [20](../architecture/20-EXTENSIBILITY.md) · Capability Registry [05 §3](../architecture/05-CAPABILITY-ARCHITECTURE.md) · Policy Engine [28](../architecture/28-POLICY-ENGINE.md) · Config Hierarchy [06 §6](../architecture/06-MULTI-TENANT-SAAS.md) · Connector Platform [25](../architecture/25-CONNECTOR-PLATFORM.md) · Model Adapter Layer [08 §8a](../architecture/08-AI-ML-PLATFORM.md).
- **Backbone:** NATS JetStream ([ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md)). **TS framework:** Fastify ([ADR-0017](../adr/ADR-0017-fastify-control-plane.md)). **Vision:** Python/FastAPI.
- **Freeze gate:** [ARCHITECTURE-READINESS-REVIEW](../ARCHITECTURE-READINESS-REVIEW.md) (Go/No-Go: GO).

Post-freeze architectural changes are logged in [`docs/project/ARCHITECTURE_CHANGES.md`](../project/ARCHITECTURE_CHANGES.md).
