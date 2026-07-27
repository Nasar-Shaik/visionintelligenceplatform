# Phase 1 — Definition of Done

> Per-milestone exit criteria, layered on the canonical per-slice [DEFINITION_OF_DONE](../../project/DEFINITION_OF_DONE.md). A milestone is Done only when **all its slices** are Done **and** its milestone exit criteria pass. A slice is Done only when it satisfies the canonical checklist (impl · docs · README · unit · integration · scenario · logging · metrics · health · docker · dependency review · security review · **Architecture Review PENDING**).

## Per-milestone criteria

### M1 — Multi-Tenant Access Foundation (P1-1, P1-2)

- [ ] **Code complete:** `tenant` + `gateway` services; `@vip/tenancy` + `@vip/permissions`; `identity` auth extension.
- [ ] **Tests passing:** unit + integration (Testcontainers) + **cross-tenant isolation suite (baseline)** + auth negative cases.
- [ ] **Documentation updated:** [TENANT_ARCHITECTURE](TENANT_ARCHITECTURE.md), [AUTHENTICATION](AUTHENTICATION.md), API_INVENTORY, governance suite.
- [ ] **CI passing:** build/test/lint/scan/import-graph/contracts + isolation tests green.
- [ ] **Architecture validated:** no cross-tenant path exists; `check:imports` 0 violations; boundaries per [23](../23-SERVICE-OWNERSHIP.md).
- [ ] **Exit criteria:** a user authenticates, receives tokens, and every request carries a validated, isolated `TenantContext`; refresh-reuse revokes lineage.

### M2 — Camera & Media Ingestion (P1-3, P1-4)

- [ ] **Code complete:** `camera` (hierarchy + onboarding) + `media` (RTSP decode + recording).
- [ ] **Tests passing:** unit + integration against the RTSP test source + storage-prefix isolation + reconnect scenario.
- [ ] **Documentation updated:** [CAMERA_ARCHITECTURE](CAMERA_ARCHITECTURE.md), [INGESTION_PIPELINE](INGESTION_PIPELINE.md), [STORAGE_ARCHITECTURE](STORAGE_ARCHITECTURE.md).
- [ ] **CI passing** (incl. media integration job).
- [ ] **Architecture validated:** camera events flow to `media`; recordings under `{tenantId}/{cameraId}/…`.
- [ ] **Exit criteria:** a tenant onboards a camera; its stream connects and decodes to frames; a recording lands in tenant-scoped storage; loss triggers reconnect.

### M3 — Perception & Event Backbone (P1-6, P1-5)

- [ ] **Code complete:** `inference` capability (contract impl, selector-bound model) + `events` service.
- [ ] **Tests passing:** capability contract + inference integration (frame→detection) + event normalize/dedup/replay + isolation.
- [ ] **Documentation updated:** [AI_PIPELINE](AI_PIPELINE.md), [EVENT_PIPELINE](EVENT_PIPELINE.md).
- [ ] **CI passing** (incl. Python/capability + model-CI skeleton).
- [ ] **Architecture validated:** model bound by selector (swap without code change); events carry `tenantId`; subjects tenant-scoped.
- [ ] **Exit criteria:** a frame produces a detection which becomes a persisted, deduplicated `EventEnvelope` and `event.persisted` is published.

### M4 — Automation & Response (P1-7, P1-8)

- [ ] **Code complete:** `rules` + `workflow` + `notify`.
- [ ] **Tests passing:** rule eval + dry-run + determinism; incident state machine; **end-to-end vertical test**; channel-failure (retry/dead-letter); isolation.
- [ ] **Documentation updated:** [RULE_ENGINE](RULE_ENGINE.md), [ALERT_ENGINE](ALERT_ENGINE.md).
- [ ] **CI passing** (incl. end-to-end job).
- [ ] **Architecture validated:** rules distinct from policy ([ADR-0013](../../adr/ADR-0013-policy-engine.md)); incidents/alerts tenant-scoped.
- [ ] **Exit criteria:** an event matches a rule, raises an incident, and delivers an alert on one channel with an ack path.

## Phase 1 exit (all milestones Done)

- [ ] **End-to-end demo:** a tenant adds a camera and receives an alert — one continuous, traced path.
- [ ] **Cross-tenant isolation suite green** on every endpoint, subject, key, and object prefix (fail-closed).
- [ ] **CI fully green**; all governance trackers current; every slice has a scenario doc + sprint review (Architect PENDING).
- [ ] **Phase 1 exit review** produced → opens Phase 2.
