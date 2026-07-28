# API Inventory

> Every API endpoint across all services. Updated whenever an endpoint is added, changed, or removed.
>
> Schema per endpoint: **Service · Method+Endpoint · Purpose · Authentication · Input · Output · Dependencies · Status · Version**.
> Status: `stable` · `beta` · `scaffold` (infra-only, no business logic) · `deprecated`.

## @vip/service-identity (v0.1.0)

> Phase 1 P1-2. Authentication + authorization. Users tenant-scoped (`@vip/tenancy`); tokens via `@vip/auth`; routes gated by `@vip/permissions`. Infra endpoints (`/health` `/ready` `/metrics` `/`) as the template. `/ready` includes a `mongo` check.

| Method | Endpoint                          | Purpose                             | Auth          | Input             | Output                                         | Dependencies                    | Status   | Version |
| ------ | --------------------------------- | ----------------------------------- | ------------- | ----------------- | ---------------------------------------------- | ------------------------------- | -------- | ------- |
| POST   | `/auth/login`                     | Authenticate within a tenant        | `x-tenant-id` | `LoginInput`      | `200 {success,data:TokenPair}` · `401` · `400` | Mongo, @vip/auth                | beta     | 0.1.0   |
| POST   | `/auth/refresh`                   | Rotate token pair (reuse-detection) | refresh token | `RefreshInput`    | `200 {success,data:TokenPair}` · `401`         | Mongo, @vip/auth                | beta     | 0.1.0   |
| POST   | `/auth/logout`                    | Revoke the refresh-token family     | refresh token | `RefreshInput`    | `204`                                          | Mongo                           | beta     | 0.1.0   |
| GET    | `/auth/me`                        | Principal from the access token     | Bearer        | —                 | `200 {success,data:Principal}` · `401`         | @vip/auth                       | beta     | 0.1.0   |
| POST   | `/users`                          | Create a user (tenant-scoped)       | `user:create` | `CreateUserInput` | `201 {success,data:User}` · `401/403/409`      | Mongo, @vip/tenancy/permissions | beta     | 0.1.0   |
| GET    | `/users`                          | List the tenant's users             | `user:read`   | —                 | `200 {success,data:User[]}` · `401/403`        | Mongo, @vip/tenancy             | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness/readiness/metrics/info     | None          | —                 | infra (as template)                            | prom-client                     | scaffold | 0.1.0   |

## @vip/service-gateway (v0.1.0)

> Phase 1 P1-2. The trust boundary: edge token validation + context-forwarding reverse proxy. Injects trusted `x-tenant-id`/`x-principal-id`/`x-roles` from the token and strips client-supplied ones.

| Method | Endpoint                          | Purpose                                           | Auth   | Output                                                  | Dependencies         | Status   | Version |
| ------ | --------------------------------- | ------------------------------------------------- | ------ | ------------------------------------------------------- | -------------------- | -------- | ------- |
| GET    | `/whoami`                         | Resolve + return the caller's context             | Bearer | `200 {success,data:{principalId,tenantId,...}}` · `401` | @vip/auth            | beta     | 0.1.0   |
| ALL    | `/api/:service/*`                 | Reverse-proxy to an upstream with trusted context | Bearer | upstream response · `401` · `404` · `502`               | @vip/auth, upstreams | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness/readiness/metrics/info                   | None   | infra (as template)                                     | prom-client          | scaffold | 0.1.0   |

**Conventions (all services):**

- Every response carries a correlation id — inbound `x-request-id` is honoured, else one is generated (`genReqId`).
- Errors use the `@vip/contracts` `ApiError` envelope: `{ success:false, error:{ code, message, correlationId, details? } }`. 5xx messages are opaque (real cause logged server-side).
- Tenant context (when present) is validated against the `TenantContext` contract via `x-tenant-id` / `x-principal-id` headers — **seam only in Phase 0**, enforced from P1.
- Security headers set by `@fastify/helmet` (`x-content-type-options: nosniff`, `x-frame-options: SAMEORIGIN`, …).

## @vip/service-tenant (v0.1.0)

> Phase 1 P1-1. Provisions tenants + org hierarchy; enforces fail-closed isolation (`@vip/tenancy`). Auth arrives in P1-2 — until then provisioning is open and tenant context comes from `x-tenant-id`/`x-principal-id` headers. Every tenant-addressed route refuses a path naming a different tenant than the caller's context (**cross-tenant → 403**).

