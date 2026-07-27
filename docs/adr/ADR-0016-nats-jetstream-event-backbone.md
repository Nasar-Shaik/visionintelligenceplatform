# ADR-0016 — NATS JetStream as the event backbone & messaging

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Development kickoff (implements the Master Development Prompt stack)
- **Touches:** Law 3, ADR-0005; docs/reference/TECH-STACK, docs/architecture/09, 18; resolves TASK-BOARD **ND-1**

## Context

[ADR-0005](ADR-0005-event-driven-backbone.md) mandated a durable event backbone but left the concrete technology open (**ND-1**: Kafka vs Redpanda vs cloud-native). The approved implementation stack selects **NATS** (with **JetStream** for durability). NATS fits the platform's edge-first requirement especially well: **leaf nodes** and lightweight embedded operation give the Data Plane a real backbone at the edge with store-and-forward to the cloud, at far lower operational weight than Kafka.

## Decision

Adopt **NATS + JetStream** as the platform event backbone and service messaging. JetStream provides durable, replayable streams (satisfying [09](../architecture/09-EVENT-PLATFORM.md) requirements: durability, at-least-once, consumer groups, replay); subjects map to the event taxonomy (`<domain>.<subject>.<predicate>`); **leaf nodes** run the same backbone at the edge and sync upstream. This resolves ND-1. Request-reply (NATS) covers lightweight internal RPC; heavier typed service calls may still use gRPC where warranted.

## Alternatives considered

- **Kafka/Redpanda (prior placeholder).** Battle-tested, high throughput; but heavier to operate, weaker edge/leaf story, more ops overhead for the edge-first model. Rejected as default.
- **Cloud-managed queue only.** Simple in one cloud; but breaks deploy-anywhere/edge/on-prem parity. Rejected.

## Consequences

- Positive: one lightweight backbone from edge leaf nodes to cloud; durable replayable streams; simpler ops; strong deploy-anywhere fit; ND-1 closed.
- Negative/cost: JetStream stream/consumer sizing and retention tuning; team ramp on NATS semantics; ensure exactly-the-right durability per subject.
- Follow-ups: [TECH-STACK](../reference/TECH-STACK.md) updated; the "Kafka/Redpanda" technology mentions in [09](../architecture/09-EVENT-PLATFORM.md)/[18](../architecture/18-DATA-ARCHITECTURE.md) now read NATS JetStream; dev stack ships a `nats` container.

## Compliance

Implements Law 3 and ADR-0005 (event-driven backbone) — a technology selection, not a philosophy change. Contracts/event catalog are transport-agnostic and unaffected.
