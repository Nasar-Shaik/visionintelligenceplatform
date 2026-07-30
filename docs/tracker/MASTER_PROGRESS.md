# Master Progress — Vision Intelligence Platform

> **The single canonical dashboard. Read this first to know "where are we."** Update it every working session; keep it terse. Companion files: per-slice reviews in [REVIEW_HISTORY](REVIEW_HISTORY.md), narrative logs in [DAILY_LOG](DAILY_LOG.md). Backlog: [TASK-BOARD](../../tracking/TASK-BOARD.md). Roadmap: [PROJECT_ROADMAP](../project/PROJECT_ROADMAP.md).

_Last updated: 2026-07-30 · Claude_

## Snapshot

- **Phase:** **Phase 2 — Productization** (SOC Operations Console). Phase 1 **CLOSED**. Architecture **v1.0 APPROVED + FROZEN** (Architect decision 2026-07-29). Implementation phase — implementation now takes priority over documentation.
- **Current slice:** **P2-1 — Operations Console — ✅ ACCEPTED (enabler-free scope COMPLETE).** Acceptance review 2026-07-30: [P2-1-ACCEPTANCE](P2-1-ACCEPTANCE.md) — **verdict: enabler-free scope ACCEPTED/COMPLETE; full milestone PARTIAL** (flagship Cameras/Live/Analysis/Evidence blocked on enablers **G-1…G-6**, out of accepted scope). Delivered slices: **P2-1.0 Foundation** ✅ + **P2-1.1 Design System** ✅ + **P2-1.2 Authentication** ✅ + **P2-1.3 App Shell & Navigation** ✅ + **P2-1.4 Dashboard** ✅ + **P2-1.8 Events** ✅ + **P2-1.9 Rules** ✅ + **P2-1.10 Incidents** ✅ + **P2-1.11 Alerts** ✅ (camera→alert vertical operator UI complete) + **DX/bootstrap hardening** ✅ (`dev:all`, `pnpm seed`, deterministic `pnpm test`/`test:integration` split, gateway public-auth login fix, split setup docs). Governed by [ED-0030](../project/ENGINEERING_DECISION_LOG.md) ✅ / [ADR-0019](../adr/ADR-0019-operations-console-and-apps-layer.md). **Gates:** 396 unit tests (18 suites) + 23 integration tests (9 suites) green · typecheck/lint/build/import-graph(0-viol)/contracts/format all green · `dev:all` 10/10 healthy + login validated e2e.
- **Architecture Enhancement Review (documentation-only):** future enterprise capabilities documented under [`docs/architecture/future/`](../architecture/future/README.md) (AI Capability Registry, Analysis Profiles, AI Packs, Evidence Package, Human Review loop, Benchmark framework, Inference Scheduler, demonstration workflows) + 4 Proposed ADRs (0019–0022). No code / no frozen-doc change ([ED-0031](../project/ENGINEERING_DECISION_LOG.md)). ⏳ recommendations pending.
- **P2-2 — Backend Enablers (G-1…G-6):** **AUTHORIZED & IN PROGRESS** (Architect direction 2026-07-30). Sequential; each G is an independent Architect-review milestone. **G-1 Camera Service Enhancements ✅ ACCEPTED** (Architect review 2026-07-30 — five closing questions answered and aligned: failed-validation model is `200 + checks[]`; capabilities persisted with derived fallback; `/health/check` persists a health snapshot; enable/disable mutates state only, downstream reacts async; permissions confirmed read=all roles, update=owner/admin). Service extension adding camera **capabilities**, **metadata**, **validation/test-connection**, active **health-check**, and **enable/disable**. No new service, no frozen doc touched. **G-2 Media Service Enhancements ✅ ACCEPTED** (Architect review 2026-07-30 — nine closing questions answered and aligned: 900 s signed playback URLs over tenant-prefixed keys with authz on every issuance; ownership Camera→Media→object-store, retention/recording-delete deferred; clips forward-compatible with export via `status`/`key` state-transition + auto-switching playback; only stream-loss affects the live path — catalog/index/Mongo/presign all degrade; keyset `(ts,_id)` pagination; cross-tenant always 404; G-3 evidence attaches via `EventEnvelope.evidenceRefs`, resolved by G-4). Service extension adding a **Mongo-backed media catalog** (`recordings`, `clips`), **stream health** derivation, and **signed-URL playback**. No new service, no frozen doc touched. **Next: G-3 Inference Runtime (awaiting authorization).**
- **Next step:** hold for Architect authorization of **G-3 Inference Runtime** (model registry, pipeline execution, inference status, job management, runtime metrics); do **not** start it until directed (sequential enabler milestones). Also open (console hardening, later): route-level code-splitting (bundle ≈ 352 kB gz), automated browser E2E.
- **Blockers:** none for the events/rules/incidents/alerts slices. Cameras/Live/Analysis/Evidence gated on backend enablers **G-1…G-6** (service extensions, not new services — Exit Review §11).
- **Overall completion:** Phase 0 **100%** · Phase 1 **100% ✅ Complete** · Phase 2 **in progress** — P2-1 Operations Console **enabler-free scope ✅ ACCEPTED** (9 slices + DX hardening); remaining P2-1 slices + enablers G-1…G-6 pending · Program ≈ **38%** (of Phases 0–4).

## Phase status

