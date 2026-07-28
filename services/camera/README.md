# @vip/service-camera

The **Camera (inventory) context** service (Phase 1, P1-3). Onboards cameras, places each in the
tenant-owned location hierarchy, **vaults their credentials encrypted at rest**, exposes health,
and publishes the `camera.*` lifecycle events that drive media ingestion (P1-4).

> Design: [phase1/CAMERA_ARCHITECTURE](../../docs/architecture/phase1/CAMERA_ARCHITECTURE.md) ·
> ownership: [22-BOUNDED-CONTEXTS §3](../../docs/architecture/22-BOUNDED-CONTEXTS.md),
> [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md).

## Model

- **Cameras belong to the tenant.** Every record carries `tenantId` and flows through the
  [@vip/tenancy](../../packages/tenancy/README.md) fail-closed guard — a camera from another
  tenant is **unaddressable** (a `404`, never an existence leak).
- **The location hierarchy (`org → … → zone`) is owned by the Tenant context** ([P1-1 `OrgNode`](../tenant/README.md)),
  not here. A camera **references** its zone by `zoneId`. Referential integrity against the
  hierarchy is reconciled asynchronously over `tenant.hierarchy.changed` (P1-5) rather than a
  synchronous cross-service call — tracked as [TD-3](../../tracking/TECH-DEBT.md).
- **Credentials are vaulted, never surfaced.** On create/update they are sealed with
  [@vip/crypto](../../packages/crypto/README.md) (AES-256-GCM over an `.env`-derived key) and only
  the cipher is stored. Responses/events/logs expose `hasCredentials: boolean` — never the
  plaintext or cipher. A `streamUrl` may **not** embed `user:pass@` (rejected at the contract).

## Auth

The camera service **verifies the identity-issued Bearer access token itself** (defence-in-depth:
`iss=identity`, `aud=vip`, same expectation as the gateway — it does not blindly trust forwarded
headers). Every route is **permission-gated** (deny-by-default via
[@vip/permissions](../../packages/permissions/README.md)) and scoped to the token's tenant.

## Endpoints

| Method | Path                              | Purpose                                  | Auth            |
| ------ | --------------------------------- | ---------------------------------------- | --------------- |
| POST   | `/cameras`                        | Onboard a camera (vault credentials)     | `camera:create` |
| GET    | `/cameras`                        | List the tenant's cameras                | `camera:read`   |
| GET    | `/cameras/:id`                    | Get one camera                           | `camera:read`   |
| PATCH  | `/cameras/:id`                    | Update / re-vault credentials            | `camera:update` |
| DELETE | `/cameras/:id`                    | Remove from inventory                    | `camera:delete` |
| GET    | `/cameras/:id/health`             | Observed health (`unknown` until P1-4)   | `camera:read`   |
| POST   | `/cameras/discover`               | ONVIF/network discovery — **stub (501)** | `camera:create` |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / metrics / info    | —               |

Publishes `camera.registered`, `camera.updated`, `camera.removed`, `camera.health.changed` via a
publisher seam (NATS wiring in P1-5). Payloads carry ids/metadata only — **never** credentials.

## Configuration (env)

Via [`@vip/config`](../../packages/config/README.md): `HOST`, `PORT`, `LOG_LEVEL`, `MONGO_URI`
(**required**), `JWT_SECRET` (**required**, verifies inbound tokens), `CREDENTIAL_ENCRYPTION_KEY`
(**required**, ≥16 chars — derives the vault key; keep **stable**, rotating it orphans existing
ciphertext). Invalid config aborts startup.

## Layering

`transport → application → domain`; `adapters` implement ports. Credentials are sealed in the
**application** layer (which holds the `SecretBox`), so the **domain stays pure** and never sees
plaintext. Enforced repo-wide by `pnpm check:imports`.

## Run / test

```bash
pnpm --filter @vip/service-camera dev        # watch mode (tsx)
pnpm --filter @vip/service-camera test       # vitest (unit + inject HTTP; real-Mongo when MONGO_URI set)
pnpm --filter @vip/service-camera build && node dist/index.js
```

HTTP/unit tests use Fastify `app.inject()` — no Docker required. The real-driver integration suite
(unique index, ciphertext round-trip, cross-tenant isolation) runs when `MONGO_URI` points at a
reachable Mongo (`pnpm dev:stack`), and skips otherwise.
