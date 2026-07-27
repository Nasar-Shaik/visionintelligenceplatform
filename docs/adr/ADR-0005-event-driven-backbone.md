# ADR-0005 — Durable event backbone as the primary coupling

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Architecture
- **Touches:** Law 3, Law 4; docs/architecture/04, 07, 09

## Context

For the platform to be extensible without redesign, components must not be synchronously coupled to each other's business logic. New producers/consumers (capabilities, plugins, analytics) must attach without modifying existing ones.

## Decision

Capabilities and services communicate primarily through a **durable, versioned event backbone** (Kafka/Redpanda in cloud; embedded log at edge). Synchronous gRPC/REST is reserved for queries/commands, never to couple two capabilities' business logic. Delivery is at-least-once; consumers are idempotent; services emit via the outbox pattern; the log supports replay.

## Alternatives considered

- **Synchronous service mesh calls between capabilities.** Simple call graph; but tight coupling, cascading failures, and no replay/extensibility. Rejected.
- **Direct DB sharing between services.** Convenient short-term; destroys boundaries and isolation. Rejected.

## Consequences

- Positive: extensibility without redesign; replay enables safe rule/analytics evolution; failure isolation; natural fan-out.
- Negative/cost: eventual consistency; must handle idempotency, ordering (per-tenant/camera partitions), and consumer lag; ops of a streaming platform.
- Follow-ups: correlation IDs propagate for tracing; dedup/correlation happen before rules to prevent alert storms.

## Compliance

Implements Law 3 (event-driven) and supports Law 4 (contract-first event schemas). Underpins docs/architecture/09.
