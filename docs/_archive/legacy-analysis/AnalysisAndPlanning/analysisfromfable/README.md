# SentinelVision — AI Video Intelligence Platform (by PaperlessTech)

**Master Product Blueprint — Planning to Production**

A commercial, ERP-grade, multi-tenant AI Video Intelligence SaaS that turns ordinary CCTV into an autonomous observer — detecting important activity, extracting only relevant clips, raising alerts, generating reports, and letting users **search events in natural language instead of watching hours of footage**. Scales from **1 camera to 1000+ cameras** across cloud, on-premise, hybrid and edge deployments.

Comparable to Verkada, Eagle Eye Networks, BriefCam, Avigilon, Axis, Rhombus, Ambient.ai, Milestone, AnyVision, OpenEye and Cisco Meraki Vision.

---

## Document Index

| # | Document | Covers |
|---|----------|--------|
| 00 | [README](./README.md) | Product vision, mission, goals, customers, industries, competitive advantages, revenue & pricing |
| 01 | [Phase-Wise Development Plan](./01-PHASE-WISE-PLAN.md) | 9 phases — objectives, deliverables, dependencies, order, milestones, timeline |
| 02 | [SaaS Architecture](./02-SAAS-ARCHITECTURE.md) | Multi-tenancy, isolation, plans, orgs/users/roles/permissions, branches, locations, camera groups, quotas, API keys, billing, branding, domains |
| 03 | [AI Detection Catalog](./03-AI-DETECTION-CATALOG.md) | 60+ detection models — purpose, I/O, datasets, pipeline, accuracy, hardware, edge/cloud, future |
| 04 | [Industry Solutions](./04-INDUSTRY-SOLUTIONS.md) | 13 industries — problems, AI features, dashboards, reports, alerts, benefits |
| 05 | [Video Pipeline & AI Architecture](./05-PIPELINE-AND-ENGINES.md) | End-to-end pipeline, the 9 engines, rule engine, smart clip extraction, natural-language search |
| 06 | [Dashboards, Notifications & Mobile](./06-DASHBOARD-NOTIFY-MOBILE.md) | All dashboards, notification channels & escalation, 5 mobile apps |
| 07 | [Hardware & Deployment](./07-HARDWARE-DEPLOYMENT.md) | Sizing per segment, edge devices, servers, cloud, bandwidth; cloud/on-prem/hybrid/edge/offline models |
| 08 | [Data, API & Folder Structure](./08-DATA-API-STRUCTURE.md) | MongoDB design, retention/storage, REST/WebSocket/streaming APIs, monorepo layout |
| 09 | [MLOps, Security & Performance](./09-MLOPS-SECURITY-PERFORMANCE.md) | Training→registry→deploy→monitor, security/privacy/GDPR/HIPAA, scaling 1→1000+ cameras |
| 10 | [Delivery & Business Roadmap](./10-DELIVERY-BUSINESS-ROADMAP.md) | Testing strategy, Year 1–3 business plan, sprint plan, priority matrix, checklists, risk |
| 11 | [Completeness Review](./11-COMPLETENESS-REVIEW.md) | Verification that no commercial VMS/VSaaS feature is missed |

---

## 1. Product Vision

### Mission
**Make every camera intelligent.** Give any organization — from a single-shop owner to a 1000-camera enterprise — an AI that watches continuously, understands what matters, and surfaces it as searchable events, instant alerts and clear reports, so humans never have to scrub footage again.

### Business Goals
1. Ship a **sellable single-camera SaaS** within ~4 months and a **multi-site enterprise platform** within ~18 months.
2. Achieve **camera-based recurring revenue** (per-camera-per-month) with high gross margin via edge offload.
3. Reach **10 detection use-cases GA** in Year 1, **40+** by Year 2.
4. Land **3 lighthouse enterprise logos** and a **channel/OEM program** by Year 2.
5. Maintain **>95% precision on safety-critical detections** (fire, weapon, fall) at customer sites.
6. Be **deployment-agnostic** — the same product runs cloud, on-prem, hybrid, and fully offline edge.

### Target Customers
- **SMB owners** (single/few cameras) — self-serve, plug-and-play.
- **Multi-site operators** (retail chains, franchises) — centralized monitoring.
- **Enterprise security & operations teams** — SOC integration, compliance.
- **System integrators / MSPs / OEMs** — white-label & reseller.

### Target Industries
Retail, Supermarkets, Small Shops, Warehouses, Factories, Schools, Hospitals, Hotels, Restaurants, Banks, Apartments/Residential, Corporate Offices, Construction Sites. (Full solutions in [Doc 04](./04-INDUSTRY-SOLUTIONS.md).)

### Competitive Advantages
1. **Deploy-anywhere architecture** — one codebase runs cloud, on-prem, hybrid, edge and offline (many competitors are cloud-only or appliance-only).
2. **Natural-language event search** — "show possible theft yesterday" (BriefCam/Ambient-class capability made self-serve).
3. **Bring-your-own-camera** — works with any ONVIF/RTSP camera; no hardware lock-in (unlike Verkada/Rhombus/Avigilon).
4. **Edge-first economics** — heavy inference at the edge (Jetson/OpenVINO/TensorRT) slashes cloud/bandwidth cost → best-in-class per-camera pricing.
5. **No-code drag-and-drop rule engine** — customers build their own detections/automations.
6. **Smart clip extraction** — stores only events (pre/post roll) → 90%+ storage reduction vs continuous recording.
7. **Modular model marketplace** — 60+ detections toggled per plan; partners can publish models.
8. **Privacy-by-design** — on-device face blurring, consent controls, region-pinned data, HIPAA/GDPR posture.