| Phase | Name                 | Status         | Detail                                                                                                                                                                                                                                                                  |
| ----- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Foundation           | ✅ Complete    | P0-1…P0-7 done; frozen v1.0; exit review passed                                                                                                                                                                                                                         |
| 1     | Core Platform        | ✅ Complete    | P1-1…P1-8 ✅ Architect-approved (M1+M2+M3+M4). Camera→alert vertical live-validated                                                                                                                                                                                     |
| 2     | Productization       | 🟡 In progress | P2-1 Operations Console **enabler-free scope ✅ ACCEPTED** ([acceptance](P2-1-ACCEPTANCE.md)). **P2-2 Backend Enablers in progress** — **G-1 Camera ✅ ACCEPTED**; **G-2 Media ✅ ACCEPTED**; **G-3 Inference ⏳ next**; G-4…G-6 pending. Then remaining P2-1 UI slices |
| 3     | Enterprise Features  | ⚪ Not started | entitlements/billing, audit, connectors, industry packs, digital twin                                                                                                                                                                                                   |
| 4     | Production & Scaling | ⚪ Not started | multi-region, edge fleet, HA/DR, GA                                                                                                                                                                                                                                     |

Legend: ✅ done · 🟢 on track · 🟡 in progress · 🔴 blocked · ⚪ not started

## Phase 1 — milestone & slice status

| Milestone         | Slice | Subject                                   | Status  | Review      |
| ----------------- | ----- | ----------------------------------------- | ------- | ----------- |
| **M1** Access     | P1-1  | Tenant foundation + fail-closed isolation | ✅ Done | ✅ Approved |
|                   | P1-2  | Authentication + authorization            | ✅ Done | ✅ Approved |
| **M2** Ingestion  | P1-3  | Camera registry + org hierarchy           | ✅ Done | ✅ Approved |
|                   | P1-4  | RTSP ingestion + recording                | ✅ Done | ✅ Approved |
| **M3** Perception | P1-6  | AI inference (capability runtime)         | ✅ Done | ✅ Approved |
|                   | P1-5  | Event pipeline                            | ✅ Done | ✅ Approved |
| **M4** Response   | P1-7  | Rule engine                               | ✅ Done | ✅ Approved |
|                   | P1-8  | Incident lifecycle + Alert engine         | ✅ Done | ✅ Approved |

- **Phase 1:** all 8 slices ✅ **Architect-approved** (directive 2026-07-29) — camera→alert vertical complete + live-validated.
- **Phase 2 (P2-1 Operations Console):** ✅ **Approved** (Architect decision 2026-07-29); **in implementation** — **P2-1.0 Foundation complete** (`apps/console` scaffold, `apps/*`/`app` import-graph layer, design-system tokens, RTK store, Query client, Router, typed gateway API client; typecheck/lint/test/build/import-graph all green). Next: P2-1.1 design system.

## Gate status (P1-1 … P1-8 code complete — M1 + M2 + M3 + M4 done; camera→alert vertical closed)

| Gate                      | Status                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Architecture approval** | ✅ Phase 1 blueprint approved · P1-6 improvements approved · **P1-5 ✅ approved** · **P1-7 ✅ approved** · P1-8 (3 recs folded in) · P1-1 … P1-4, P1-6, P1-8 code ⏳ PENDING review                                                                                                                                                                                    |
| **Implementation**        | 🟢 P1-1 (tenant + `@vip/tenancy`) · P1-2 (`@vip/auth`, `@vip/permissions`, identity, gateway) · P1-3 (`@vip/crypto`, camera) · P1-4 (`@vip/storage`, media, ffmpeg) · P1-6 (`ai/inference`) · P1-5 (`@vip/messaging`, events) · P1-7 (`@vip/service-rules`) · P1-8 (`@vip/service-workflow` + `@vip/service-notify` — incident lifecycle + Alert Engine)               |
| **Testing**               | 🟢 375 TS (379 w/ real Mongo+MinIO) + **40 Python**: guards, auth, gateway trust boundary, credential vaulting, media recording, capability lifecycle, event normalize/dedup/persist, sandboxed rule eval, **incident state machine + idempotent promotion + alert fan-out/delivery/ack**, real-backend integration; **full P1-6→P1-5→P1-7→P1-8 chain live-validated** |
| **Documentation**         | 🟢 18 package/service/runtime READMEs, AUTH/TENANT/CAMERA/INGESTION/STORAGE/AI_PIPELINE/EVENT_PIPELINE/RULE_ENGINE/INCIDENT_LIFECYCLE/ALERT_ENGINE arch, API_INVENTORY, DEPENDENCIES, slice-006…013                                                                                                                                                                    |
| **CI**                    | 🟢 Green on `feature/v1` (format/lint/typecheck/test/build/import-graph 17pkg 0-viol/contracts 30/mlops+inference python)                                                                                                                                                                                                                                              |

## Standing gates (never regress)

- **Cross-tenant isolation suite** — grows with every P1 data path; a failure blocks merge (from P1-1 onward).
- **Import-graph** (`check:imports`) — 0 violations; boundaries per [23-SERVICE-OWNERSHIP](../architecture/23-SERVICE-OWNERSHIP.md).
- **Contract-first** — every consumer's schema exists in `@vip/contracts` before the consumer.
- **`.env`-only secrets** — no code reads `process.env` outside `@vip/config` ([ADR-0018](../adr/ADR-0018-env-only-secrets-and-centralized-config.md)).

## Open risks / landmines (carry forward)

- **R-010 — cross-tenant leak** is the whole ballgame for P1; mitigated by the `@vip/tenancy` guard + the standing isolation suite. Full register: [RISK_REGISTER](../project/RISK_REGISTER.md).
- Add anything you hit here so the next agent doesn't rediscover it.
