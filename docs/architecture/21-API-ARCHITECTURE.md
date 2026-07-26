# 21 — API Architecture

## Purpose
Define the API surface — REST, WebSocket, streaming, gRPC, webhooks — plus versioning, the developer platform, and how auth/authorization flow through it. Operationalizes Law 4 (API-first & contract-first).

## Responsibilities
- Provide a versioned, documented, tenant-scoped public API for every capability.
- Define internal (service-to-service) and streaming protocols and the developer platform.

---

## 1. API layers
- **Public REST/HTTP** (`/api/v1`, OpenAPI 3.1 generated from schemas) — the primary integration surface; envelope `{success, data, meta, error}`; tenant from JWT/host, scope via `X-Branch-Id`.
- **WebSocket** (Socket.IO/WS, Redis adapter) — live events, alerts, monitoring, presence.
- **Streaming** — RTSP/RTMP ingest; **WebRTC** (SDP/ICE) live; **HLS** playback; time-ranged playback via signed URLs.
- **Internal gRPC** (Protobuf) — service-to-service; low-latency, typed; never exposed publicly.
- **Webhooks** — outbound HMAC-signed event delivery with retries and delivery logs.

## 2. Representative REST surface
```
Identity/SaaS: /auth/*  /organizations  /branches  /sites  /zones  /users  /roles
               /plans  /subscriptions  /usage  /api-keys  /branding  /custom-domains
               /audit-logs  /feature-flags
Inventory:     /cameras (CRUD, discover, snapshot, health)  /cameras/:id/zones
               /cameras/:id/capabilities  /edge-devices  /edge-devices/:id/ota
Streaming:     /cameras/:id/live (WebRTC)  /cameras/:id/hls  /cameras/:id/playback
Capabilities:  /capabilities  /capabilities/:id/assignments   (model-agnostic config)
Registry/AI:   /models  /model-versions  /datasets  /training-runs  /ab-tests
Events:        /events (list/search)  /events/:id  /incidents  /incidents/:id/(ack|assign|resolve)
Rules:         /rules (CRUD)  /rules/:id/versions  /rules/:id/dry-run  /rule-packs
Workflows:     /workflows  /workflow-templates  /escalation-policies  /on-call
Evidence:      /evidence  /evidence/:id/download (signed)  /timelines/:cameraId  /exports  /legal-holds
Notifications: /notification-channels  /notifications
Analytics:     /analytics/*  /dashboards  /reports  /reports/:id/run  /report-schedules
Search:        /search (NL + filters)  /search/saved  /search/alerts
Plugins:       /plugins  /plugins/:id/(install|enable|disable)   (per-tenant)
Integrations:  /webhooks  /integrations
Platform:      /health  /ready  /metrics  /billing/*  /tenants (super-admin)
```

## 3. Versioning & compatibility
- URL-major (`/api/v1`) + semver within. Additive changes are non-breaking; breaking changes → new major + deprecation window + ADR ([00 §7](../00-ENGINEERING-CONSTITUTION.md)). OpenAPI/Protobuf are generated from the contracts in `packages/contracts` — docs and SDKs never drift from reality.

## 4. Auth & authorization (through the API)
- Every request: gateway validates JWT/API-key/mTLS → resolves tenant context → RBAC/ABAC policy → data-layer `tenantId`+scope filter → audited if sensitive. → [15](15-SECURITY-ARCHITECTURE.md), [06](06-MULTI-TENANT-SAAS.md)
- Hardening: per-tenant/key **rate limits**, **idempotency keys** on mutations, HMAC-signed webhooks, signed short-lived media URLs.

## 5. WebSocket model
```
namespaces: /events /alerts /monitoring /presence /live
rooms:      t:{tenantId}:b:{branchId}:site:{siteId}:cam:{cameraId}
auth:       JWT on connect; RBAC + scope enforced per subscription
```

## 6. Developer platform
- Public docs portal (from OpenAPI), sandbox tenant, generated **SDKs** (TS first; Python/others from the same contracts), scoped API keys, usage analytics, and webhook management. Enables partners/OEMs and customer integrations. → [20](20-EXTENSIBILITY.md)

## Design decisions
- **Contract-first, generated specs/SDKs** guarantee the API is the real interface and eliminates drift.
- **gRPC internally, REST/WS/streaming externally** matches each protocol to its job.
- **Every capability reachable via the public API** (Law 4) — no privileged internal-only paths.

## Advantages
- Integrations, mobile, web, and partners all consume one consistent, versioned surface.
- Backward compatibility is enforceable and sellable.

## Tradeoffs
- Contract-first + generation adds build tooling and discipline; repaid by zero drift and free SDKs.

## Future expansion
- GraphQL BFF for the console; API marketplace; fine-grained OAuth scopes for third-party apps; async API (AsyncAPI) docs for the event/webhook surface.

## Cross-references
[03-ARCHITECTURE-PRINCIPLES](03-ARCHITECTURE-PRINCIPLES.md) · [06-MULTI-TENANT-SAAS](06-MULTI-TENANT-SAAS.md) · [15-SECURITY-ARCHITECTURE](15-SECURITY-ARCHITECTURE.md) · [20-EXTENSIBILITY](20-EXTENSIBILITY.md)