| Method | Endpoint                          | Purpose                               | Auth             | Input                | Output                                          | Dependencies        | Status   | Version |
| ------ | --------------------------------- | ------------------------------------- | ---------------- | -------------------- | ----------------------------------------------- | ------------------- | -------- | ------- |
| POST   | `/tenants`                        | Provision a tenant + org root         | None (P1-2 adds) | `CreateTenantInput`  | `201 {success,data:{tenant,orgRoot}}` · `409`   | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/tenants/:tenantId`              | Get the caller's tenant               | tenant context   | —                    | `200 {success,data:Tenant}` · `401/403/404`     | Mongo, @vip/tenancy | beta     | 0.1.0   |
| PATCH  | `/tenants/:tenantId`              | Update name / lifecycle status        | tenant context   | `UpdateTenantInput`  | `200 {success,data:Tenant}` · `401/403/404`     | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/tenants/:tenantId/org-nodes`    | List the tenant's org nodes           | tenant context   | —                    | `200 {success,data:OrgNode[]}` · `401/403`      | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/tenants/:tenantId/org-nodes`    | Create an org-hierarchy node          | tenant context   | `CreateOrgNodeInput` | `201 {success,data:OrgNode}` · `400/401/403`    | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info | None             | —                    | as identity (`/ready` includes a `mongo` check) | prom-client         | scaffold | 0.1.0   |

## @vip/service-camera (v0.1.0)

> Phase 1 P1-3. Camera inventory: onboard cameras into the tenant-owned org hierarchy (`zoneId` → `OrgNode`), vault credentials at rest (`@vip/crypto`, AES-256-GCM), publish `camera.*` lifecycle events. Verifies the identity-issued Bearer token itself (`iss=identity`, `aud=vip`); every route is permission-gated (deny-by-default) and tenant-scoped from the token — a camera in another tenant is a **404** (no existence leak). **Credentials are never returned** (only `hasCredentials`).

| Method | Endpoint                          | Purpose                                 | Auth            | Input                  | Output                                          | Dependencies                     | Status   | Version |
| ------ | --------------------------------- | --------------------------------------- | --------------- | ---------------------- | ----------------------------------------------- | -------------------------------- | -------- | ------- |
| POST   | `/cameras`                        | Onboard a camera (vault credentials)    | `camera:create` | `CreateCameraInput`    | `201 {success,data:Camera}` · `400/401/403/409` | Mongo, @vip/tenancy, @vip/crypto | beta     | 0.1.0   |
| GET    | `/cameras`                        | List the tenant's cameras               | `camera:read`   | —                      | `200 {success,data:Camera[]}` · `401/403`       | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| GET    | `/cameras/:id`                    | Get one camera (own tenant)             | `camera:read`   | —                      | `200 {success,data:Camera}` · `401/403/404`     | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| PATCH  | `/cameras/:id`                    | Update / re-vault credentials           | `camera:update` | `UpdateCameraInput`    | `200 {success,data:Camera}` · `400/401/403/404` | Mongo, @vip/tenancy, @vip/crypto | beta     | 0.1.0   |
| DELETE | `/cameras/:id`                    | Remove a camera from inventory          | `camera:delete` | —                      | `204` · `401/403/404`                           | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| GET    | `/cameras/:id/health`             | Camera observed health (unknown → P1-4) | `camera:read`   | —                      | `200 {success,data:CameraHealthReport}` · `404` | Mongo, @vip/tenancy              | beta     | 0.1.0   |
| POST   | `/cameras/discover`               | ONVIF/network discovery (stub)          | `camera:create` | `DiscoverCamerasInput` | `501 not_implemented`                           | —                                | stub     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info   | None            | —                      | as identity (`/ready` includes a `mongo` check) | prom-client                      | scaffold | 0.1.0   |

### Internal (service-to-service, not gateway-exposed)

| Method | Endpoint                       | Purpose                                                        | Auth                             | Output                                                |
| ------ | ------------------------------ | -------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| GET    | `/internal/cameras/:id/stream` | Resolve a camera's connection **with decrypted creds** (media) | `x-internal-key` + `x-tenant-id` | `200 {success,data:StreamConnection}` · `401/400/404` |

> Camera context, P1-4. The single sanctioned credential-decryption point; the gateway **strips**
> client `x-internal-key`, so only trusted internal services reach it ([ED-0025](ENGINEERING_DECISION_LOG.md)).

## @vip/service-media (v0.1.0)

