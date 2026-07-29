# Phase 1 — Exit Review & Productization Go/No-Go

_Reviewer: Claude (implementing) · Date: 2026-07-29 · Decision authority: Principal Architect_

> Produced at the Architect's direction before Phase 2 (Productization). Reviews the Phase-1 platform
> against nine dimensions, catalogues remaining debt + deferred decisions, assesses risk, and issues a
> **Go/No-Go** for building the Operations Console (P2-1). Grounded in the real repo — every claim is
> traceable to a service, contract, ADR/ED, TD, or risk id. **No architecture is changed by this
> document.**

## 1. Scope reviewed

Phase 1 delivered the **camera → alert vertical** across 8 slices (all code-complete; P1-5 & P1-7
Architect-approved, the rest ⏳ pending): tenant/identity, auth/gateway, camera registry, RTSP
ingestion + recording, AI inference runtime, event pipeline, rule engine, and incident lifecycle +
alert engine. **10 backend services**, **11 shared packages**, **1 Python runtime**; **17 workspace
packages, 0 import-graph violations**; **30 contract schemas**; **375 TS + 40 Python tests**.

---

## 2. Service boundaries — ✅ SOUND

| Context      | Service        | Owns                            | Public API                                 | Consumes / Publishes                                                     |
| ------------ | -------------- | ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| Access       | `identity`     | users, tokens, sessions         | `/auth/*`, `/users`                        | —                                                                        |
| Access       | `gateway`      | edge trust boundary             | `/api/:service/*`, `/whoami`               | (proxy)                                                                  |
| Tenancy      | `tenant`       | tenants, org hierarchy          | `/tenants`, `/org-nodes`                   | `tenant.*`                                                               |
| Ingestion    | `camera`       | camera inventory, vaulted creds | `/cameras`                                 | `camera.*`                                                               |
| Ingestion    | `media`        | RTSP decode, recordings         | `/streams`                                 | `media.stream.*`, `media.recording.segment`                              |
| Perception   | `ai/inference` | capability runtime              | `/infer` (internal)                        | `capability.output.*`                                                    |
| Event        | `events`       | normalize + persist events      | `/events`                                  | consumes `capability.output.*` → `event.persisted`                       |
| Rule         | `rules`        | rule eval, versioned rules      | `/rules`, dry-run                          | `event.persisted` → `incident.candidate`, `rule.matched`                 |
| Workflow     | `workflow`     | incident lifecycle              | `/incidents`                               | `incident.candidate` → `incident.raised\|acknowledged\|resolved\|closed` |
| Notification | `notify`       | channels, delivery, ack         | `/notification-channels`, `/notifications` | `incident.raised` → `notification.*`                                     |

**Findings.** Boundaries match the frozen `22-BOUNDED-CONTEXTS` / `23-SERVICE-OWNERSHIP`. Enforced
mechanically: `noCrossServiceInternals`, `noCoreToPlugin`, `noDeepImports`, `noCycles`
(`tools/import-graph/boundaries.json`) — **0 violations**. Cross-context communication is API/events
only. **No boundary changes recommended for Phase 2.** The Operations Console is a **client of the
gateway**, not a service — it introduces a new `apps/` layer (see §11 / [ED-0030]), not a new context.

## 3. Contracts — ✅ SOUND, contract-first held

`@vip/contracts` is the single integration truth: **30 Zod schemas → native JSON-Schema**, verified in
CI (`tools/contracts/verify-schemas.mjs`, draft 2020-12). Every consumer's schema existed before the
consumer (Law 4). The `EventEnvelope` is the canonical currency; `envelopeVersion` + `category` give
forward-evolution room; the incident/notification contracts close the vertical. **Reusable for the
console**: the frontend can import `@vip/contracts` **for types only** (shared layer is importable by
anything) — one source of truth for API shapes, no drift.

**Gap (minor).** Consumer-driven contract tests are still schema-presence only (**R-009**); acceptable
for a solo-owned monorepo, revisit when external SDKs appear.

## 4. Event flow — ✅ SOUND, loop-free

```
camera/media ──▶ capability.output.* ──▶ [events] ──▶ event.persisted ──▶ [rules] ──▶ incident.candidate
                                                                                            │
                                                     [workflow] ◀───────────────────────────┘
                                                         │  incident.raised ──▶ [notify] ──▶ notification.*
                                                         └─ incident.acknowledged|resolved|closed
```

Tenant-partitioned subjects `t.{tenantId}.…` with fail-closed token validation; four JetStream streams
(`CAPABILITY_OUTPUT`, `EVENTS`, `AUTOMATION`, `NOTIFICATIONS`); at-least-once + idempotent consumers
(dedup keys / unique indexes); fail-closed dead-lettering on invalid contracts. **Loop-free by
construction** — each consumer filters only its input subject and publishes onto a sibling/distinct
root it never consumes. **Correlation is threaded end-to-end** (frame → detection → event → candidate →
incident → notification), which is exactly what the Evidence Viewer needs.

## 5. Dependency graph — ✅ CLEAN

