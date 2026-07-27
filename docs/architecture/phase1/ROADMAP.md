# Phase 1 — Implementation Roadmap

> Milestones → slices, each fully specified. One slice at a time; each ends production-ready with governance updated (per [DEVELOPMENT_RULES 18–25](../../ai/DEVELOPMENT_RULES.md)) and awaits approval. Ordering rationale in [IMPLEMENTATION_ORDER](IMPLEMENTATION_ORDER.md).

## Milestones

| #      | Milestone                      | Slices     | Outcome                                                                       |
| ------ | ------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| **M1** | Multi-Tenant Access Foundation | P1-1, P1-2 | Authenticated, isolated, tenant-scoped access to the platform                 |
| **M2** | Camera & Media Ingestion       | P1-3, P1-4 | A tenant's camera is onboarded and its stream is decoded to frames + recorded |
| **M3** | Perception & Event Backbone    | P1-6, P1-5 | Frames → detections → normalized, persisted events                            |
| **M4** | Automation & Response          | P1-7, P1-8 | Events → rule match → incident → delivered alert                              |

Cross-cutting ([STORAGE](STORAGE_ARCHITECTURE.md), [OBSERVABILITY](OBSERVABILITY.md)) is wired from M1 and extended each milestone.

Complexity scale: **S** (≈1 slice-day-equiv, low risk) · **M** · **L** · **XL** (security-critical or new runtime).

---

## M1 — Multi-Tenant Access Foundation

### P1-1 — Tenant foundation + fail-closed isolation

- **Objective:** Establish the tenant as the root of all data + a data-layer guard that makes cross-tenant access structurally impossible.
- **Description:** `tenant` service (create/read tenant, org hierarchy root); `@vip/tenancy` package — a repository/middleware guard that injects and enforces `tenantId` on every query, fail-closed; `TenantContext` contract already exists ([@vip/contracts](../../../packages/contracts/README.md)). Consumes `tenant.created` seed; publishes `tenant.created`.
- **Dependencies:** Phase 0 (`@vip/contracts`, `@vip/config`, identity template, Mongo). None within Phase 1.
- **Complexity:** **L** (security-critical foundation).
- **Risks:** R-010 (isolation is the whole ballgame); a missed query path = cross-tenant leak. Mitigate with the guard + the isolation suite (P1 exit gate).
- **Acceptance criteria:** every persisted record carries `tenantId`; a query without tenant context is rejected; the isolation test suite (baseline) passes; `tenant` service exposes CRUD + health/ready/metrics.
- **Documentation affected:** [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md), [23-SERVICE-OWNERSHIP](../23-SERVICE-OWNERSHIP.md), API_INVENTORY.
- **Testing:** unit (guard), integration (Testcontainers Mongo), **cross-tenant isolation** (fail-closed on every endpoint), contract tests.

### P1-2 — Authentication & authorization

- **Objective:** Authenticate principals and mint the tenant context; authorize actions via RBAC/ABAC through the Policy Engine boundary.
- **Description:** extend `identity` (OIDC/JWT access+refresh with reuse-detection, MFA-ready); `gateway` service validates tokens, resolves tenant context, and forwards it; `@vip/permissions` (roles, permissions `resource:action[:scope]`, ABAC scopes) as a Policy Decision Point stub ([28-POLICY-ENGINE](../28-POLICY-ENGINE.md)). Uses `@vip/config` `jwt` group.
- **Dependencies:** P1-1 (tenant context to mint).
- **Complexity:** **L**.
- **Risks:** token/refresh handling is security-sensitive (reuse, expiry, revocation); scope creep into full IdP. Keep MFA/SSO interfaces but implement the core path.
- **Acceptance criteria:** login issues access+refresh; refresh-reuse revokes lineage; gateway rejects unauthenticated/expired; a permission check gates a protected route; tenant context flows from token → downstream.
- **Documentation affected:** [AUTHENTICATION](AUTHENTICATION.md), [15-SECURITY](../15-SECURITY-ARCHITECTURE.md), [28-POLICY-ENGINE](../28-POLICY-ENGINE.md), API_INVENTORY.
- **Testing:** unit (token/permission logic), integration (login→refresh→access), isolation (a user of tenant A cannot act on tenant B), negative auth cases.

---

