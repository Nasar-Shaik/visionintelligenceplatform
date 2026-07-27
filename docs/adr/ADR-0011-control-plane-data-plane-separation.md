# ADR-0011 — Explicit Control Plane / Data Plane separation

- **Status:** Accepted
- **Date:** 2026-07-27
- **Deciders:** Final Architecture Enhancement (v1.0)
- **Touches:** Principles 1, 8, 9, 11; docs/architecture/27, 04

## Context

[04](../architecture/04-SYSTEM-OVERVIEW.md) introduced planes informally. For enterprise scale, availability, and residency we must **formally separate business management (Control Plane) from video/AI processing (Data Plane)** so they scale, fail, deploy, and are secured independently — and so the Data Plane can run at the edge, offline, while the Control Plane stays cloud-managed.

## Decision

Formalize two planes ([27](../architecture/27-CONTROL-DATA-PLANE.md)). **Control Plane** owns tenancy, identity, authZ, org, subscription, billing, licensing, fleet, configuration, policy, audit, monitoring, deployment, feature flags, secrets, and the API gateway. **Data Plane** owns camera/streaming/recording, inference, tracking, capabilities, composition, events, rules, workflow, evidence, notification, analytics, and the AI runtime. Planes communicate only via **published contracts + events**; the Data Plane caches Control-Plane decisions (entitlements/config/policy) and keeps running when the Control Plane is unreachable.

## Alternatives considered

- **Keep planes informal (status quo).** Adequate for small scale; but couples availability of business ops to processing load and complicates residency/edge. Rejected for enterprise.
- **Single deployable.** Simplest ops; but no independent scaling/failure isolation, and no clean edge story. Rejected.

## Consequences

- Positive: independent scaling and failure isolation; Data Plane autonomy at edge/offline; clear residency boundary (Data Plane regional).
- Negative/cost: a synchronization contract (config/policy/entitlement push + cache) and dual deployment topologies to test.
- Follow-ups: [27](../architecture/27-CONTROL-DATA-PLANE.md) created; [04](../architecture/04-SYSTEM-OVERVIEW.md) cross-links it; edge already caches last-known-good ([14](../architecture/14-EDGE-PLATFORM.md)).

## Compliance

Formalizes existing planes; preserves multi-tenant, edge-first, cloud-native principles unchanged.
