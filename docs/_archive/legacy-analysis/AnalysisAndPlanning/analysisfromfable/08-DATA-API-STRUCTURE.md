# 08 — Database Design, API Design & Folder Structure

---

## 1. Database Design (MongoDB)

Multi-tenant, row-level isolation via mandatory `tenantId`. Common fields on every doc: `_id, tenantId, createdAt, updatedAt, createdBy, isDeleted, version`; operational docs also carry `branchId/locationId/cameraId`.

### 1.1 Collections (by domain)

**SaaS / Identity**
`organizations`, `branches`, `locations`, `cameraGroups`, `users`, `roles`, `permissions`, `rolePermissions`, `userRoles`, `userScopes`, `sessions`, `refreshTokens`, `mfaSecrets`, `invitations`, `apiKeys`, `plans`, `subscriptions`, `invoices`, `usageCounters`, `credits`, `resellerAccounts`, `featureFlags`, `brandingConfigs`, `customDomains`, `auditLogs`, `activityLogs`, `notifications`, `configSettings`.

**Cameras / Video**
`cameras`, `cameraCredentials`(enc), `cameraHealth`, `streams`, `zones`(ROIs/lines), `recordings`, `ringBufferConfig`, `edgeDevices`, `edgeHealth`, `edgeDeployments`, `otaJobs`.

**AI / Models**
`models`, `modelVersions`, `modelAssignments`(camera↔model), `aiPacks`, `datasets`, `datasetVersions`, `trainingRuns`, `modelMetrics`, `abTests`, `driftReports`.

**Detections / Events**
`detections`(high-volume, short TTL), `tracks`, `events`, `eventEmbeddings`(vector), `behaviours`, `faceGalleries`, `faceEnrollments`, `plateWatchlists`, `cases`.

**Rules / Alerts**
`rules`, `ruleVersions`, `ruleTemplates`, `ruleState`, `escalationPolicies`, `onCallSchedules`, `notificationChannels`, `notificationDeliveries`.

**Clips / Storage**
`clips`, `clipSegments`, `timelines`, `storageQuotas`, `retentionPolicies`, `exports`(evidence).

**Analytics / Reports**
`analyticsAggregates`(materialized: footfall, occupancy, counts, heatmaps), `kpiSnapshots`, `dashboards`, `dashboardWidgets`, `reportDefinitions`, `reportSchedules`, `reportRuns`, `savedSearches`, `searchAudit`.

**Integrations**
`integrations`, `webhooks`, `webhookDeliveries`, `posEvents`(retail correlation), `accessControlEvents`.

### 1.2 Key Relationships
```
organization 1─* branch 1─* location 1─* cameraGroup 1─* camera 1─* zone
camera 1─* detections 1─* tracks ─* events 1─* clips
event *─1 rule (that fired) ; event 1─1 eventEmbedding (vector)
event *─* notificationDeliveries ; event *─1 case
camera *─* models (modelAssignments) ; model 1─* modelVersions
user *─* roles (userRoles) *─* permissions (rolePermissions) ; user *─* scopes
edgeDevice 1─* cameras ; tenant 1─* edgeDevices
```

### 1.3 Indexes (representative — always lead with `tenantId`)
```js
cameras.createIndex({ tenantId:1, branchId:1, status:1 })
events.createIndex({ tenantId:1, cameraId:1, type:1, timestamp:-1 })
events.createIndex({ tenantId:1, branchId:1, severity:1, timestamp:-1 })
events.createIndex({ tenantId:1, timestamp:-1 })                      // timeline/search
detections.createIndex({ tenantId:1, cameraId:1, ts:-1 })            // + TTL
detections.createIndex({ ts:1 }, { expireAfterSeconds: 172800 })     // 2-day raw TTL
clips.createIndex({ tenantId:1, cameraId:1, eventId:1 })
clips.createIndex({ tenantId:1, expiresAt:1 })                       // retention sweep
rules.createIndex({ tenantId:1, cameraGroupId:1, enabled:1 })
usageCounters.createIndex({ tenantId:1, metric:1, period:1 })
users.createIndex({ tenantId:1, email:1 }, { unique:true })
sessions.createIndex({ expiresAt:1 }, { expireAfterSeconds:0 })
eventEmbeddings → vector index (cosine) per-tenant namespace (Qdrant/Milvus/Atlas Vector)
analyticsAggregates.createIndex({ tenantId:1, branchId:1, metric:1, bucket:1 })
```