### Revenue Model
- **Per-camera SaaS subscription** (primary) — tiered by resolution/retention/AI packs.
- **AI add-on packs** (LPR, facial recognition, PPE, retail analytics) as upsells.
- **Storage/retention tiers** (cloud clip storage GB/months).
- **Edge appliance sales/lease** (SentinelVision Edge Box — Jetson/mini-PC).
- **Professional services** (integration, custom models, deployment).
- **White-label / OEM licensing** and **revenue-share marketplace** for partner models.
- **Enterprise contracts** (volume, SLA, on-prem license + support).

### Pricing Strategy (illustrative)
| Plan | Target | Price (per camera / mo) | Includes |
|------|--------|-------------------------|----------|
| **Starter** | Small shop (1–4 cams) | $9–15 | Core detection (person/vehicle/object), 7-day clip cloud, 1 AI pack, mobile app |
| **Business** | Multi-cam SMB (up to 32) | $19–29 | 5 AI packs, 30-day retention, rule engine, NL search, analytics, escalation |
| **Pro** | Multi-site (up to 256) | $29–49 | All AI packs, 90-day retention, LPR/FR, heatmaps, API, SSO |
| **Enterprise** | 256–1000+ | Custom | On-prem/hybrid, unlimited packs, custom models, SLA, white-label, dedicated support |
| **Edge Box** | Any | Hardware + $ | One-time/lease appliance; offline-capable |

Add-ons: extra retention, additional AI packs, SMS/voice/WhatsApp credits, extra storage, premium support. Free 14-day trial + freemium single-camera tier for acquisition.

---

## 2. Platform at a Glance

```
                Cameras (ONVIF/RTSP/RTMP)  ─────────────┐
                                                        │
   ┌───────────── EDGE (Jetson / Mini-PC / Server + GPU) ──────────────┐
   │  Ingest → Decode → Frame Sampler → Detection → Tracking →         │
   │  Pose/Recognition → Behaviour → Rule Engine → Event/Clip → Sync    │
   │  (TensorRT / OpenVINO / ONNX)   [runs offline if WAN down]         │
   └───────────────┬───────────────────────────────────────────────────┘
                   │ events + thumbnails + clips (not raw video)
                   ▼
   ┌──────────────── CLOUD CONTROL/DATA PLANE (per region) ────────────┐
   │  API (Node/Express) · Realtime (WS) · BullMQ workers              │
   │  Cloud AI (heavy models, batch, NL search embeddings)            │
   │  MongoDB · Redis · Object Storage (MinIO/S3/Blob) · Vector DB     │
   │  Rule/Alert/Analytics/Search engines · Billing · Multi-tenant    │
   └───────────────┬───────────────────────────────────────────────────┘
                   ▼
     Web App (React 19) · Mobile Apps (Expo) · Notifications · Reports · API/Webhooks
```

**Hybrid principle:** Edge does real-time inference and only ships **events, metadata, thumbnails and short clips** upstream (privacy + bandwidth). Cloud does orchestration, heavy/batch AI, search, analytics, multi-site aggregation and billing. Pure cloud and pure on-prem are the same stack with the edge/cloud split relocated.

---

## 3. Non-Functional Requirements

| Area | Target |
|------|--------|
| Availability | 99.9% cloud control plane; edge continues autonomously during WAN outage |
| Detection latency (edge) | < 300 ms frame-to-event for real-time models |
| Alert latency | < 3 s event-to-notification (critical events) |
| Scale | 1 → 1000+ cameras per tenant; multi-tenant to 100k+ cameras platform-wide |
| Storage efficiency | ≥ 90% reduction via smart clip extraction vs continuous recording |
| Model precision | ≥ 95% on safety-critical (fire/weapon/fall); ≥ 90% general |
| Security | TLS 1.3, AES-256 at rest, per-tenant isolation, signed stream URLs |
| Compliance | GDPR, HIPAA-aware, regional data residency, configurable retention |
| Offline | Edge fully functional offline; sync on reconnect |

---

## 4. Global Tech Stack

- **Frontend:** React 19 + TypeScript + Vite + Tailwind + Shadcn UI + TanStack Query + Zustand
- **Backend:** Node.js + Express + TypeScript (control/data plane, APIs, realtime)
- **AI services:** Python + PyTorch/TensorFlow + OpenCV + ONNX Runtime + YOLO + MediaPipe + DeepSORT/ByteTrack + SAM + CLIP; accelerated via OpenVINO / TensorRT / CUDA
- **Data:** MongoDB + Redis + Vector DB (Qdrant/Milvus) for semantic search
- **Queue:** BullMQ (Redis)
- **Storage:** MinIO / AWS S3 / Azure Blob (clips, thumbnails, models)
- **Streaming:** RTSP/RTMP ingest, WebRTC (low-latency live), HLS (scalable playback)
- **Mobile:** React Native (Expo)
- **Infra:** Docker, Kubernetes, NVIDIA CUDA; edge on Jetson/OpenVINO mini-PCs
- **Observability:** OpenTelemetry, Prometheus/Grafana, Loki, Sentry

> Read **01 (Phases)** for sequence, **02–09** for the technical contracts, **10** to run the business & program, **11** for the completeness gate.