17 packages, 47 internal edges, **acyclic, 0 violations**. Shared→anything, service→shared-only,
no cross-service internals, no cycles. New packages auto-fit by path prefix. **Zero new external
dependencies** were added across P1-3…P1-8 beyond the P1-2/P1-4/P1-5 essentials (jose, aws-sdk,
@nats-io) — the platform is lean.

## 6. Technical debt — 8 open items, none blocking

| TD   | Area                                                                                                             | Severity | Productization relevance                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| TD-1 | TS pinned 5.9.3 (typescript-eslint)                                                                              | low      | none                                                                                                |
| TD-2 | stale Phase-0 status docs                                                                                        | low      | none                                                                                                |
| TD-3 | camera `zoneId` existence not sync-checked                                                                       | medium   | none (async reconcile)                                                                              |
| TD-4 | media→inference frame bus not wired; in-memory stream state; shared internal key                                 | medium   | **HIGH — blocks live analysis + upload-analyze**                                                    |
| TD-5 | inference `onnx` backend integration-only (stub is tested default)                                               | medium   | **MED — real detections need a registered model**                                                   |
| TD-6 | lifecycle producers still log-only (not on the backbone)                                                         | medium   | LOW (console reads via APIs, not those events)                                                      |
| TD-7 | in-proc rule windowed state; per-event rule fetch                                                                | medium   | none at demo scale                                                                                  |
| TD-8 | workflow: escalation/on-call/cases/hash-chain audit; notify: email/SMS/push, retry/DLQ; **evidence-ref linking** | medium   | **HIGH — Evidence Viewer needs evidence linking; Incident "assign/comments" needs workflow fields** |

**The two debts that gate the demo are TD-4 (media→inference wiring) and TD-8 (evidence linking).**
Both are **extensions to existing services**, not new services.

## 7. Deferred decisions (from the ED log "Future Review")

- **media→inference frame bus** (TD-4/5) — the live/recorded analysis path is not yet end-to-end in one
  process; inference is validated in isolation. **Productization needs this closed.**
- **Real ONNX model registration + model-CI FP/FN gates** (TD-5) — the `stub` backend is the tested
  default; a real detector must be registered on dev-stack MLflow for a credible demo.
- **Lifecycle-publisher retrofit** (TD-6), **Redis rule/notify state** (TD-7), **email/SMS/push +
  retry/DLQ + escalation/on-call/cases + hash-chain audit** (TD-8) — all safely deferrable past the
  first demo.
- **RS256/JWKS**, key rotation, machine-principal/mTLS for internal calls — deferred; HS256 + shared
  `INTERNAL_API_KEY` is the documented Phase-1 stand-in.

## 8. Performance assumptions — ⚠️ UNPROVEN (by design)

**R-005 (High/Med):** no load/perf testing; NATS/Mongo/edge assumptions unvalidated at scale. Phase 1
is batch=1, single-capability, in-proc windowed state, a Mongo query per event. **For a customer demo
this is fine** (a handful of cameras, one runtime). **Not fine for production scale** — a load harness
(camera-simulator) and the Redis/partitioning swaps (TD-7) belong to P2-analytics/P4. **Recommendation:
demo on a bounded fixture (≤ 8 cameras), state the scale envelope explicitly.**

## 9. Security assumptions — ✅ SOUND for the model, ⚠️ dev-cred caveats

**Strong:** fail-closed tenant isolation (the `@vip/tenancy` guard + standing isolation suite; **R-010**
mitigated), deny-by-default RBAC (PDP, wildcard perms), edge token validation with header-spoof
stripping at the gateway, credential vaulting (AES-256-GCM), `.env`-only secrets (ADR-0018), fail-closed
dead-lettering, sandboxed rule DSL (no eval/regex/ReDoS).

**Caveats to close before any non-demo exposure:** dev creds + no TLS on infra (**R-014**), MLflow no
auth (**R-014**), shared `INTERNAL_API_KEY` instead of a machine principal (TD-4), no secret rotation
(**R-015**), scanners not yet run on a real push (**R-003**). **For the console specifically:** the
gateway needs **CORS** for a browser origin and must keep the access token out of durable storage
(memory + silent refresh). The console must never receive vaulted credentials (camera API is write-only
by design — preserved).

## 10. Operational readiness — ⚠️ PARTIAL

**Present:** every service has `/health` `/ready` `/metrics` + graceful drain; per-instance Prometheus
registries; structured logs with a request/correlation id; dev compose stack (Mongo/Redis/MinIO/NATS)
config-validated and **exercised live** (this vertical was live-validated end-to-end on it).

**Missing for a demo:** a **single "run the whole stack" entrypoint** (compose profile that boots all
10 services + inference + a seeded tenant/user/camera/rule), a **registered ONNX model** (TD-5),
**seed/fixture data**, and **live-view + upload endpoints** (§11). Branch protection deferred (**R-008**),
Docker images not fully pinned (**R-011**).

## 11. Productization gaps (what the Console cannot do without a small backend extension)

