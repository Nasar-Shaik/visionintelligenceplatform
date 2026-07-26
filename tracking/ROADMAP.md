# Development Roadmap

> The phase plan from Phase 0 to Enterprise Release and the Future Vision. Each phase is **independently shippable** and **capability-composed** — no phase hardcodes a vertical. Progress against this roadmap is tracked in [PROGRESS.md](PROGRESS.md); acceptance gates in [MILESTONES.md](MILESTONES.md).

Timelines assume a ~10–14 person cross-functional team (Platform, Video, AI/CV, Frontend, Mobile, MLOps/DevOps, Security). Sprints = 2 weeks. Timelines are planning estimates, not commitments.

---

## Phase 0 — Program Setup & Architecture (current) · ~3–4 weeks
Monorepo (pnpm+Turborepo) + Python workspace; **`packages/contracts` bootstrap** (schema-first); CI skeleton (build/test/scan + import-graph enforcement); Docker Compose dev stack (Mongo, Redis, MinIO, streaming, RTSP test source); model/dataset registry bootstrap (MLflow + DVC); secrets strategy; **this documentation set ratified**. **Gate for all phases.**
**Exit:** repo self-documenting; contracts pipeline generating types; CI green on an empty service.

## Phase 1 — SaaS Foundation · ~6–8 weeks
Multi-tenancy + data-layer isolation (fail-closed `tenantId`); Identity (OIDC/JWT/refresh/MFA, RBAC+ABAC, scopes); org→region→…→camera hierarchy (schema); entitlements/feature-flags; usage metering; audit log (hash-chained); notification abstraction; object-storage service; API keys; billing (Stripe) + quotas; admin console; web app shell (branding/i18n).
**Depends:** P0. **Exit:** provision tenant, invite users, RBAC enforced E2E, billing+quotas live, cross-tenant tests fail-closed.

## Phase 2 — Video & Ingestion Capabilities · ~8–10 weeks
`media.ingestion` (ONVIF discovery, RTSP/RTMP, credential vault, health/heartbeat, reconnect); `media.streaming` (WebRTC live + HLS playback + snapshots); `media.frame-extract` (adaptive sampling + motion gating + backpressure); `media.recording` + ring buffer; **edge agent v1** (offline-capable, sync); live-view UI (grid, WebRTC, HLS playback, PTZ).
**Depends:** P1. **Exit:** add camera → live in <60s; record & play back; edge agent runs offline and reconciles.

## Phase 3 — Capability & Inference Platform · ~12–16 weeks
Model-agnostic **inference runtime** (ONNX/TensorRT/OpenVINO, batching, GPU scheduling); **Capability Registry + descriptor contract**; **Pipeline Orchestrator** (DAG from descriptors, placement/scheduler); first perception capabilities (person/vehicle/object detection, tracking, zone/line, pose, face-detection, LPR, fire-smoke); model registry integration (versioning, assignment, per-tenant/camera).
**Depends:** P2, P1 (entitlements). **Exit:** capability DAG runs on a real camera; capabilities swappable behind contract; models pinned/rollback-able.

## Phase 4 — Event, Rule & Alert Platform (first strongly sellable increment) · ~8–10 weeks
**Event Platform** (taxonomy, catalog, dedup, correlation, priority, storage, streaming, timeline, replay); **Rule Engine** (DSL, evaluator, temporal/spatial/threshold/confidence, dry-run) + no-code builder + zone/line editor; **Evidence** (smart clip, merge, timeline, chain of custody); **Notification** (multi-channel + escalation); event/incident feed UI.
**Depends:** P3. **Exit:** author a rule → alert with clip on phone; escalation works; storage reduced via clip-only. → **first paying customers.**

## Phase 5 — Workflow Engine & Command Center · ~6–8 weeks
**Workflow Engine** (incident/case lifecycle, escalation policies, approvals, operator/manager actions, audit); role-based dashboards (data-driven, not vertical-coded); live monitoring wall; timeline/clip viewer; map/floorplan; global structured search + saved views; notification center.
**Depends:** P2–P4. **Exit:** incident→escalation→approval→resolution E2E with full audit; command-center wall live.

## Phase 6 — Analytics & Search Intelligence · ~8–10 weeks
**Analytics capabilities** (counting, occupancy, heatmaps, dwell, queue, footfall, trends) + materialized read models; **Search** (structured + semantic/CLIP + auto-caption + **NL query**); report engine (scheduled PDF/Excel, export center, benchmarking); forecasting widgets.
**Depends:** P3–P5, vector DB. **Exit:** heatmaps + footfall reports; NL search answering example queries.