> Phase 1 P1-4. Per-camera ingestion workers: connect RTSP/RTMP (creds from camera), decode (ffmpeg), extract frames, record segments to tenant-scoped MinIO (`{tenantId}/{cameraId}/recordings/…`, @vip/storage). Auto-reconnect with backoff; emits `media.stream.*` + `media.recording.segment`. Verifies the identity token itself (`iss=identity`); tenant from the token — another tenant's stream is a **404**.

| Method | Endpoint                          | Purpose                               | Auth             | Output                                            | Dependencies                 | Status   | Version |
| ------ | --------------------------------- | ------------------------------------- | ---------------- | ------------------------------------------------- | ---------------------------- | -------- | ------- |
| POST   | `/streams/:cameraId/start`        | Start a camera's ingestion worker     | `stream:control` | `202 {success,data:StreamStatus}` · `401/403`     | @vip/storage, camera, ffmpeg | beta     | 0.1.0   |
| POST   | `/streams/:cameraId/stop`         | Stop the worker (no reconnect)        | `stream:control` | `200 {success,data:StreamStatus}` · `401/403/404` | —                            | beta     | 0.1.0   |
| GET    | `/streams/:cameraId/status`       | Worker status                         | `stream:read`    | `200 {success,data:StreamStatus}` · `401/403/404` | —                            | beta     | 0.1.0   |
| GET    | `/streams`                        | List the tenant's workers             | `stream:read`    | `200 {success,data:StreamStatus[]}` · `401/403`   | —                            | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | Liveness / readiness / metrics / info | None             | as template (`/ready` includes a `storage` check) | prom-client, @vip/storage    | scaffold | 0.1.0   |

## @vip/service-events (v0.1.0)

> Phase 1 P1-5. The Event context: consumes capability outputs off NATS JetStream (`t.*.capability.output.*`), normalizes each `DetectionResult` → `EventEnvelope` (label → catalog type), deduplicates + persists tenant-scoped to Mongo (unique `{tenantId,dedupKey}` index), and re-publishes on `t.{tenant}.event.*` (the `event.persisted` signal). Fail-closed dead-lettering on missing/invalid tenant. Verifies the identity token itself (`iss=identity`); tenant from the token — a query never widens across tenants.

| Method | Endpoint                          | Purpose                                       | Auth           | Input                | Output                                                 | Dependencies          | Status   | Version |
| ------ | --------------------------------- | --------------------------------------------- | -------------- | -------------------- | ------------------------------------------------------ | --------------------- | -------- | ------- |
| GET    | `/events`                         | Tenant-scoped, cursor-paged, filtered query   | `event:read`   | `EventQuery` (query) | `200 {success,data:EventPage}` · `400/401/403`         | Mongo, @vip/tenancy   | beta     | 0.1.0   |
| POST   | `/events/replay`                  | Re-publish a bounded window onto the backbone | `event:replay` | `EventReplayRequest` | `200 {success,data:EventReplayResult}` · `400/401/403` | @vip/messaging, Mongo | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info      | None           | —                    | infra (`/ready` includes a `mongo` check)              | prom-client, Mongo    | scaffold | 0.1.0   |

> **Consumes** (NATS, not HTTP): `t.*.capability.output.*` (capability outputs). **Publishes:** `t.{tenantId}.event.{type}` (`event.persisted`).

## @vip/service-rules (v0.1.0)

> Phase 1 P1-7. The Rule Context (automation brain): consumes `event.persisted` off NATS and evaluates tenant-defined, **versioned** rules (a pure **sandboxed predicate DSL** over the `EventEnvelope` — never `DetectionResult`) with optional windowed thresholds, emitting `incident.candidate` + `rule.matched`. Rules carry a lifecycle (`draft`→`enabled`→…) + priority; every change is audited. Verifies the identity token itself (`iss=identity`); tenant from the token — a rule in another tenant is a **404**. Distinct from the Policy Engine (ADR-0013).

