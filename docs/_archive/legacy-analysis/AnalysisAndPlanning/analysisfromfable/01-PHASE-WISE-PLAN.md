# 01 — Phase-Wise Development Plan

Nine phases, each shippable. Every phase lists **Objectives · Deliverables · Dependencies · Development Order · Milestones · Estimated Timeline**. Timelines assume a ~10–14 person cross-functional team (Platform, Video, AI/CV, Frontend, Mobile, MLOps/DevOps). Sprints = 2 weeks.

> **First revenue** at end of Phase 4 (single/few cameras with alerts). **Enterprise GA** at Phase 9.

---

## Phase 0 — Program Setup (~2–3 weeks)
Monorepo (pnpm + Turborepo), CI skeleton, Docker Compose (Mongo, Redis, MinIO, RTSP test server), shared TS config/lint, design system (Tailwind + Shadcn), model/dataset registry bootstrap (MLflow + DVC), secrets strategy. Gate for all phases.

---

## Phase 1 — Foundation (SaaS Core)

**Objectives:** Stand up the secure multi-tenant SaaS backbone that every camera, model and dashboard will hang off.

**Deliverables:**
- Tenancy: organizations, tenant isolation, subscription plans, feature flags, usage metering.
- Identity: JWT access + rotating refresh, MFA, SSO/OIDC, RBAC + fine-grained permissions, branch/location scoping.
- Org model: organizations → branches → locations → camera groups → cameras (schema only).
- Audit logs, activity logs, notification abstraction (in-app + email), file/object storage service, API keys.
- App shell (web) with branding/theming/i18n; super-admin console (tenant provisioning, plans, flags).
- Billing integration (Stripe) + storage quotas.

**Dependencies:** Phase 0.
**Development Order:** Tenancy+Auth → RBAC/permissions+tenant middleware → org hierarchy → audit → files/storage → notifications → plans/billing/quotas → admin console → app shell/branding.
**Milestones:** M1 tenant can be provisioned & users invited; M2 RBAC enforced end-to-end; M3 billing + quotas live.
**Timeline:** ~6–8 weeks.

---

## Phase 2 — Video Infrastructure

**Objectives:** Reliably ingest, decode, record, and stream video from any camera at scale — the plumbing before any AI.

**Deliverables:**
- **Camera onboarding:** ONVIF discovery, RTSP/RTMP add, credentials vault, health/heartbeat, reconnection.
- **Media server / ingest:** RTSP/RTMP pull, transcode (FFmpeg/GStreamer), **HLS** for scalable playback, **WebRTC** for low-latency live view, snapshot/thumbnail service.
- **Frame pipeline service (Python):** decode, GPU frame extraction, adaptive frame sampling, backpressure.
- **Recording & storage:** segment recording, smart-buffer (pre-roll ring buffer), clip store in MinIO/S3, lifecycle/retention.
- **Edge agent v1:** containerized agent that runs on Jetson/mini-PC, pulls local cameras, syncs to cloud, works offline.
- **Live view UI:** multi-camera grid, single-camera live (WebRTC), playback (HLS), PTZ controls where supported.

**Dependencies:** Phase 1 (tenancy, storage, users).
**Development Order:** Camera model+onboarding → ingest/media server → HLS/WebRTC live → frame service → recording+clip store+retention → edge agent → live view UI.
**Milestones:** M4 add a camera and see live stream in <60s; M5 record & play back; M6 edge agent runs offline & syncs.
**Timeline:** ~8–10 weeks.

---

## Phase 3 — AI Detection Engine

**Objectives:** Turn frames into structured detections, tracks and recognitions — the core intelligence.

**Deliverables:**
- **Inference runtime** (Python) with model abstraction: load ONNX/TensorRT/OpenVINO, batching, GPU scheduling, per-camera model config.
- **Detection engine:** YOLO-based person/vehicle/object detection; zone/ROI masks.
- **Tracking engine:** ByteTrack/DeepSORT multi-object tracking with stable IDs, line-crossing, dwell.
- **Recognition engine:** face detection + face recognition (embeddings), employee vs unknown, LPR (ALPR) pipeline.
- **Pose engine:** MediaPipe/pose models for fall/slip/action primitives.
- **Model manager + registry integration:** versioned models, per-tenant/per-camera enablement (AI packs), edge/cloud placement.
- **First 10 GA detections** (person, vehicle, object, face, intrusion/restricted-area, loitering, people counting, PPE/helmet, fire/smoke, LPR).

