# @vip/service-identity

The **Identity context** service (also the repository's **reference Fastify service template**).
Owns users, credentials, and refresh-token lineage; authenticates principals and mints the access
tokens whose claims become the platform's `TenantContext`.

> **Phase 1 (P1-2):** real authentication + authorization. Users are tenant-scoped
> ([@vip/tenancy](../../packages/tenancy/README.md)); passwords hashed with scrypt and tokens signed
> with jose ([@vip/auth](../../packages/auth/README.md)); routes gated by
> [@vip/permissions](../../packages/permissions/README.md). MFA / SSO / API keys are later.

## Auth model

- **Login** is tenant-scoped: the `x-tenant-id` header names the tenant (the gateway/subdomain
  supplies it), the user is looked up within that tenant, and a short-lived **access token** +
  rotating **refresh token** are issued.
- **Refresh** rotates within a token _family_ and **detects reuse**: replaying an already-rotated
  token revokes the whole family (compromise response).
- **Authorization** is deny-by-default: protected routes call `auth.authorize('user:read')`.

## Responsibilities (docs/architecture/23 › identity)

Owns users, credentials, sessions, refresh tokens; MFA/SSO/API keys (later). Publishes
`user.created`, `auth.login.succeeded`, `auth.token.refreshed`, `auth.refresh.reused`, `auth.logout`
(via a publisher seam; NATS wiring in P1-5). Consumes `tenant.created`. Internal dep: Tenant.

## Layering (domain never imports transport)

```
src/
├── config/       env.ts — zod-validated, fail-fast configuration
├── domain/       pure entities/invariants (no framework, no I/O)
├── application/  use-cases: get-service-info, readiness registry
├── adapters/     repositories & clients (Mongo/NATS/Redis) — empty in Phase 0
├── transport/    Fastify wiring
│   ├── plugins/  security (helmet), observability (metrics), tenant-context, error-handler
│   ├── routes/   health (/health,/ready), metrics (/metrics), root (/)
│   └── server.ts buildServer() — assembles the app, does not listen
└── index.ts      bootstrap: load config → build → listen → graceful shutdown
```

Call direction: `transport → application → domain`; `adapters` implement ports for the
inner layers. Enforced repo-wide by `pnpm check:imports`.

## Endpoints

| Method | Path                              | Purpose                                       | Auth          |
| ------ | --------------------------------- | --------------------------------------------- | ------------- |
| POST   | `/auth/login`                     | Authenticate within a tenant → access+refresh | `x-tenant-id` |
| POST   | `/auth/refresh`                   | Rotate the token pair (reuse-detection)       | refresh token |
| POST   | `/auth/logout`                    | Revoke the refresh-token family               | refresh token |
| GET    | `/auth/me`                        | Principal resolved from the access token      | Bearer        |
| POST   | `/users`                          | Create a user (tenant-scoped)                 | `user:create` |
| GET    | `/users`                          | List the tenant's users                       | `user:read`   |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / metrics / info         | —             |

Every response carries a correlation id; errors use the `@vip/contracts` `ApiError` envelope
(auth failure → 401, missing permission → 403, both opaque).

## Configuration (env)

| Var               | Default       | Notes                                   |
| ----------------- | ------------- | --------------------------------------- |
| `NODE_ENV`        | `development` | `development` \| `test` \| `production` |
| `SERVICE_NAME`    | `identity`    | logs/metrics label                      |
| `SERVICE_VERSION` | pkg version   | from `npm_package_version` at runtime   |
| `HOST`            | `0.0.0.0`     |                                         |
| `PORT`            | `8080`        |                                         |
| `LOG_LEVEL`       | `info`        | pino level (`silent`…`trace`)           |
| `MONGO_URI`       | —             | **required**; users + refresh tokens    |
| `JWT_SECRET`      | —             | **required** (≥16 chars); signs tokens  |
| `JWT_ACCESS_TTL`  | `15m`         | access-token lifetime                   |
| `JWT_REFRESH_TTL` | `7d`          | refresh-token lifetime                  |

Invalid config aborts startup (no half-configured instance serves traffic).

## Run / test

```bash
pnpm --filter @vip/service-identity dev        # watch mode (tsx)
pnpm --filter @vip/service-identity build       # tsc → dist
pnpm --filter @vip/service-identity start       # node dist/index.js
pnpm --filter @vip/service-identity test        # vitest (unit + inject-based HTTP)
pnpm --filter @vip/service-identity typecheck
pnpm --filter @vip/service-identity lint
```

Tests use Fastify `app.inject()` — no port binding, no Docker required.

## References

Service template: [docs/ai/IMPLEMENTATION_GUIDE.md](../../docs/ai/IMPLEMENTATION_GUIDE.md) ·
ownership: [docs/architecture/23](../../docs/architecture/23-SERVICE-OWNERSHIP.md) ·
framework: [ADR-0017](../../docs/adr/ADR-0017-fastify-control-plane.md) ·
standards: [docs/architecture/03](../../docs/architecture/03-ARCHITECTURE-PRINCIPLES.md).
