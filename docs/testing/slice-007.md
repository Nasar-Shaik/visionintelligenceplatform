# Slice 7 — P1-2 Authentication + authorization

> **Manually executable by the Product Owner.** Proves a user can log in, that tokens rotate with
> **reuse-detection**, that permissions gate protected routes, and that the **gateway** validates
> tokens at the edge and forwards a spoof-proof tenant context. Automated by the `@vip/auth`,
> `@vip/permissions`, identity, and gateway suites; this is the human sign-off.

## Prerequisites

```bash
pnpm dev:stack                       # MongoDB on :47017
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_identity?authSource=admin'
export JWT_SECRET='change_me_dev_only_min_16_chars'
pnpm --filter @vip/service-identity build && node services/identity/dist/index.js   # :8080
```

Seed a first admin (bootstrap; open user-create requires an existing admin) by inserting one user
with a scrypt hash, or reuse the automated integration test which does this. Below assumes an admin
`admin@acme.com` / `supersecret` with role `admin` under tenant `tnt_a`.

## Scenario A — Login & tokens

| Step | Action                                                             | Expected                                                         |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| A1   | `POST /auth/login` (`x-tenant-id: tnt_a`, body `{email,password}`) | `200`, `data.accessToken`, `data.refreshToken`, `expiresIn: 900` |
| A2   | `POST /auth/login` with a wrong password                           | `401` (generic — no user enumeration)                            |
| A3   | `POST /auth/login` without the `x-tenant-id` header                | `400`                                                            |
| A4   | `GET /auth/me` with `Authorization: Bearer <access>`               | `200`, principal `{tenantId, email, roles}`                      |

## Scenario B — Authorization (deny-by-default)

| Step | Action                                  | Expected                      |
| ---- | --------------------------------------- | ----------------------------- |
| B1   | `GET /users` with **no** token          | `401`                         |
| B2   | `GET /users` with the admin token       | `200`, the tenant's users     |
| B3   | `POST /users` with a **viewer**'s token | `403` (missing `user:create`) |
| B4   | `POST /users` with the admin token      | `201`                         |

## Scenario C — Refresh rotation + reuse-detection

| Step | Action                                                       | Expected                                     |
| ---- | ------------------------------------------------------------ | -------------------------------------------- |
| C1   | `POST /auth/refresh` `{refreshToken: R1}`                    | `200`, a **new** pair (R2 ≠ R1)              |
| C2   | `POST /auth/refresh` `{refreshToken: R1}` **again** (replay) | **`401`** — reuse detected, family revoked   |
| C3   | `POST /auth/refresh` `{refreshToken: R2}` (same family)      | **`401`** — family was revoked by the replay |

## Scenario D — Gateway trust boundary

Run the gateway (`IDENTITY_URL=http://localhost:8080 JWT_SECRET=… node services/gateway/dist/index.js`, `:8080`→ pick a free port).

| Step | Action                                                                                          | Expected                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1   | `GET /whoami` with no token                                                                     | `401`                                                                                        |
| D2   | `GET /whoami` with a valid token                                                                | `200`, the resolved context                                                                  |
| D3   | `GET /api/identity/auth/me` through the gateway, **also sending a spoofed `x-tenant-id: evil`** | `200`; the upstream sees the **token's** tenant, not `evil` (gateway stripped + re-injected) |

## Pass criteria

- **C2 and C3 both `401`** — a replayed refresh token is detected and revokes the whole family.
- **B1/B3 both denied**, B2/B4 allowed — deny-by-default authorization works.
- **D3** — a client cannot spoof its tenant/principal through the gateway.

> Automated equivalents: `pnpm --filter @vip/auth test`, `… @vip/permissions test`,
> `… @vip/service-identity test` (+ real-Mongo integration with `MONGO_URI`), `… @vip/service-gateway test`.