The success criteria include _view live video_, _upload a recorded video → analyze_, and _review
evidence_. These are **not yet supported by any backend endpoint** and are **extensions to existing
services** (no new service — consistent with the directive):

| #   | Gap                                           | Enabler (extension, not a new service)                                                                                       | Blocks console module               |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| G-1 | No browser live-view stream                   | **media**: MJPEG-over-HTTP (or snapshot polling) off the existing JPEG frame pipeline (WebRTC/HLS later)                     | Live Monitoring                     |
| G-2 | No recorded-video upload/analyze path         | **media**: a **file source** (multipart upload → existing ffmpeg-decoder → frames → inference → events) + a job/status model | Recorded Video Analysis (mandatory) |
| G-3 | media→inference not wired in-process (TD-4/5) | wire the frame bus + register one ONNX model (TD-5)                                                                          | Live Monitoring, Recorded Analysis  |
| G-4 | Incidents carry no evidence refs (TD-8)       | **workflow + media**: attach snapshot/clip signed-URL on `incident.raised`                                                   | Evidence Viewer                     |
| G-5 | Gateway has no CORS / live push               | **gateway**: CORS plugin; SSE (or poll) for live incident/alert feed                                                         | Dashboard, Alerts, all              |
| G-6 | Incident lacks assignee/comments (TD-8)       | **workflow**: `assign` + comment fields/route                                                                                | Incidents (assign, comments)        |

**These six enablers are the real work behind the "UI" milestone.** They are small, reviewable
increments and must be sequenced with the console modules that depend on them (see the P2-1 plan).

---

## 12. Remaining technical debt (carry-forward summary)

Open: **TD-1…TD-8** (see §6). Productization-gating: **TD-4** (media→inference + upload path),
**TD-5** (real model), **TD-8** (evidence linking, incident assign/comments). New productization
enablers G-1…G-6 (§11) should be tracked as their own debt/backlog items when scheduled. Everything
else is safely deferrable.

## 13. Recommended improvements (before/with P2-1)

1. **Close TD-4 + TD-5**: wire media→inference and register one ONNX detector on dev-stack MLflow — the
   demo's credibility depends on real detections.
2. **Add the six backend enablers G-1…G-6** as thin, reviewed service extensions (no new services).
3. **One-command demo stack**: a compose profile + seed script (tenant, admin user, a camera, one
   enabled rule, one in-app channel) so the whole vertical boots reproducibly.
4. **Gateway CORS** + keep tokens in memory; add an SSE (or polling) live feed for the dashboard.
5. **Introduce the `apps/` layer + import-graph `app` boundary** via **ADR-0019 / [ED-0030]** so the
   console cannot import service internals.

## 14. Risk assessment for Productization

| Risk                      | Sev                    | Note                                                                                                                       |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| R-005 perf unproven       | Med                    | Demo on a bounded fixture; state the scale envelope.                                                                       |
| TD-4/TD-5 analysis path   | **High (demo-gating)** | Must be closed for live/recorded analysis. Owned, scoped, low-uncertainty.                                                 |
| TD-8 evidence linking     | Med                    | Evidence Viewer degrades gracefully without it (show event/rule/camera/confidence/correlation; add media refs when wired). |
| R-014/R-003/R-015 sec/ops | Med                    | Acceptable for an internal/controlled demo; **must not** be internet-exposed with dev creds.                               |
| New frontend stack risk   | Low                    | Mainstream, well-understood stack (React/Vite/TS); isolated in `apps/`, cannot touch the core.                             |

## 15. Go / No-Go decision

**Recommendation: 🟢 GO for Productization (P2-1 Operations Console), conditional.**

**Rationale.** The platform vertical is architecturally complete, boundary-clean, contract-first,
loop-free, tenant-isolated, and **live-validated end-to-end**. Nothing in the core needs redesign to
build the console. The remaining work is **additive**: a frontend client + six small backend
**extensions** (no new services), plus closing two known debts (TD-4/TD-5).

**Conditions (the "GO" is gated on these being scheduled, not pre-done):**

1. Backend enablers **G-1, G-2, G-3 (TD-4/5)** are scoped as reviewed extensions and sequenced ahead of
   the Live/Recorded/Analysis modules.
2. The demo runs on a **bounded fixture** with the **scale envelope stated** (R-005 unproven).
3. The stack is **not exposed with dev credentials** (R-003/R-014/R-015); TLS/auth hardening precedes
   any external exposure.
4. The `apps/` layer + `app` import boundary land via **ED-0030** before console code.

**No-Go only if** the Architect wants real production scale/hardening (load-tested, TLS, managed
secrets, real model-CI gates) _inside_ this milestone — that would reclassify P2-1 from "demonstrable
product" to "GA hardening," which the directive explicitly defers.

> **Companion:** the P2-1 build plan is [OPERATIONS_CONSOLE](../architecture/phase2/OPERATIONS_CONSOLE.md).
> This review changes no architecture; the `apps/` layer + stack selection are proposed there for
> Architect approval ([ED-0030](ENGINEERING_DECISION_LOG.md), ⏳ pending).
