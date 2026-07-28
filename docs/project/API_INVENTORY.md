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
