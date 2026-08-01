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

| Method | Path                              | Purpose                                              | Auth            |
| ------ | --------------------------------- | ---------------------------------------------------- | --------------- |
| POST   | `/cameras`                        | Onboard a camera (vault credentials)                 | `camera:create` |
| GET    | `/cameras`                        | List the tenant's cameras                            | `camera:read`   |
| GET    | `/cameras/:id`                    | Get one camera                                       | `camera:read`   |
| PATCH  | `/cameras/:id`                    | Update / re-vault credentials / metadata / caps      | `camera:update` |
| DELETE | `/cameras/:id`                    | Remove from inventory                                | `camera:delete` |
| GET    | `/cameras/:id/health`             | Observed health (`unknown` until probed)             | `camera:read`   |
| POST   | `/cameras/discover`               | **P-1** ONVIF discovery + tenant reconciliation      | `camera:create` |
| POST   | `/cameras/bulk`                   | **P-1** Bulk onboard (DVR/NVR channels)              | `camera:create` |
| POST   | `/cameras/validate`               | **G-1** Test-connection: validate a candidate config | `camera:read`   |
| POST   | `/cameras/:id/validate`           | **G-1** Validate an existing camera's config         | `camera:read`   |
| GET    | `/cameras/:id/capabilities`       | **G-1** Declared capabilities (ptz/audio/codecs/…)   | `camera:read`   |
| POST   | `/cameras/:id/health/check`       | **G-1** Active re-check → records a health snapshot  | `camera:update` |
| POST   | `/cameras/:id/enable`             | **G-1** Set status `enabled`                         | `camera:update` |
| POST   | `/cameras/:id/disable`            | **G-1** Set status `disabled`                        | `camera:update` |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / metrics / info                | —               |

Publishes `camera.registered`, `camera.updated`, `camera.removed`, `camera.health.checked` via a
publisher seam (NATS wiring in P1-5). Payloads carry ids/metadata only — **never** credentials.

**P2-2 G-1 (enhancements).** A camera now carries **`capabilities`** (what it supports — ptz, audio,
snapshot, codecs, resolutions, protocols; derived from protocol + capture at onboarding, or declared)
and **`metadata`** (operator/device fields — manufacturer, model, firmware, serial, location, tags,
notes). **Validation** (`/cameras/validate`) is a deterministic, no-persistence "test connection"
that reports structured checks (scheme, no-embedded-credentials, protocol match, resolution format);
active network reachability is intentionally _not_ proven here — that is the ingestion path's job
(Media enabler **G-2**), reported as an informational check only.

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

## Network discovery (P-1)

`POST /cameras/discover` probes the local segment for ONVIF devices and reconciles the answers against
this tenant's inventory. It **persists nothing** — it returns candidates, and onboarding stays a
separate, deliberate act.

**The ONVIF implementation is not here.** The platform's only tested ONVIF stack lives in the AI
runtime (`ai/inference/onvif.py`, built for the AI-5e certification harness), and this service calls it
through a `DiscoveryProvider` port rather than growing a second one that would drift — see
[ADR-0023](../../docs/adr/ADR-0023-onvif-discovery-placement.md). Set `CAMERA_DISCOVERY_URL` to the
runtime's base URL to enable it.

**Leaving it unset is a supported deployment**, not a broken one: plenty of estates are onboarded from
a list of RTSP URLs. The service then reports discovery as _unavailable_ — which is deliberately
distinct from _found nothing_, because the first sends an installer to their settings and the second
sends them to their switch.

Three behaviours worth knowing before changing this code:

- **Already-onboarded devices are returned, marked** (`alreadyOnboarded` + `cameraId`), never filtered
  out. Someone re-scanning a half-configured site has to be able to tell "already added" from "did not
  answer". Matching is on a normalized stream URL: scheme and host case-insensitive per RFC 3986, path
  preserved (DVR channel paths are case-sensitive), trailing slash dropped.
- **Discovery never changes a certification status.** A successful `GetDeviceInformation` is not a
  passing certification run; the compatibility registry keeps every device at `pending-validation`
  ([CONSTRAINTS §18](../../docs/project/CONSTRAINTS.md)).
- **`POST /cameras/bulk` is deliberately not transactional.** One bad channel in a 16-channel DVR must
  not discard the other fifteen, so each camera is created independently and each row carries its own
  outcome. Items are validated **per item** against `CreateCameraInput`, not at the envelope.