| Method | Endpoint                          | Purpose                                      | Auth          | Input             | Output                                              | Dependencies        | Status   | Version |
| ------ | --------------------------------- | -------------------------------------------- | ------------- | ----------------- | --------------------------------------------------- | ------------------- | -------- | ------- |
| POST   | `/rules`                          | Create a rule (version 1 + audit)            | `rule:create` | `CreateRuleInput` | `201 {success,data:Rule}` · `400/401/403`           | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/rules`                          | List the tenant's rules                      | `rule:read`   | —                 | `200 {success,data:Rule[]}` · `401/403`             | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/rules/:id`                      | Get one rule (own tenant)                    | `rule:read`   | —                 | `200 {success,data:Rule}` · `401/403/404`           | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/rules/:id/versions`             | Rule audit trail (newest first)              | `rule:read`   | —                 | `200 {success,data:RuleVersionRecord[]}` · `404`    | Mongo, @vip/tenancy | beta     | 0.1.0   |
| POST   | `/rules/:id/dry-run`              | Test vs a sample event (**no side effects**) | `rule:read`   | `RuleDryRunInput` | `200 {success,data:RuleDryRunResult}` · `400/404`   | Mongo, @vip/tenancy | beta     | 0.1.0   |
| PATCH  | `/rules/:id`                      | Update (version bump + audit)                | `rule:update` | `UpdateRuleInput` | `200 {success,data:Rule}` · `400/401/403/404`       | Mongo, @vip/tenancy | beta     | 0.1.0   |
| DELETE | `/rules/:id`                      | Remove (final `deleted` audit snapshot)      | `rule:delete` | —                 | `204` · `401/403/404`                               | Mongo, @vip/tenancy | beta     | 0.1.0   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info     | None          | —                 | infra (`/ready` = Mongo; `/metrics` = eval metrics) | prom-client, Mongo  | scaffold | 0.1.0   |

> **Consumes** (NATS, not HTTP): `t.*.event.*` (`event.persisted`). **Publishes:** `t.{tenantId}.incident.candidate`, `t.{tenantId}.rule.matched`.

## inference (ai/inference, Python — v0.1.0)

> Phase 1 P1-6. The AI capability runtime (Perception context). Manifest-driven capabilities, model-agnostic (selector→registry via the adapter layer), staged pipeline, lifecycle states, metrics, version-stamped results. Internal (called by the pipeline, not user-facing); `/infer` is `x-internal-key` gated and fail-closed on missing tenant. Stdlib `http.server` transport.

| Method | Endpoint                          | Purpose                                            | Auth             | Input              | Output                                                   | Status |
| ------ | --------------------------------- | -------------------------------------------------- | ---------------- | ------------------ | -------------------------------------------------------- | ------ |
| POST   | `/infer`                          | Run a capability over one frame                    | `x-internal-key` | `InferenceRequest` | `200 {success,data:DetectionResult}` · `400/401/404/500` | beta   |
| GET    | `/capabilities`                   | Descriptors of all loaded capabilities (discovery) | None             | —                  | `200 {success,data:CapabilityDescriptor[]}`              | beta   |
| GET    | `/status`                         | Per-capability lifecycle state + metrics           | None             | —                  | `200 {success,data:[…]}`                                 | beta   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / Prometheus / info           | None             | —                  | infra (`/ready` = default capability READY)              | beta   |

## Infrastructure services (third-party APIs in the dev stack)

> Not VIP-authored endpoints; listed so integrators know what the stack exposes. Dev only, network-restricted, no auth (R-014).

| Service | Endpoint                                            | Purpose                                                      | Auth                                   | Status |
| ------- | --------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- | ------ |
| MLflow  | `http://localhost:45000/` (UI)                      | Model Registry + experiment tracking UI                      | None (dev)                             | infra  |
| MLflow  | `GET /health`                                       | Liveness (used by the compose healthcheck)                   | None                                   | infra  |
| MLflow  | `/api/2.0/mlflow/*` (REST)                          | Tracking + Model Registry REST API (used by `mlflow` client) | None (dev); `--allowed-hosts` enforced | infra  |
| MinIO   | `http://localhost:49001/` (console) · `:49000` (S3) | Object storage (MLflow artifacts, DVC datasets)              | root creds                             | infra  |

## Planned (not yet implemented)

| Service  | Endpoint (target)                              | Phase | Notes                                 |
| -------- | ---------------------------------------------- | ----- | ------------------------------------- |
| identity | `POST /auth/*`, `GET/POST /users`, `/api-keys` | P1    | OIDC/JWT/refresh(reuse-detection)/MFA |
| gateway  | public REST/OpenAPI + WS surface               | P1    | authN/Z, tenant routing, rate limit   |
| tenant   | `/tenants`, config/entitlements                | P1    |                                       |

_Add rows as each service exposes endpoints; keep this table in sync with each service README and the generated OpenAPI (from `@vip/contracts`)._