### 1.4 Retention Policies
- **Raw detections/tracks:** hours–2 days (TTL) — high volume, ephemeral; only aggregated.
- **Events/metadata:** per plan (7/30/90/custom days); safety-critical & legal-hold longer.
- **Clips:** per plan retention; hot→cold→delete lifecycle; legal hold overrides delete.
- **Analytics aggregates:** long-lived (small), power historical trends after raw data expires.
- **Audit logs:** long retention (compliance), append-only.
- Per-camera retention override; per-tenant residency; `retentionPolicies` collection drives sweeps (BullMQ cron).

### 1.5 Storage Optimization
- **Smart clips only** (no continuous cloud recording) → ~90%+ reduction ([Doc 05 §4](./05-PIPELINE-AND-ENGINES.md)).
- **Detections aggregated then expired** (store counts/heatmaps, not every box).
- **Thumbnails/sprites** for fast browsing without loading full clips.
- **Tiered object storage** (hot/cold/archive), H.265 transcode, dedupe/merge overlapping clips.
- **Sharding** by `tenantId` on `events`, `detections`, `clips`, `notifications`.
- **Read models** for dashboards (change-stream materialized) keep OLTP fast.

---

## 2. API Design

Base `/api/v1`, tenant-scoped (JWT + host), branch via `X-Branch-Id`. Envelope `{success,data,meta,error}`. OpenAPI 3.1 generated from Zod.

### 2.1 REST APIs (representative)
```
Auth/SaaS:   /auth/*  /organizations  /branches  /locations  /camera-groups
             /users  /roles  /permissions  /plans  /subscriptions  /usage
             /api-keys  /branding  /custom-domains  /audit-logs  /feature-flags
Cameras:     /cameras (CRUD)  /cameras/:id/health  /cameras/:id/snapshot
             /cameras/discover (ONVIF)  /cameras/:id/zones  /cameras/:id/models
             /edge-devices  /edge-devices/:id/ota
Streaming:   /cameras/:id/live (WebRTC offer/answer)  /cameras/:id/hls
             /cameras/:id/playback?from&to
AI/Models:   /models  /model-versions  /ai-packs  /cameras/:id/assignments
             /datasets  /training-runs  /ab-tests
Events:      /events (list/search)  /events/:id  /events/:id/ack|assign|resolve
             /detections (debug)  /tracks  /cases  /face-galleries  /plate-watchlists
Rules:       /rules (CRUD)  /rules/:id/versions  /rules/:id/dry-run  /rule-templates
Clips:       /clips  /clips/:id  /clips/:id/download (signed)  /timelines/:cameraId
             /exports (evidence)
Alerts:      /notifications  /escalation-policies  /on-call  /notification-channels
Analytics:   /analytics/footfall|occupancy|heatmap|queue|counting|compliance
             /dashboards  /kpis  /reports  /reports/:id/run  /reports/schedules
Search:      /search (NL + filters)  /search/saved  /search/alerts
Integrations:/webhooks  /integrations  /pos/events  /access-control/events
Platform:    /health  /ready  /metrics  /billing/*  /tenants (super-admin)
```

### 2.2 WebSocket APIs (Socket.IO, Redis adapter)
```
namespace /alerts       → alert:new, alert:ack, alert:escalated
namespace /live         → live camera signaling / status
namespace /monitoring   → wall updates, camera health, occupancy live
namespace /presence     → user/guard presence, on-call status
namespace /events       → event:new (live feed), event:updated
Rooms: t:{tenantId}:b:{branchId}:cg:{cameraGroupId}:cam:{cameraId}
Auth on connect (JWT); RBAC + tenant scope enforced per subscription.
```

