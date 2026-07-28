# Slice 6 — P1-1 Tenant foundation + fail-closed isolation

> **Manually executable by the Product Owner.** Proves a tenant can be provisioned and that
> **one tenant can never see or touch another tenant's data** (the security spine of the platform).
> Automated by `@vip/tenancy` + `@vip/service-tenant` test suites; this is the human sign-off.

## Prerequisites

```bash
pnpm install && pnpm --filter @vip/contracts build && pnpm --filter @vip/tenancy build
pnpm dev:stack                       # starts MongoDB on :47017 (+ the rest of the dev stack)
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_tenant?authSource=admin'
pnpm --filter @vip/service-tenant build && node services/tenant/dist/index.js   # listens on :8080 (or $PORT)
```

Use `PORT=48090` if 8080 is taken. Below assumes `http://localhost:48090`.

## Scenario A — Provision a tenant

| Step | Action                                                     | Expected                                                                                  |
| ---- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1   | `POST /tenants` with `{"slug":"acme","name":"Acme"}`       | `201`, `data.tenant.status = "active"`, a `data.orgRoot` of `type:"org"`, `parentId:null` |
| A2   | `POST /tenants` again with the **same** slug               | `409` conflict                                                                            |
| A3   | `POST /tenants` with `{"slug":"A","name":"x"}` (too short) | `400` bad_request                                                                         |

Note the returned `tenant.id` (call it **A**). Provision a second tenant `{"slug":"beta"}` → **B**.

## Scenario B — A tenant sees only itself (isolation)

| Step | Action                                                                                         | Expected                                                 |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| B1   | `GET /tenants/A` with headers `x-tenant-id: A`, `x-principal-id: u1`                           | `200`, `data.id = A`                                     |
| B2   | `GET /tenants/A` with **no** headers                                                           | `401` (context required)                                 |
| B3   | `GET /tenants/A` with headers `x-tenant-id: B` (wrong tenant)                                  | **`403` forbidden** (fail-closed)                        |
| B4   | `GET /tenants/A/org-nodes` with `x-tenant-id: A`                                               | `200`, exactly the org root (1 node)                     |
| B5   | `POST /tenants/A/org-nodes` `{"type":"site","name":"HQ","parentId":"<A org root id>"}` (ctx A) | `201`                                                    |
| B6   | `GET /tenants/A/org-nodes` (ctx A)                                                             | `200`, **2** nodes (root + site)                         |
| B7   | `GET /tenants/B/org-nodes` (ctx B)                                                             | `200`, **1** node (B's own root) — A's site is invisible |
| B8   | `GET /tenants/A/org-nodes` with `x-tenant-id: B`                                               | **`403` forbidden**                                      |

## Scenario C — Health & shutdown

| Step | Action                        | Expected                                                   |
| ---- | ----------------------------- | ---------------------------------------------------------- |
| C1   | `GET /health`                 | `200 {"status":"ok"}`                                      |
| C2   | `GET /ready`                  | `200`, `checks` includes `{ name:"mongo", status:"pass" }` |
| C3   | `GET /metrics`                | `200`, Prometheus text with `service="tenant"`             |
| C4   | Send `SIGTERM` to the process | drains, closes Mongo, exits `0`                            |

## Pass criteria

- **All of B3, B7, B8 hold** — cross-tenant access is impossible and a foreign context is refused
  with `403` (never a `200` with someone else's data, never a `500`).
- A tenant provisions with an active org root; duplicate slug and bad input are rejected cleanly.
- `/ready` reflects real MongoDB health; shutdown is graceful.

> The automated equivalent: `pnpm --filter @vip/tenancy test` (guard) and, with `MONGO_URI` set,
> the `@vip/service-tenant` integration suite (real-driver isolation). This is the **baseline of
> the standing cross-tenant isolation gate** that every later P1 slice extends.
