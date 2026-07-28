# API Inventory

> Every API endpoint across all services. Updated whenever an endpoint is added, changed, or removed.
>
> Schema per endpoint: **Service · Method+Endpoint · Purpose · Authentication · Input · Output · Dependencies · Status · Version**.
> Status: `stable` · `beta` · `scaffold` (infra-only, no business logic) · `deprecated`.

## @vip/service-identity (v0.1.0)

> Phase 0 scaffold — infrastructure endpoints only. Business APIs (`/auth/*`, `/users`, `/api-keys`) arrive in P1 (see [docs/architecture/23](../architecture/23-SERVICE-OWNERSHIP.md) › identity).

| Method | Endpoint   | Purpose                                  | Auth                      | Input | Output                                                      | Dependencies                    | Status   | Version |
| ------ | ---------- | ---------------------------------------- | ------------------------- | ----- | ----------------------------------------------------------- | ------------------------------- | -------- | ------- |
| GET    | `/health`  | Liveness probe (process is up)           | None                      | —     | `200 {"status":"ok"}`                                       | none                            | scaffold | 0.1.0   |
| GET    | `/ready`   | Readiness probe (dependencies reachable) | None                      | —     | `200 {"status":"pass","checks":[]}` / `503` on fail         | ReadinessRegistry (empty in P0) | scaffold | 0.1.0   |
| GET    | `/metrics` | Prometheus exposition                    | None (network-restricted) | —     | `200` text/plain; per-instance registry, `service` label    | prom-client                     | scaffold | 0.1.0   |
| GET    | `/`        | Service-info snapshot                    | None                      | —     | `200 {success,data:{name,version,startedAt,uptimeSeconds}}` | —                               | scaffold | 0.1.0   |

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
