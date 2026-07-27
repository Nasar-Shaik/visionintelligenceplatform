# 09 — Event Platform

> One of the most important sections. The event backbone is the seam that makes the platform extensible without redesign.

## Purpose
Define the taxonomy, catalog, lifecycle, correlation, deduplication, aggregation, storage, replay, streaming and timeline of **events** — the normalized currency the entire platform trades in. Operationalizes Law 3 (event-driven).

## Responsibilities
- Define a versioned **event taxonomy** and machine-readable **event catalog**.
- Ingest capability outputs, normalize, deduplicate, correlate, aggregate, prioritize, persist, stream and replay events.
- Provide the **timeline** and the substrate for rules, workflows, analytics and search.

---

## 1. Event taxonomy

Events are namespaced, versioned, hierarchical, and **domain-neutral** (no industry meaning — meaning is assigned by rules):

```
<domain>.<subject>.<predicate>          e.g.  perception.person.detected
                                              spatial.zone.entered
                                              spatial.line.crossed
                                              temporal.dwell.exceeded
                                              object.left-behind
                                              object.removed
                                              attribute.ppe.missing
                                              recognition.face.matched
                                              recognition.plate.read
                                              audio.aggression.detected
                                              anomaly.motion.detected
                                              incident.raised
                                              workflow.escalated
                                              device.camera.offline
```

**Event envelope (versioned schema in `packages/contracts`):**
```json
{
  "id": "uuid", "type": "spatial.line.crossed", "schemaVersion": "1.2.0",
  "tenantId": "…", "branchId": "…", "siteId": "…", "cameraId": "…", "zoneId": "…",
  "occurredAt": "iso8601", "ingestedAt": "iso8601",
  "producer": {"capability": "spatial.line-crossing", "capabilityVersion": "2.1.0", "modelVersion": "…"},
  "confidence": 0.94,
  "subjects": [{"trackId": "…", "class": "person", "bbox": [..], "attributes": {..}}],
  "correlationId": "…", "causationId": "…",
  "payload": { /* type-specific, additive-only */ },
  "evidenceRefs": ["snapshot://…"], "priority": "…"
}
```

## 2. Event catalog

A **machine-readable catalog** (`packages/contracts/events/`) lists every event type with its schema, producing capability, priority default, and PII classification. It is the discovery surface for rule/workflow authors and plugins. Adding an event type = adding a versioned catalog entry (additive; never repurpose a field). Consumers tolerate unknown additive fields (Postel's law).

## 3. Event lifecycle

```
produced → normalized → deduplicated → correlated → prioritized → persisted
        → streamed (live) → consumed (rules/analytics/search) → [rule match → incident]
        → retained per policy → archived/expired (or legal-hold retained)
```
Raw high-volume detections are **ephemeral** (TTL hours–2 days); semantically meaningful events persist per retention. → [18](18-DATA-ARCHITECTURE.md)

## 4. Priority

Every event has a priority (`critical|high|medium|low|info`), defaulted by catalog and overridable by rule context. Priority drives queue routing, notification latency budgets, retention, and UI surfacing. Safety-critical types (fire/weapon/fall) default `critical` with reserved processing lanes so load-shedding never starves them.

## 5. Correlation, deduplication & aggregation

- **Deduplication**: a person loitering 5 min = **one** event, not 300. Dedup keys (type + subject/track + zone + time-bucket) collapse repeats; `causationId`/`correlationId` link chains.
- **Correlation**: link the same actor across cameras/time (via re-ID and spatiotemporal proximity), and link related event types into a **situation** (e.g. `line.crossed` + `zone.entered` + `dwell.exceeded`). Correlation produces higher-order events consumed by rules.
- **Aggregation**: windowed counts/rates (people-in/out, occupancy, queue length) emitted as aggregate events → analytics read models, without persisting every raw detection.

## 6. Storage

- **Hot events** (recent, queryable) in OLTP (MongoDB) with `tenantId`-leading compound indexes; **embeddings** in a per-tenant vector namespace for semantic search; **aggregates** in time-series/read models; **evidence refs** point to object storage. → [18](18-DATA-ARCHITECTURE.md)
- Retention per plan/policy; safety-critical & legal-hold retained longer; audit stream append-only.

## 7. Streaming

- Durable backbone (**NATS JetStream** cloud; NATS **leaf nodes** at edge — [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md)). Subjects follow the taxonomy and are partitioned by tenant/camera for ordering and scale; at-least-once delivery; idempotent consumers.
- **Live fan-out** to clients via WebSocket rooms (`t:{tenant}:b:{branch}:cam:{camera}`), RBAC/scope enforced per subscription.

## 8. Replay

- The durable log enables **replay**: reprocess historical events through new/updated rules, new correlation logic, or new analytics — essential for testing rule changes, back-filling analytics, and post-incident review. Replay is tenant-scoped and time-ranged, run against a shadow consumer group so it never affects live processing.

## 9. Timeline

- Per camera/site/day, the platform builds an **event timeline**: markers per event, severity coloring, jump-to-evidence, filterable — the day's "highlight reel." Timelines are derived read models over the event store and drive the review UX and evidence navigation. → [12](12-EVIDENCE-MANAGEMENT.md)

## Design decisions
- **Domain-neutral event types** keep the core industry-free (Law 1); meaning lives in rules/plugins.
- **Durable log + replay** turns rule/analytics evolution into a safe, testable operation rather than a risky migration.
- **Dedup/correlate before rules** keeps rule logic simple and cheap and prevents alert storms.

## Advantages
- New producers/consumers attach without touching existing ones → extensibility without redesign.
- Replay makes the platform improvable over its own history.
- One taxonomy powers rules, workflows, analytics, search and audit.

## Tradeoffs
- Operating a durable streaming backbone (partitioning, retention, consumer lag) is real ops work; mitigated by managed streaming in cloud and an embedded log at edge with the same contract.
- Eventual consistency; handled via idempotency + correlation IDs.

## Future expansion
- Complex-event-processing (CEP) operators as first-class; cross-tenant (privacy-preserving) smart-city aggregation; event schemas for new modalities.

## Cross-references
[07-DATA-AND-PIPELINE-FLOWS](07-DATA-AND-PIPELINE-FLOWS.md) · [10-RULE-ENGINE](10-RULE-ENGINE.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [18-DATA-ARCHITECTURE](18-DATA-ARCHITECTURE.md)