## Phase 7 — Extensibility & Industry Packs · ~8–10 weeks
**Plugin SDK + Plugin Registry**; extension points/hooks/DI hardened; **Rule/Workflow/Dashboard/Report/Policy templates as data**; first **Industry Packs** (Retail, Warehouse, one regulated e.g. Hospital or Bank) — **declarative only**; pack install/versioning per tenant; verify "delete all plugins → core builds/tests/runs."
**Depends:** P4–P6. **Exit:** a vertical solution appears purely from a pack with zero core diff.

## Phase 8 — Enterprise & Compliance · ~10–14 weeks
SSO/SAML/SCIM, advanced RBAC/ABAC; on-prem/hybrid packaging (Helm/Terraform, offline license, air-gap); white-label + custom domains; API platform + developer portal + SDKs + webhooks; integrations (POS, access control, SIEM, VMS/ONVIF interop); compliance suite (GDPR/HIPAA tooling, DSAR, privacy masking, legal hold, access policies); multi-region data residency.
**Depends:** P1–P7. **Exit:** SSO + on-prem install; integration live; compliance pack demonstrable.

## Phase 9 — MLOps & Model Expansion · ~8–12 weeks (then ongoing)
Continuous-training loop (dataset mgmt, auto-label + HITL, CT pipelines, drift monitoring, shadow/canary/A-B, per-site fine-tuning); expand perception catalog (weapon, violence/fight, fall/slip, object-left/removed refinements, attribute suite, anomaly, audio analytics); edge model OTA + INT8 quantization; **model marketplace beta**; active learning from field FP/FN.
**Depends:** P3, P6, P7 + field data. **Exit:** CT pipeline live; expanded capabilities GA; marketplace beta.

## Phase 10 — Production, Scale & Enterprise GA · ~6–8 weeks concentrated, then continuous
Horizontal scale (sharded Mongo, GPU autoscaling, stream fan-out, multi-region, edge fleet mgmt); HA + backup/DR (RPO/RTO, drills), chaos, graceful degradation; security hardening (pen-test remediation, SAST/DAST, key rotation); observability/SRE (SLOs, on-call, runbooks, status page); load test to 1,000+ then 10,000-camera fleet simulation; blue-green/canary; IaC complete; launch ops.
**Depends:** all prior. **Exit:** 1,000-camera load passed; DR drill passed; **Enterprise GA**.

---

## Dependency graph
```
P0 ─▶ P1 ─▶ P2 ─▶ P3 ─▶ P4 ─┬─▶ P5 ─▶ P6 ─▶ P7 ─▶ P8
                             │                    └▶ P9 (needs P3,P6,P7 + field data)
   all ───────────────────────────────────────────────▶ P10
```

## Timeline summary
- **P0–P4** ≈ 6–7 months → **first revenue** (video + capabilities + events + rules + alerts).
- **P5–P8** ≈ +6–7 months → workflow, analytics/NL search, extensibility, enterprise/compliance.
- **P9–P10** ≈ +4–6 months → MLOps loop, scale, **Enterprise GA** (~16–19 months), with sellable increments throughout.

---

## Production Release (definition)
Enterprise GA (end of P10) with: provable tenant isolation; TLS/AES-256/per-tenant KMS; safety-critical model gates met in CI + field; escalation/notification reliability; tested DR + edge offline→sync; observability/SLOs/on-call; load/scale proven; GDPR/HIPAA/SOC2/ISO posture; billing/metering correct; ≥1 regulated Industry Pack shipped as a pure plugin. Full gate: [MILESTONES.md](MILESTONES.md).

## Enterprise Release (definition)
Multi-region residency, on-prem/hybrid + air-gap, SSO/SCIM, white-label/OEM, developer platform + SDKs, integrations (POS/access/SIEM/VMS), continuous-training loop, and 3+ Industry Packs including regulated verticals — all without core forks.

## Future Vision (post-GA, ongoing)
- **Marketplace ecosystem**: partner-published capabilities, models, and Industry Packs with revenue share.
- **New modalities**: audio, thermal, radar, LiDAR, IoT sensor-fusion capabilities behind the same contract.
- **Higher-order reasoning**: global multi-camera/city-scale re-ID, prescriptive analytics, cross-site situations, NL→rule authoring.
- **Autonomous operations**: self-tuning thresholds, auto-composition of capability graphs from stated goals, agent-assisted investigations.
- **Open platform**: public API/AsyncAPI, WASM-sandboxed community plugins, certified-partner program, OEM embedding in cameras/NVRs.

## Cross-references
[../docs/00-ENGINEERING-CONSTITUTION.md](../docs/00-ENGINEERING-CONSTITUTION.md) · [PROGRESS.md](PROGRESS.md) · [MILESTONES.md](MILESTONES.md) · [TASK-BOARD.md](TASK-BOARD.md)
