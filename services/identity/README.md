# @vip/service-identity

The **Identity context** service and the repository's **reference Fastify service
template**. New TS services are scaffolded by copying this shape.

> **Phase 0 status:** infrastructure skeleton only — **no authentication, users, or
> business logic yet**. It proves the template (layering, health/ready/metrics,
> tenant-context seam, error envelope, graceful shutdown). The real Identity
> responsibilities land in Phase 1.

## Responsibilities (target — docs/architecture/23 › identity)

Authenticate principals; sessions / MFA / SSO / API keys. Owns users, credentials,
sessions, refresh tokens, MFA, API keys. Publishes `identity.user.*`,
`identity.session.*`; consumes `tenant.created`. Internal dep: Tenant.

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

| Method | Path       | Purpose                                                       |
| ------ | ---------- | ------------------------------------------------------------- |
| GET    | `/health`  | Liveness — always `200 {"status":"ok"}`                       |
| GET    | `/ready`   | Readiness — `200` when all dependency checks pass, else `503` |
| GET    | `/metrics` | Prometheus exposition (per-instance registry)                 |
| GET    | `/`        | Service-info snapshot in the `{success,data}` envelope        |

Every response carries a correlation id (`x-request-id` if supplied, else generated);
errors use the `@vip/contracts` `ApiError` envelope.

## Configuration (env)

| Var               | Default       | Notes                                   |
| ----------------- | ------------- | --------------------------------------- |
| `NODE_ENV`        | `development` | `development` \| `test` \| `production` |
| `SERVICE_NAME`    | `identity`    | logs/metrics label                      |
| `SERVICE_VERSION` | pkg version   | from `npm_package_version` at runtime   |
| `HOST`            | `0.0.0.0`     |                                         |
| `PORT`            | `8080`        |                                         |
| `LOG_LEVEL`       | `info`        | pino level (`silent`…`trace`)           |

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