## M2 — Camera & Media Ingestion

### P1-3 — Camera registry + org hierarchy

- **Objective:** Model the location hierarchy and onboard cameras with vaulted credentials.
- **Description:** `camera` (inventory) service — hierarchy `org→region→country→branch→site→building→floor→zone→camera` CRUD; camera onboarding (manual RTSP/RTMP; ONVIF discovery interface stubbed); capture profile; camera health status. Credentials stored encrypted at rest (app-level; no external vault, per [ADR-0018](../../adr/ADR-0018-env-only-secrets-and-centralized-config.md)). Publishes `camera.registered`, `camera.updated`.
- **Dependencies:** P1-1 (tenant scoping), P1-2 (authz to manage cameras).
- **Complexity:** **M**.
- **Risks:** hierarchy modeling churn; credential-at-rest handling. Keep the tree generic; encrypt credential fields.
- **Acceptance criteria:** a tenant creates a hierarchy and adds a camera; camera is tenant + zone scoped; `camera.registered` is emitted; credentials are never returned in plaintext.
- **Documentation affected:** [CAMERA_ARCHITECTURE](CAMERA_ARCHITECTURE.md), [22-BOUNDED-CONTEXTS](../22-BOUNDED-CONTEXTS.md), API_INVENTORY.
- **Testing:** unit (hierarchy invariants), integration (CRUD + events), isolation (cameras never cross tenants).

### P1-4 — RTSP ingestion + recording

- **Objective:** Connect to a camera's RTSP stream, decode it, extract frames, and record to object storage.
- **Description:** `media` service — RTSP connect (ffmpeg/GStreamer), decode, frame extraction at a configurable rate, ring-buffer + recording to MinIO (`{tenantId}/{cameraId}/…`), auto-reconnect/health heartbeat. Publishes `media.stream.connected|lost`, exposes frames to the pipeline. A local RTSP test source is added to the dev stack.
- **Dependencies:** P1-3 (camera to connect to), [STORAGE](STORAGE_ARCHITECTURE.md).
- **Complexity:** **L** (media/codecs, resource-bound).
- **Risks:** codec/transport variability; back-pressure; GPU/CPU decode cost. Scope to H.264 RTSP first; per-stream worker.
- **Acceptance criteria:** given a camera, the stream connects and frames are produced; a recording lands in MinIO under the tenant prefix; connection loss triggers reconnect + event.
- **Documentation affected:** [INGESTION_PIPELINE](INGESTION_PIPELINE.md), [STORAGE_ARCHITECTURE](STORAGE_ARCHITECTURE.md), [07-DATA-AND-PIPELINE-FLOWS](../07-DATA-AND-PIPELINE-FLOWS.md).
- **Testing:** integration against the RTSP test source; recording-in-storage assertion; reconnect scenario; isolation of storage prefixes.

---

## M3 — Perception & Event Backbone

### P1-6 — AI inference (capability runtime)

- **Objective:** Run one model-agnostic capability over frames and produce detections.
- **Description:** Python `inference` capability implementing the capability contract ([05-CAPABILITY-ARCHITECTURE](../05-CAPABILITY-ARCHITECTURE.md)): `descriptor + init/process/health/dispose`; binds a model by **selector** from the registry ([08 §8a](../08-AI-ML-PLATFORM.md), MLflow); one capability (person/object detection). Emits normalized capability outputs. Runs against frames from `media`.
- **Dependencies:** P1-4 (frames), Phase 0 MLOps registry (model artifact), `ai/mlops` config.
- **Complexity:** **XL** (new Python runtime, GPU/CPU, model binding).
- **Risks:** model packaging/export; latency; selector→artifact resolution. Start CPU/ONNX, one model, batch=1.
- **Acceptance criteria:** a frame in → a detection out with confidence + bbox conforming to the contract; the capability self-describes; model is bound by selector (swap without code change).
- **Documentation affected:** [AI_PIPELINE](AI_PIPELINE.md), [05-CAPABILITY-ARCHITECTURE](../05-CAPABILITY-ARCHITECTURE.md), [08-AI-ML-PLATFORM](../08-AI-ML-PLATFORM.md).
- **Testing:** unit (pre/post-processing), contract (descriptor + output schema), integration (frame→detection), model-CI gate (benchmark) skeleton.