**Dependencies:** Phase 2 (frames), Phase 1 (feature flags for AI packs).
**Development Order:** Inference runtime → detection → tracking → zones/lines → pose → face/LPR recognition → model manager/packs → GA-10 tuning.
**Milestones:** M7 person/vehicle detection live on real camera; M8 stable tracking + counting; M9 face/LPR + fire/PPE GA.
**Timeline:** ~12–16 weeks.

---

## Phase 4 — Alert & Rule Engine

**Objectives:** Convert detections into meaningful events, let customers define what matters, and notify the right people — this is the first strongly sellable increment.

**Deliverables:**
- **Behaviour engine:** compose detections/tracks into behaviours (intrusion, tailgating, crowd, abandoned/removed object, running, sleeping, mobile usage, smoking).
- **Event engine:** debounce/dedupe, severity, event lifecycle (open→ack→resolve), snapshots.
- **Rule engine:** no-code **drag-and-drop** IF/THEN builder (conditions: object, zone, time window, count, dwell, speed; actions: alert, extract clip, notify, save event, webhook, PTZ preset).
- **Smart clip extraction:** pre-roll (e.g., 10s before) + post-roll (e.g., 20s after), merge overlapping, timeline generation.
- **Notification system:** email, SMS, WhatsApp, push, voice call, webhook, Slack, MS Teams; **escalation rules**.
- **Event feed UI + clip viewer** with acknowledge/assign/resolve.

**Dependencies:** Phase 3 (detections/tracks), Phase 1 (notifications, users).
**Development Order:** behaviour engine → event engine → rule engine (builder + evaluator) → clip extraction → notification channels + escalation → event/clip UI.
**Milestones:** M10 custom rule → alert on phone with clip; M11 escalation works; M12 storage reduced via clip-only.
**Timeline:** ~8–10 weeks. → **First paid customers.**

---

## Phase 5 — Dashboard & Live Monitoring

**Objectives:** Give operators and owners a professional command center across cameras, sites and events.

**Deliverables:**
- Role-based dashboards: Executive, Store, Camera, Branch, Security.
- Live monitoring wall (multi-camera, event overlays, alarm view), event timeline, clip viewer, map/floorplan view.
- Basic heatmaps, occupancy, people/vehicle counts widgets.
- Global search UI (structured filters) + saved views; notification center.
- Web polish, accessibility, responsive.

**Dependencies:** Phases 2–4.
**Development Order:** dashboard framework/widgets → live wall → timeline/clip viewer → maps/floorplans → search filters → role dashboards.
**Milestones:** M13 security wall with live alerts; M14 executive multi-site dashboard.
**Timeline:** ~6–8 weeks.

---

## Phase 6 — Analytics & Search Intelligence

**Objectives:** Move from events to insight, and deliver the flagship **natural-language search**.

**Deliverables:**
- **Analytics engine:** heatmaps, occupancy trends, dwell time, queue analysis, people/vehicle counting, footfall, conversion, zone analytics, hourly/daily/weekly reports.
- **Search engine:** vector/semantic search over event metadata + CLIP visual embeddings + captions → **NL queries** ("show possible theft yesterday", "employee entering warehouse after 10 PM").
- Report builder (scheduled PDF/Excel), export center, benchmarking across branches.
- Forecasting widgets (footfall, occupancy).

**Dependencies:** Phases 3–5, vector DB.
**Development Order:** analytics aggregation/read models → dashboards charts → embeddings pipeline (CLIP + metadata) → NL query parser → search UI → reports/exports.
**Milestones:** M15 heatmaps + footfall reports; M16 NL search answering example queries.
**Timeline:** ~8–10 weeks.

---

## Phase 7 — Enterprise Features

**Objectives:** Make it deployable and buyable by large, regulated, multi-site organizations.

