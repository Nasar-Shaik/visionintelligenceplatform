# 04 — System Overview

## Purpose
Provide the logical, physical, component and deployment views of the platform, and define how services communicate. This is the map that ties every other section together.

## Responsibilities
- Describe the planes (edge, control, data, AI, presentation) and their boundaries.
- Define inter-service communication patterns (sync, async, streaming).
- Present deployment topologies (cloud, on-prem, hybrid, edge) as one architecture with different placements.

---

## 1. Logical architecture (planes)

```
┌──────────────────────────── PRESENTATION PLANE ────────────────────────────┐
│  Web console · Admin console · Mobile apps · Public API · Webhooks · SDKs   │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  (API Gateway: authN/Z, tenant routing, rate limit)
┌──────────────────────────── CONTROL PLANE ──────────────────────────────────┐
│  Identity & Tenancy · Entitlements/Feature-flags · Camera/Device mgmt ·      │
│  Rule mgmt · Workflow mgmt · Plugin registry · Model/Dataset registry ·      │
│  Billing/Metering · Config · Fleet mgmt                                      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  events (backbone)  +  contracts (sync)
┌──────────────────────────── DATA / PROCESSING PLANE ─────────────────────────┐
│  Ingestion · Media/Streaming · Frame pipeline · Event Platform ·             │
│  Rule Engine · Workflow Engine · Evidence · Notification · Analytics/Report · │
│  Search                                                                       │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  inference contract
┌──────────────────────────── AI PLANE ────────────────────────────────────────┐
│  Inference runtime · Capability workers (detect/track/pose/OCR/…) ·          │
│  Model serving · Embeddings · MLOps (train/eval/deploy/monitor)              │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                     │  edge↔cloud sync (mTLS, store-and-forward)
┌──────────────────────────── EDGE PLANE ──────────────────────────────────────┐
│  Edge agent · Local media + inference + rules · Ring buffer · Offline store  │
│  ── runs the SAME capability contracts, placed locally ──                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key property:** the Edge Plane and the Data/AI Planes run **the same capability contracts**. "Edge vs cloud" is a **placement decision** for a capability, not a different implementation. This is what makes deploy-anywhere real. → [05](05-CAPABILITY-ARCHITECTURE.md), [14](14-EDGE-PLATFORM.md)

## 2. Physical architecture

- **Region → Availability Zones**: control plane runs multi-AZ; data planes are **regional** for residency.
- **Global control plane, regional data planes**: identity/billing/registry are global (or regionally federated); video, events, evidence stay in-region.
- **GPU pools** for cloud inference and training; **CPU pools** for stateless services; **edge boxes** (Jetson/mini-PC/GPU server) on customer premises.
- **Stores**: OLTP (MongoDB, sharded by tenant), cache/queue (Redis), object storage (S3/MinIO/Blob), time-series (analytics), search+vector (event search), all per [18](18-DATA-ARCHITECTURE.md).

## 3. Component view (representative services)

| Plane | Service (dir) | Responsibility |
|---|---|---|
| Control | `services/identity` | Tenants, users, roles, auth, sessions |
| Control | `services/entitlements` | Plans, feature flags, quotas, metering |
| Control | `services/inventory` | Org→…→camera/device hierarchy, zones |
| Control | `services/registry` | Model & dataset registry, plugin registry |
| Control | `services/fleet` | Edge provisioning, health, OTA, config sync |
| Control | `services/billing` | Subscriptions, invoices, usage rollups |
| Data | `services/media` | Ingest, transcode, HLS/WebRTC, recording |
| Data | `services/pipeline` | Frame extraction, capability orchestration |
| Data | `services/events` | Event Platform (ingest, correlate, dedup, store, replay) |
| Data | `services/rules` | Rule Engine evaluation |
| Data | `services/workflow` | Incident/case/escalation orchestration |
| Data | `services/evidence` | Clips, snapshots, timelines, export, retention |
| Data | `services/notify` | Multi-channel notification + escalation delivery |
| Data | `services/analytics` | Aggregation, read models, reports |
| Data | `services/search` | Structured + semantic/NL event search |
| AI | `ai/inference` | Model-agnostic inference runtime + workers |
| AI | `ai/mlops` | Training, eval, registry integration, monitoring |
| Edge | `edge/agent` | Local runtime, sync, offline, OTA client |
| Presentation | `services/gateway` | API gateway, authN/Z, tenant routing, rate limit |

Services are logical; several may co-deploy in small footprints and split out at scale. Boundaries are defined by **contracts**, so splitting/merging is a deployment choice, not a rewrite.

## 4. Service communication

- **Synchronous (request/response)** — for queries and commands with an immediate answer: **gRPC** service-to-service (Protobuf contracts), **REST/HTTP** at the public edge (OpenAPI), **GraphQL BFF optional** for the console. Used sparingly and never to couple two capabilities' business logic.
- **Asynchronous (events)** — the default for anything reactive: a durable **event backbone** (Kafka/Redpanda in cloud; embedded log at edge) carrying versioned events. Capabilities publish/subscribe; they do not call each other. Delivery is at-least-once; consumers are idempotent. → [09](09-EVENT-PLATFORM.md)
- **Streaming (media)** — RTSP/RTMP ingest; **WebRTC** for low-latency live; **HLS** for scalable playback; all media URLs are short-lived signed tokens. → [07](07-DATA-AND-PIPELINE-FLOWS.md)
- **Edge↔cloud** — mutual-TLS, store-and-forward sync of events/evidence/health; config and model OTA pulled by the edge. → [14](14-EDGE-PLATFORM.md)
- **Outbox pattern** for reliable event emission from services that also write OLTP (no dual-write races).

## 5. Deployment topologies (one architecture, four placements)

| Mode | Placement | Notes |
|---|---|---|
| **Cloud** | All planes in cloud; camera streams relayed to cloud GPU workers | Simplest; higher bandwidth/cloud-GPU cost |
| **Edge-first hybrid (default)** | Ingestion + real-time inference + rules at edge; control/heavy/batch/analytics in cloud | Best cost/latency/privacy |
| **On-prem** | All planes on customer infrastructure; optional air-gapped license server | Regulated/data-residency customers |
| **Edge-only / offline** | Edge box runs full pipeline autonomously; syncs opportunistically | Remote sites, WAN-poor, privacy-max |

Deployment mode changes **configuration and capability placement**, not code. → [14](14-EDGE-PLATFORM.md), [17](17-DEVOPS-AND-INFRA.md)

## Design decisions
- **Plane separation** keeps control-plane availability independent of data-plane load and lets regions own their data.
- **Contracts as boundaries** make the split between services a deployment/scale decision, avoiding premature microservice sprawl while preserving the option.
- **Events as the default coupling** is what enables extensibility without redesign.

## Advantages
- Independent scaling and failure isolation per plane/service.
- Same mental model at every deployment size; footprint scales by co-deploying or splitting services.

## Tradeoffs
- Distributed system complexity (eventual consistency, idempotency, tracing). Mitigated by the outbox pattern, correlation IDs, and mandatory observability.

## Future expansion
- Additional planes/services (e.g., a dedicated "sensor-fusion" service) slot in behind contracts.
- Multi-region active-active control plane; regional search federation.

## Cross-references
[05-CAPABILITY-ARCHITECTURE](05-CAPABILITY-ARCHITECTURE.md) · [07-DATA-AND-PIPELINE-FLOWS](07-DATA-AND-PIPELINE-FLOWS.md) · [14-EDGE-PLATFORM](14-EDGE-PLATFORM.md) · [17-DEVOPS-AND-INFRA](17-DEVOPS-AND-INFRA.md)
