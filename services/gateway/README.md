# @vip/service-gateway

The **API gateway** (Phase 1, P1-2) — the platform's single trust boundary. It validates the
access token at the edge, resolves the `TenantContext`, and forwards it to upstream services as
**trusted internal headers**, stripping any client-supplied ones so a downstream service can trust
`x-tenant-id`/`x-principal-id` iff it came from the gateway.

Design: [phase1/AUTHENTICATION](../../docs/architecture/phase1/AUTHENTICATION.md)
· [phase1/TENANT_ARCHITECTURE §2](../../docs/architecture/phase1/TENANT_ARCHITECTURE.md)
· [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md).

## Routes (P1-2)

| Method + path                         | Purpose                                                                 | Auth  |
| ------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `GET /whoami`                         | resolve + return the caller's context (proves edge validation)          | req'd |
| `ALL /api/:svc/*`                     | reverse-proxy to the `:svc` upstream, injecting trusted context headers | req'd |
| `GET /health` `/ready` `/metrics` `/` | liveness / readiness / metrics / info                                   | —     |

- **Trust boundary:** on every proxied request the gateway drops client `x-tenant-id` / `x-principal-id`
  / `x-roles` and re-sets them from the validated token (spoofing prevention — see `src/transport/context.ts`).
- **Upstreams** are configured by prefix: `identity` → `IDENTITY_URL`, `tenant` → `TENANT_URL`,
  `camera` → `CAMERA_URL`, `media` → `MEDIA_URL`.
- P1-2 proxies JSON bodies; streaming/multipart and richer routing are later extensions.

## Configuration

Via [`@vip/config`](../../packages/config/README.md): `HOST`, `PORT`, `LOG_LEVEL`, `JWT_SECRET`
(edge verification), `IDENTITY_URL`, `TENANT_URL`.

## Run & test

```bash
pnpm --filter @vip/service-gateway test        # edge auth + trust-boundary proxy (stub upstream)
pnpm --filter @vip/service-gateway build && node dist/index.js
```

**Future:** RS256/JWKS verification (public key from identity), rate limiting, and full
service routing ([27-CONTROL-DATA-PLANE](../../docs/architecture/27-CONTROL-DATA-PLANE.md)).