**Deliverables:**
- SSO/SAML/SCIM, advanced RBAC, org hierarchies, multi-region data residency.
- On-prem/hybrid deployment packaging (Helm charts, offline license server, air-gapped mode).
- White-label + custom domains, API platform + webhooks + developer portal, rate limits.
- VMS/ONVIF interop, integrations (access control, alarm panels, POS for retail theft correlation, SIEM/SOC).
- Compliance suite: audit exports, GDPR/HIPAA tooling, video access policies, privacy masking/redaction, legal hold.
- SLA/monitoring, multi-tenant billing at scale, usage analytics.

**Dependencies:** Phases 1–6.
**Development Order:** SSO/SCIM+advanced RBAC → on-prem/hybrid packaging → API platform/webhooks → integrations → compliance/privacy → white-label/domains → SLA/monitoring.
**Milestones:** M17 SSO + on-prem install; M18 POS+SIEM integration; M19 privacy/compliance pack.
**Timeline:** ~10–14 weeks.

---

## Phase 8 — AI Improvements (Model Expansion & MLOps)

**Objectives:** Expand to 40+ detections, raise accuracy, close the continuous-training loop.

**Deliverables:**
- Remaining detection catalog: weapon, violence/fight, fall/slip, shoplifting, employee theft, cash-counter monitoring, shelf/inventory, PPE full suite, mask, uniform, crowd/child/elderly, animal, speed, abandoned/removed refinements, action recognition.
- **MLOps loop:** dataset management (DVC), auto-labeling + human-in-the-loop, continuous training, model registry, A/B testing/shadow deploy, drift & performance monitoring, per-site fine-tuning.
- Model marketplace (partner-published models), edge model OTA updates, quantization (INT8) pipeline for edge.
- Active-learning from false positives/negatives flagged by customers.

**Dependencies:** Phases 3, 6, 7; labeled data from field.
**Development Order:** MLOps platform → dataset/labeling → continuous training + registry → A/B/shadow + drift monitoring → new models batched by demand → marketplace + OTA + quantization.
**Milestones:** M20 continuous-training pipeline live; M21 40+ detections GA; M22 marketplace beta.
**Timeline:** ~8–12 weeks (then ongoing).

---

## Phase 9 — Production, Scale & Launch

**Objectives:** Harden, scale to 1000+ cameras, and go GA with enterprise-grade operations.

**Deliverables:**
- Horizontal scaling: sharded MongoDB, GPU worker autoscaling, stream fan-out, multi-region, edge fleet management.
- Reliability: HA, backups + DR (RPO/RTO), chaos testing, graceful degradation, offline resilience.
- Security hardening: pen-test remediation, SAST/DAST, secrets, signed URLs, key rotation.
- Observability & SRE: metrics/traces/logs, SLOs, alerting, on-call, runbooks, status page.
- Load/stress testing to 1000+ cameras; cost/capacity model; blue-green/canary deploy; IaC (Terraform).
- Launch: docs, onboarding automation, support playbooks, billing/dunning, marketplace, partner/OEM program.

**Dependencies:** All prior phases.
**Development Order:** observability → scaling/sharding/autoscale → DR/backups → security hardening → load/stress test → deploy automation → fleet mgmt → GA launch ops.
**Milestones:** M23 1000-camera load test passed; M24 DR drill; M25 **Enterprise GA**.
**Timeline:** ~6–8 weeks concentrated, then continuous.

---

## Cross-Phase Dependency Graph

```
P1 Foundation ─> P2 Video Infra ─> P3 AI Detection ─> P4 Alert/Rule ─┬─> P5 Dashboard ─> P6 Analytics/Search
                                                                     │
                                                    P7 Enterprise <──┘ (needs P1–P6)
                                                    P8 AI/MLOps  <──── (needs P3,P6,P7 + field data)
   All ──────────────────────────────────────────> P9 Production/Scale/Launch
```

**Timeline summary:** MVP video+AI+alerts (P1–P4) ≈ **6–7 months → first revenue**; full analytics+enterprise (P5–P7) ≈ **+6 months**; model expansion + scale GA (P8–P9) ≈ **+4–6 months** → **~16–18 months to enterprise GA**, with sellable increments throughout.
