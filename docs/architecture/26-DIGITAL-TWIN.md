# 26 — Digital Twin

> Enterprise Architecture Review addition. A live spatial abstraction for visualization and cross-camera reasoning. Ratified by [ADR-0009](../adr/ADR-0009-digital-twin.md).

## Purpose

Provide a first-class, industry-neutral **spatial model** that binds physical space, sensors, tracked objects, and live events — powering map/floorplan visualization, cross-camera situational awareness, and future 3D/BIM/IoT integration — without re-implementing spatial logic per dashboard or vertical.

## Responsibilities

- Define the spatial hierarchy and the live projection that hydrates it.
- Serve a read/query + subscription contract for visualization and reasoning consumers.
- Introduce **no new source of truth** and **no industry logic** — it projects from inventory + events.

---

## 1. The spatial model

```
Building ─▶ Floor ─▶ Map (2D/geo/BIM) ─▶ Zone ─▶ Camera ─▶ Sensor ─▶ Object ─▶ Live Events
```

- **Structure** (Building→Floor→Zone→Camera→Sensor) is projected from the inventory/tenant hierarchy ([06](06-MULTI-TENANT-SAAS.md)) — the twin does not own it.
- **Map** adds spatial geometry: floorplan image / geo-coordinates / (future) BIM model, with camera **calibration/homography** to place detections in real-world space.
- **Object** = a tracked entity (person/vehicle/asset) with a live position, placed via tracking + homography.
- **Live Events** = the twin is continuously hydrated by `event.persisted`, `tracking.*`, and `composition.output.*`, so the spatial state reflects reality in near-real-time.

## 2. What it is (and is not)

- **Is:** a **read/projection model** and a visualization/query contract — a materialized spatial view over existing sources ([09](09-EVENT-PLATFORM.md), [23 Analytics/Event](23-SERVICE-OWNERSHIP.md)).
- **Is not:** a new database of record, and not vertical-specific. A hospital ward and a warehouse aisle are the same primitives (Zone + Cameras + Objects) with different packs consuming them.

## 3. Contract (read + subscribe)

- **Query:** "objects currently in Zone X", "cameras covering Floor 2", "path of track T across cameras", "occupancy heatmap for Building B".
- **Subscribe:** live position/state deltas for a map/floor/zone (WebSocket), scope- and RBAC-filtered.
- **API:** `/twin/buildings/:id`, `/twin/floors/:id/live`, `/twin/zones/:id/objects` (tenant-scoped, entitlement-gated).

## 4. Consumers

- **Visualization:** live map/floorplan walls, "where is everyone now" views, incident replay on the map.
- **Cross-camera correlation:** the Event context's correlation ([09 §5](09-EVENT-PLATFORM.md)) and re-ID use the twin's geometry to link an actor across overlapping cameras.
- **Analytics:** spatial heatmaps/occupancy read from the twin's projection.
- **Industry Packs:** consume the twin for spatial dashboards; they add no spatial code.

## Design decisions

- **Projection, not source of truth** — the twin can be rebuilt from inventory + event replay, so it never becomes a consistency liability.
- **Sensor-agnostic Object model** — non-camera sensors (audio/thermal/radar/IoT via [25](25-CONNECTOR-PLATFORM.md)) place objects/readings on the twin using the same primitives.
- **Industry-neutral primitives** keep it reusable across every vertical (Law 1).

## Advantages

- One spatial substrate for all visualization and cross-camera reasoning; verticals get maps "for free."
- Natural home for future 3D/BIM and multi-sensor fusion.

## Tradeoffs

- Maintaining an accurate live projection needs camera calibration/homography and an efficient update path; scoped to the Digital-Twin context and rebuildable via replay if it drifts.

## Future expansion

- 3D/BIM integration; predictive/prescriptive spatial analytics (flow, congestion); city-scale twins fusing many sites; AR overlays; sensor-fusion (thermal/radar/LiDAR) placement.

## Cross-references

[06-MULTI-TENANT-SAAS](06-MULTI-TENANT-SAAS.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [24-COMPOSITION-FRAMEWORK](24-COMPOSITION-FRAMEWORK.md) · [25-CONNECTOR-PLATFORM](25-CONNECTOR-PLATFORM.md) · [ADR-0009](../adr/ADR-0009-digital-twin.md)
