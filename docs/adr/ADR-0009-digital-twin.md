# ADR-0009 — Digital Twin spatial abstraction

- **Status:** Accepted
- **Date:** 2026-07-26
- **Deciders:** Enterprise Architecture Review
- **Touches:** Principle 14; docs/architecture/26, 06, 09

## Context

The platform already models a spatial hierarchy (Building→Floor→Zone→Camera). Enterprise buyers increasingly expect a **live spatial model** — a digital twin binding physical space, sensors, tracked objects, and live events for map/floorplan visualization, cross-camera situational awareness, and future 3D/BIM integration. Without a first-class abstraction this would be re-implemented per dashboard/vertical.

## Decision

Define a **Digital Twin** abstraction ([26](../architecture/26-DIGITAL-TWIN.md)): a tenant-scoped spatial model `Building → Floor → Map → Zone → Camera → Sensor → Object → Live Events`, projected from the inventory ([06](../architecture/06-MULTI-TENANT-SAAS.md)) and hydrated by live events/tracks ([09](../architecture/09-EVENT-PLATFORM.md)). It is a **read/projection model** and visualization contract — it introduces no new source of truth and no industry logic; dashboards and packs consume it.

## Alternatives considered

- **Per-dashboard spatial code.** Ships one map fast; but duplicates geometry/state logic and can't support cross-camera reasoning. Rejected.
- **Defer entirely.** Lower near-term cost; but retrofitting a spatial substrate later is expensive and the hierarchy already implies it. Rejected — cheap to define now, expensive later.

## Consequences

- Positive: uniform spatial substrate for visualization, cross-camera correlation, and future 3D/BIM/IoT fusion; industry-neutral.
- Negative/cost: maintaining a live projection (calibration/homography, object placement) and its update path.
- Follow-ups: [26](../architecture/26-DIGITAL-TWIN.md) created; correlation ([09](../architecture/09-EVENT-PLATFORM.md)) and analytics can consume the twin; sensors beyond cameras attach here.

## Compliance

The twin is a projection/read model (Principle 14 extensibility); it adds no source of truth and no vertical logic.