### P1-5 — Event pipeline

- **Objective:** Turn capability outputs into normalized, correlated, deduplicated, persisted events on the backbone.
- **Description:** `events` service — consume capability outputs, normalize to the `EventEnvelope` contract ([09-EVENT-PLATFORM](../09-EVENT-PLATFORM.md), already in `@vip/contracts`), correlate/dedup, persist (Mongo), publish `event.persisted`, support replay. NATS JetStream ([ADR-0016](../../adr/ADR-0016-nats-jetstream-event-backbone.md)) with tenant-scoped subjects.
- **Dependencies:** P1-6 (produces the outputs), P1-1 (tenant subjects/records).
- **Complexity:** **L**.
- **Risks:** ordering/idempotency; dedup correctness; per-tenant subject isolation. At-least-once + idempotent consumers.
- **Acceptance criteria:** a detection becomes a persisted `EventEnvelope` with `tenantId`; duplicates collapse; `event.persisted` is published; replay reproduces state.
- **Documentation affected:** [EVENT_PIPELINE](EVENT_PIPELINE.md), [09-EVENT-PLATFORM](../09-EVENT-PLATFORM.md), [18-DATA-ARCHITECTURE](../18-DATA-ARCHITECTURE.md).
- **Testing:** unit (normalize/dedup), integration (NATS + Mongo via Testcontainers), isolation (no cross-tenant subject/read), replay test.

---

## M4 — Automation & Response

### P1-7 — Rule engine

- **Objective:** Evaluate rules over events and raise incident candidates.
- **Description:** `rules` service — sandboxed rule DSL over `event.persisted` + aggregates; versioning; dry-run; rule packs (interface). Consumes `event.persisted`; publishes `incident.candidate`, `rule.matched`. Tenant-scoped rule state in Redis ([10-RULE-ENGINE](../10-RULE-ENGINE.md)).
- **Dependencies:** P1-5 (events to evaluate).
- **Complexity:** **L**.
- **Risks:** DSL safety (sandbox), deterministic replay, state bounds. Start with a minimal, sandboxed condition set.
- **Acceptance criteria:** a rule matches an event and emits `incident.candidate`; dry-run evaluates without side effects; rule changes are versioned + audited; evaluation is tenant-scoped.
- **Documentation affected:** [RULE_ENGINE](RULE_ENGINE.md), [10-RULE-ENGINE](../10-RULE-ENGINE.md), [28-POLICY-ENGINE](../28-POLICY-ENGINE.md).
- **Testing:** unit (evaluation + sandbox), integration (event→match), replay determinism, isolation.

### P1-8 — Alert engine

- **Objective:** Turn incident candidates into managed incidents and deliver alerts.
- **Description:** `workflow` service (incident lifecycle: candidate→raised→ack→resolved, escalation) + `notify` service (one channel first: email/webhook; multi-channel interface). Consumes `incident.candidate`/`rule.matched`; publishes `incident.raised`, delivers notifications with ack. Links evidence (clip/snapshot ref from `media`).
- **Dependencies:** P1-7 (candidates), P1-4 (evidence refs), P1-2 (who to notify / authz).
- **Complexity:** **L**.
- **Risks:** delivery reliability (retry/dead-letter), notification storms, dedup of alerts. Retry + dead-letter; per-tenant rate limits.
- **Acceptance criteria:** an `incident.candidate` becomes a raised incident; an alert is delivered on one channel with an ack path; incident state transitions are persisted + tenant-scoped; the **full camera→alert vertical works end-to-end**.
- **Documentation affected:** [ALERT_ENGINE](ALERT_ENGINE.md), [11-WORKFLOW-ENGINE](../11-WORKFLOW-ENGINE.md), [12-EVIDENCE-MANAGEMENT](../12-EVIDENCE-MANAGEMENT.md).
- **Testing:** unit (state machine), integration (candidate→delivery), end-to-end vertical test, failure (channel down → retry/dead-letter), isolation.

---

## Phase 1 exit

All 8 slices Done ([DEFINITION_OF_DONE](DEFINITION_OF_DONE.md)); the **end-to-end vertical demo** passes; the **cross-tenant isolation suite** is green on every path; CI green. Then a Phase 1 exit review opens Phase 2.
