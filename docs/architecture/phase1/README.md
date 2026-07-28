# Phase 1 — Core Platform · Architecture

> **Navigation page for Phase 1.** Architecture is frozen v1.0 ([sections 01–28](../)); Phase 1 _implements a vertical slice_ of it. Live status is in the tracker, not here — see [MASTER_PROGRESS](../../tracker/MASTER_PROGRESS.md).

## Objective

Deliver the **first end-to-end vertical**: a tenant onboards a camera, its RTSP stream is ingested and decoded, an AI capability produces detections, those become normalized events, a rule matches, and an **alert is raised and delivered** — all **multi-tenant, isolated, observable, and tested**.

> Guiding outcome: **"a tenant adds a camera and receives an alert when the platform sees something."**

**One honest simplification:** run **one capability** (person/object detection) and **one notification channel** (email/webhook) end-to-end, rather than the full catalog. Breadth is added once the spine is proven.

**Out of scope (Phases 2–4, see [PROJECT_ROADMAP](../../project/PROJECT_ROADMAP.md)):** billing/metering, full entitlements, hash-chained audit, connector platform, industry packs, digital twin, analytics/search, multi-region, edge-fleet scale.

## Milestones

| #      | Milestone                      | Slices     | Outcome                                                           |
| ------ | ------------------------------ | ---------- | ----------------------------------------------------------------- |
| **M1** | Multi-Tenant Access Foundation | P1-1, P1-2 | Authenticated, isolated, tenant-scoped access                     |
| **M2** | Camera & Media Ingestion       | P1-3, P1-4 | A camera is onboarded; its stream is decoded to frames + recorded |
| **M3** | Perception & Event Backbone    | P1-6, P1-5 | Frames → detections → normalized, persisted events                |
| **M4** | Automation & Response          | P1-7, P1-8 | Events → rule match → incident → delivered alert                  |

Storage and Observability are **cross-cutting**, wired from M1 and extended each milestone.

## Implementation order

One slice at a time, approval between slices. Security first (isolation → auth), then the data flows in its natural direction so each step consumes the previous step's _real_ output — integration is proven continuously, and the first sellable increment (an alert from a camera) arrives at the last step.

```text
Step 0  Contracts + shared modules   @vip/contracts (extend) · @vip/tenancy · @vip/permissions
M1      P1-1 Tenant  →  P1-2 Auth
M2      P1-3 Camera  →  P1-4 RTSP Ingestion
M3      P1-6 AI Inference  →  P1-5 Event Pipeline
M4      P1-7 Rule Engine  →  P1-8 Alerts
```

Per-slice objectives, dependencies, acceptance criteria, and the dependency graph are in [ROADMAP](ROADMAP.md). Every slice is **contract-first**: extend `@vip/contracts` → generate types → implement producers/consumers → test. A consumer is never built before its contract exists.

**Critical path to the demo:** P1-1 → P1-2 → P1-3 → P1-4 → P1-6 → P1-5 → P1-7 → P1-8. Once P1-1 is merged, `@vip/permissions`, the camera model, the RTSP decode spike, the `inference` skeleton, and downstream contracts can be authored in parallel (details in [ROADMAP § Sequencing](ROADMAP.md#sequencing--parallelization)).

## Current progress

Tracked in [MASTER_PROGRESS](../../tracker/MASTER_PROGRESS.md) (phase/milestone/slice status, blockers, next slice). Per-slice reviews in [REVIEW_HISTORY](../../tracker/REVIEW_HISTORY.md).

## Exit criteria

Phase 1 is complete when **all 8 slices are Done** ([per-milestone exit in ROADMAP](ROADMAP.md)) and:

1. A tenant + user authenticate; every request carries a validated `TenantContext`.
2. **Cross-tenant access is impossible** — the isolation suite is green on every endpoint, subject, key, and object prefix (fail-closed).
3. A camera is onboarded under an org hierarchy; its RTSP stream connects and decodes.
4. Frames flow to a capability; detections are normalized into persisted events on NATS.
5. A rule raises an incident; an alert is delivered on one channel with an ack path.
6. Every service exposes `/health` `/ready` `/metrics`; the whole path is traceable by one correlation id.
7. CI green (build/test/lint/scan/import-graph/contracts) incl. integration + isolation + **end-to-end vertical** tests.

The **end-to-end demo** (a tenant adds a camera and receives an alert, one continuous traced path) passing, plus a Phase 1 exit review, opens Phase 2.

## Dependencies on Phase 0

| Phase 0 asset                      | Used by Phase 1 for                                      |
| ---------------------------------- | -------------------------------------------------------- |
| `@vip/contracts`                   | all event/API/capability/tenant schemas (contract-first) |
| `@vip/config`                      | every service's typed config (no `process.env` reads)    |
| `services/identity` template       | the shape every new service is scaffolded from           |
| CI + `check:imports`               | boundary enforcement as services multiply                |
| Dev stack (Mongo/Redis/MinIO/NATS) | tenant data, cache, evidence, event backbone             |
| MLOps registry (MLflow/DVC)        | the model the inference capability binds by selector     |

## Document index

**This directory (design blueprints):**

| Doc                                             | Subsystem                                               | Slice |
| ----------------------------------------------- | ------------------------------------------------------- | ----- |
| [ROADMAP](ROADMAP.md)                           | milestones, per-slice detail, sequencing, exit criteria | all   |
| [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md)   | multi-tenancy end-to-end (security spine)               | P1-1  |
| [AUTHENTICATION](AUTHENTICATION.md)             | authN/authZ                                             | P1-2  |
| [CAMERA_ARCHITECTURE](CAMERA_ARCHITECTURE.md)   | camera + org hierarchy                                  | P1-3  |
| [INGESTION_PIPELINE](INGESTION_PIPELINE.md)     | RTSP → frames                                           | P1-4  |
| [STORAGE_ARCHITECTURE](STORAGE_ARCHITECTURE.md) | Mongo/Redis/MinIO strategy (cross-cutting)              | P1-4  |
| [AI_PIPELINE](AI_PIPELINE.md)                   | capability inference runtime                            | P1-6  |
| [EVENT_PIPELINE](EVENT_PIPELINE.md)             | event ingest/correlate/persist                          | P1-5  |
| [RULE_ENGINE](RULE_ENGINE.md)                   | rule evaluation                                         | P1-7  |
| [ALERT_ENGINE](ALERT_ENGINE.md)                 | incidents + notification                                | P1-8  |
| [OBSERVABILITY](OBSERVABILITY.md)               | logs/metrics/traces/health (cross-cutting)              | all   |

**Related:** frozen architecture [01–28](../) · governance [docs/project/](../../project/) · tracker [docs/tracker/](../../tracker/MASTER_PROGRESS.md).
