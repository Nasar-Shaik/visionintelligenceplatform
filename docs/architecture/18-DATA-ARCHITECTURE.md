# 18 — Data Architecture

## Purpose
Define the data stores, their roles, schema conventions, indexing, retention, archival, and tiering. One store per workload; `tenantId` everywhere.

## Responsibilities
- Choose and bound each datastore by workload; define isolation, indexing, retention, and cold storage.

---

## 1. Store selection (polyglot persistence, by workload)

| Store | Technology | Holds | Why |
|---|---|---|---|
| **OLTP** | **MongoDB** (sharded by `tenantId`) | Orgs, cameras, events, incidents, rules, workflows, evidence metadata | Flexible schema for evolving event/attribute shapes; horizontal sharding |
| **Cache / state / queue** | **Redis** (cluster) | Sessions, entitlements cache, rule state (dwell/sequence/cooldown), rate limits, ephemeral coordination | Low-latency stateful ops |
| **Event backbone** | **NATS JetStream** (cloud) · NATS leaf nodes (edge) | Durable event stream, replay | Replayable, subject-routed, edge-first ([ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md)) |
| **Object storage** | **S3 / MinIO / Blob** | Clips, snapshots, model artifacts, dataset artifacts, exports | Cheap, tiered, signed URLs |
| **Time-series** | TS store (e.g. Timescale/Influx/Mongo TS) | Aggregates: footfall, occupancy, counts, heatmaps, metrics | Efficient windowed analytics |
| **Search + vector** | Search engine + **vector DB** (Qdrant/Milvus/Atlas Vector) | Event text/metadata search + CLIP/caption embeddings (per-tenant namespace) | Structured + semantic/NL search |
| **Cold / archive** | Object-storage archive tier | Aged evidence, long-term audit | Retention at low cost |

## 2. Schema conventions
- Every document: `_id, tenantId, createdAt, updatedAt, createdBy, isDeleted, schemaVersion`; operational docs also carry `branchId/siteId/cameraId`.
- **Compound indexes lead with `tenantId`.** Access without tenant context throws at the repository layer.
- Contracts (`packages/contracts`) define document/event schemas; DB models are generated/validated against them.

## 3. Representative indexes
```js
events.createIndex({ tenantId:1, cameraId:1, type:1, occurredAt:-1 })
events.createIndex({ tenantId:1, branchId:1, priority:1, occurredAt:-1 })
events.createIndex({ tenantId:1, occurredAt:-1 })                 // timeline/search
detections.createIndex({ occurredAt:1 }, { expireAfterSeconds: 172800 })  // 2-day TTL
incidents.createIndex({ tenantId:1, state:1, occurredAt:-1 })
rules.createIndex({ tenantId:1, scope:1, enabled:1 })
evidence.createIndex({ tenantId:1, cameraId:1, eventId:1 })
evidence.createIndex({ tenantId:1, expiresAt:1 })                 // retention sweep
usageCounters.createIndex({ tenantId:1, metric:1, period:1 })
// eventEmbeddings → vector index (cosine) per-tenant namespace
```

## 4. Retention & archival
- **Raw detections/tracks**: hours–2 days (TTL) — high-volume, ephemeral; only aggregates persist.
- **Events/metadata**: per plan (7/30/90/custom); safety-critical & legal-hold longer.
- **Evidence (clips)**: per plan; hot→cold→archive→delete; legal hold overrides. → [12](12-EVIDENCE-MANAGEMENT.md)
- **Aggregates**: long-lived (small) — power historical trends after raw expires.
- **Audit**: long retention, append-only, immutable. → [15](15-SECURITY-ARCHITECTURE.md)
- Per-camera override; per-tenant residency; `retentionPolicies` drive scheduled sweeps with **verifiable purge**.

## 5. Storage optimization
- **Smart-clip-only** (no continuous cloud recording) → ~90%+ reduction ([12](12-EVIDENCE-MANAGEMENT.md)).
- **Detections aggregated then expired** (store counts/heatmaps, not every box).
- Thumbnails/sprites for fast browse; H.265 transcode; merge overlapping clips.
- **Tiered object storage**; **sharding** by `tenantId` on high-volume collections; **materialized read models** (change streams) for dashboards keep OLTP fast.

## 6. Data residency & isolation
- Regional data planes keep video/events/evidence in-region; per-tenant KMS keys; siloed DB option for enterprise ([06 §2](06-MULTI-TENANT-SAAS.md)).

## Design decisions
- **Polyglot persistence** matches each workload to the right engine instead of forcing one store.
- **Ephemeral raw + durable aggregates/events** is the key to linear storage cost at 10,000 cameras.
- **Vector store per-tenant namespace** enables semantic/NL search with isolation.

## Advantages
- Predictable cost and performance at scale; isolation and residency built into the data layer.

## Tradeoffs
- Multiple stores add operational surface; mitigated by managed services in cloud and a compact bundled stack on edge/on-prem.

## Future expansion
- Data lakehouse for cross-tenant (privacy-preserving) analytics; feature store for MLOps; CDC pipelines; cross-region search federation.

## Cross-references
[06-MULTI-TENANT-SAAS](06-MULTI-TENANT-SAAS.md) · [09-EVENT-PLATFORM](09-EVENT-PLATFORM.md) · [12-EVIDENCE-MANAGEMENT](12-EVIDENCE-MANAGEMENT.md) · [19-PERFORMANCE-AND-SCALE](19-PERFORMANCE-AND-SCALE.md)
