# @vip/service-tenant

The **tenant service** (Phase 1, P1-1). Provisions tenants and their organizational-hierarchy
root — the tenant is the root of all data (Law 5) — and enforces **fail-closed multi-tenant
isolation** on everything a tenant owns, via [`@vip/tenancy`](../../packages/tenancy/README.md).

Design: [phase1/TENANT_ARCHITECTURE](../../docs/architecture/phase1/TENANT_ARCHITECTURE.md)
· [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md)
· [ADR-0003](../../docs/adr/ADR-0003-tenant-isolation-strategy.md).

## What it does

- **Provisions** a tenant: creates the tenant record, seeds its `org` hierarchy root, and
  activates it (`provisioning → active`). Announces `tenant.created` / `org.node.created` /
  `tenant.activated` via a publisher seam (NATS wiring arrives in P1-5).
- **Manages** a tenant (name + lifecycle) and its **org hierarchy** (`org → region → … → zone`).
- Isolation is **structural**: every tenant-owned record flows through `@vip/tenancy`, so a
  cross-tenant read/write is impossible, not merely discouraged.

## Data model

| Collection  | Scope         | Notes                                                                                  |
| ----------- | ------------- | -------------------------------------------------------------------------------------- |
| `tenants`   | control-plane | the registry; each doc keyed by its own id (`tenantId == _id`); `slug` globally unique |
| `org_nodes` | tenant-scoped | `@vip/tenancy` guard injects/enforces `tenantId`; tenant-leading indexes               |

## API (P1-1)

Authentication/authorization arrive in **P1-2**; until then provisioning is open and tenant
context is taken from `x-tenant-id` + `x-principal-id` headers (the seam the gateway will fill).
Every tenant-addressed route refuses a path that names a different tenant than the caller's
context — **cross-tenant → 403, fail-closed**.

| Method + path                     | Purpose                        | Context | Cross-tenant |
| --------------------------------- | ------------------------------ | ------- | ------------ |
| `POST /tenants`                   | provision a tenant + org root  | —       | —            |
| `GET /tenants/:id`                | get the caller's tenant        | req'd   | 403          |
| `PATCH /tenants/:id`              | update name / lifecycle        | req'd   | 403          |
| `GET /tenants/:id/org-nodes`      | list the tenant's org nodes    | req'd   | 403          |
| `POST /tenants/:id/org-nodes`     | create an org node             | req'd   | 403          |
| `GET /health` `/ready` `/metrics` | liveness / readiness / metrics | —       | —            |

Responses use the `@vip/contracts` envelope: `{ success, data }` or `{ success:false, error }`.

## Configuration

Via [`@vip/config`](../../packages/config/README.md) (no `process.env` reads; ADR-0018):
`NODE_ENV`, `SERVICE_NAME`, `HOST`, `PORT`, `LOG_LEVEL`, and **`MONGO_URI`** (fail-fast if absent).

## Run & test

```bash
pnpm --filter @vip/service-tenant test        # units + HTTP (in-memory); integration SKIPS w/o Mongo
pnpm dev:stack                                 # start Mongo (+ stack) on :47017
MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_tenant?authSource=admin' \
  pnpm --filter @vip/service-tenant test       # runs the real-Mongo isolation suite too
pnpm --filter @vip/service-tenant build && node dist/index.js
```

## Layout

`transport/` (routes + plugins) → `application/` (use-cases, errors, event seam) →
`domain/` (pure records/transitions); `adapters/mongo.ts` owns the driver. The domain is
framework-free; only adapters do I/O.
