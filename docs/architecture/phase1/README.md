# Phase 1 — Core Platform · Architectural Blueprint

> **Status: PLANNING — awaiting Architect approval. No Phase 1 code is written until these documents are approved.**
>
> Architecture is frozen v1.0 ([sections 01–28](../)); Phase 1 _implements a vertical slice_ of it. These docs are the blueprint every Phase 1 slice builds against.

## 1. Phase objectives

Deliver the **first end-to-end vertical**: a camera is onboarded by a tenant, its RTSP stream is ingested and decoded, an AI capability produces detections, those become normalized events, a rule matches, and an **alert is raised and delivered** — all **multi-tenant, isolated, observable, and tested**.

The guiding outcome: **"a tenant adds a camera and receives an alert when the platform sees something."**

## 2. Scope

**In scope (the 8 slices):**

| Slice | Subsystem                                 | Blueprint                                                                                    |
| ----- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| P1-1  | Tenant foundation + fail-closed isolation | [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md)                                                |
| P1-2  | Authentication + authorization            | [AUTHENTICATION](AUTHENTICATION.md)                                                          |
| P1-3  | Camera registry + org hierarchy           | [CAMERA_ARCHITECTURE](CAMERA_ARCHITECTURE.md)                                                |
| P1-4  | RTSP ingestion + recording                | [INGESTION_PIPELINE](INGESTION_PIPELINE.md), [STORAGE_ARCHITECTURE](STORAGE_ARCHITECTURE.md) |
| P1-5  | Event pipeline                            | [EVENT_PIPELINE](EVENT_PIPELINE.md)                                                          |
| P1-6  | AI inference (capability runtime)         | [AI_PIPELINE](AI_PIPELINE.md)                                                                |
| P1-7  | Rule engine                               | [RULE_ENGINE](RULE_ENGINE.md)                                                                |
| P1-8  | Alert engine                              | [ALERT_ENGINE](ALERT_ENGINE.md)                                                              |
| —     | Cross-cutting                             | [OBSERVABILITY](OBSERVABILITY.md)                                                            |

**Out of scope (deferred):** billing/metering, full entitlements, hash-chained audit, connector platform, industry packs, digital twin, analytics/search, multi-region, edge-fleet scale. These are Phases 2–4 ([PROJECT_ROADMAP](../../project/PROJECT_ROADMAP.md)).

**Simplification for Phase 1 (one honest cut):** run **one capability** (person/object detection) and **one notification channel** (e.g. email/webhook) end-to-end, rather than the full catalog. Breadth is added once the spine is proven.

## 3. Success criteria

1. A tenant + user can authenticate; every request carries a validated tenant context.
2. **Cross-tenant access is impossible** — the isolation test suite passes on every data path (fail-closed).
3. A camera can be onboarded under an org hierarchy; its RTSP stream connects and decodes.
4. Frames flow to a capability; detections are produced and normalized into events on NATS.
5. A rule evaluates events and raises an incident; an alert is delivered on one channel.
6. Every service exposes `/health` `/ready` `/metrics`; the flow is traceable end-to-end by correlation id.
7. CI green (build/test/lint/scan/import-graph/contracts) incl. new integration + isolation tests.

## 4. Deliverables

- New services (per [23-SERVICE-OWNERSHIP](../23-SERVICE-OWNERSHIP.md)): `tenant`, `gateway`, `camera`(inventory), `media`, `pipeline`, `events`, `rules`, `workflow`(alerts), `notify`; Python `inference` capability.
- New shared packages: `@vip/permissions`, `@vip/tenancy` (data-layer guard), event/camera/rule contracts in `@vip/contracts`.
- Integration + **cross-tenant isolation** test suites; per-slice scenario docs.
- Updated governance trackers + per-slice reviews.

## 5. Dependencies on Phase 0

| Phase 0 asset                      | Used by Phase 1 for                                      |
| ---------------------------------- | -------------------------------------------------------- |
| `@vip/contracts`                   | all event/API/capability/tenant schemas (contract-first) |
| `@vip/config`                      | every service's typed config (no `process.env` reads)    |
| `services/identity` template       | the shape every new service is scaffolded from           |
| CI + `check:imports`               | boundary enforcement as services multiply                |
| Dev stack (Mongo/Redis/MinIO/NATS) | tenant data, cache, evidence, event backbone             |
| MLOps registry (MLflow/DVC)        | the model the inference capability binds by selector     |

## 6. Estimated implementation order (high level)

```text
M1 Access      → P1-1 Tenant → P1-2 Auth
M2 Ingestion   → P1-3 Camera → P1-4 RTSP Ingestion
M3 Perception  → P1-6 AI Inference → P1-5 Event Pipeline
M4 Response    → P1-7 Rule Engine → P1-8 Alerts
(Observability + Storage are cross-cutting, wired from M1 onward)
```

Full detail: [ROADMAP](ROADMAP.md) · sequencing rationale: [IMPLEMENTATION_ORDER](IMPLEMENTATION_ORDER.md) · what-blocks-what: [DEPENDENCY_GRAPH](DEPENDENCY_GRAPH.md) · exit gates: [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md).

## 7. Document index

| Doc                                             | Subsystem                            |
| ----------------------------------------------- | ------------------------------------ |
| [ROADMAP](ROADMAP.md)                           | milestones, slices, per-slice detail |
| [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md)   | multi-tenancy end-to-end             |
| [AUTHENTICATION](AUTHENTICATION.md)             | authN/authZ                          |
| [CAMERA_ARCHITECTURE](CAMERA_ARCHITECTURE.md)   | camera + org hierarchy               |
| [INGESTION_PIPELINE](INGESTION_PIPELINE.md)     | RTSP → frames                        |
| [STORAGE_ARCHITECTURE](STORAGE_ARCHITECTURE.md) | Mongo/Redis/MinIO strategy           |
| [AI_PIPELINE](AI_PIPELINE.md)                   | capability inference runtime         |
| [EVENT_PIPELINE](EVENT_PIPELINE.md)             | event ingest/correlate/persist       |
| [RULE_ENGINE](RULE_ENGINE.md)                   | rule evaluation                      |
| [ALERT_ENGINE](ALERT_ENGINE.md)                 | incidents + notification             |
| [OBSERVABILITY](OBSERVABILITY.md)               | logs/metrics/traces/health           |
| [DEPENDENCY_GRAPH](DEPENDENCY_GRAPH.md)         | phase→module graph + parallelization |
| [IMPLEMENTATION_ORDER](IMPLEMENTATION_ORDER.md) | first-to-last sequence               |
| [DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)     | per-milestone exit criteria          |