### 2.3 Streaming APIs
- **Ingest:** RTSP pull / RTMP push endpoints (media server), ONVIF discovery.
- **Live:** **WebRTC** (SDP offer/answer, ICE) for sub-second live view; **HLS** (`.m3u8`) for scalable/mobile playback.
- **Playback:** time-ranged HLS/MP4 of recordings/clips via signed URLs.
- All stream URLs are **short-lived signed tokens**, authorized per camera per user.

### 2.4 Authentication & Permissions
- **Auth:** JWT access (short-lived) + rotating refresh (reuse detection); MFA; SSO/OIDC/SAML (Enterprise); API keys (scoped, rate-limited, IP-allowlist) for machine access; signed URLs for media/clips.
- **Authorization:** RBAC → permission (`resource:action`) → scope (`camera-group/location/branch/tenant`) → row-level `tenantId` filter. Enforced on every REST/WS/stream endpoint.
- **Hardening:** rate limits per tenant/key, idempotency keys on mutations, HMAC-signed webhooks, audit on all sensitive actions.

---

## 3. Folder Structure (Monorepo — pnpm + Turborepo)

```
sentinelvision/
├── apps/
│   ├── api/                 # Node/Express control+data plane (REST + WS)
│   ├── media-server/        # ingest, transcode, HLS/WebRTC (Node + FFmpeg/GStreamer)
│   ├── workers/             # BullMQ: clip transcode, embeddings, reports, retention, OTA
│   ├── web/                 # React 19 tenant app (dashboards, live, search)
│   ├── admin/               # React super-admin console
│   └── mobile/
│       ├── owner-app/  manager-app/  guard-app/  field-app/  platform-admin-app/  # Expo
├── ai/                      # Python AI services
│   ├── inference/           # runtime: model loading, batching, GPU sched (ONNX/TensorRT/OpenVINO)
│   │   ├── engines/         # detection, tracking, recognition, pose, behaviour
│   ├── models/              # model definitions, pre/post-processing, exporters
│   ├── pipelines/           # per-camera pipeline orchestration
│   ├── search/              # CLIP embeddings, captioning, NL query parsing
│   ├── training/            # training scripts, datasets, augmentation
│   ├── mlops/               # registry, versioning, drift, A/B, continuous-training
│   ├── edge/                # edge agent (Docker), quantization, OTA client
│   └── serving/             # gRPC/HTTP model servers (Triton optional)
├── packages/                # shared
│   ├── types/  validation(zod)/  api-client/  ui(shadcn)/  permissions/
│   ├── config/  i18n/  utils/  mobile-core/  event-schema/
├── infra/
│   ├── docker/              # Dockerfiles + compose (dev)
│   ├── k8s/                 # Helm charts (api, media, workers, ai, edge)
│   ├── terraform/           # cloud IaC (GPU nodes, DB, storage, DNS, CDN)
│   └── nginx/               # gateway / stream edge
├── docs/                    # OpenAPI, ADRs, runbooks, model cards
├── .github/workflows/       # CI/CD (build, test, scan, deploy, EAS, model CI)
├── turbo.json  pnpm-workspace.yaml  package.json
```

**Backend (`apps/api`)** — layered: routes→controllers→services→repositories, middleware (auth/tenant/authorize/validate/rate-limit/idempotency), `core/` (context, db, redis, events/outbox, plugins), `modules/` feature-sliced (auth, orgs, cameras, events, rules, clips, alerts, analytics, search, billing, integrations), `realtime/` socket gateways.

**Frontend (`apps/web`)** — feature-sliced: `features/{live, cameras, events, rules, clips, analytics, search, reports, settings, admin}`, shared `components/ui`, `hooks` (useAuth/usePermissions/useSocket), WebRTC/HLS players, `PermissionGate`/`FeatureGate`.

**Python AI (`ai/`)** — engine-per-module ([Doc 05 §2](./05-PIPELINE-AND-ENGINES.md)); model-agnostic runtime; edge & cloud build targets; MLOps ([Doc 09](./09-MLOPS-SECURITY-PERFORMANCE.md)).

**Mobile (`apps/mobile/*`)** — expo-router, shared `mobile-core`, offline queue, push, white-label build profiles.
