# Slice 8 — P1-3 Camera registry + org hierarchy

> **Manually executable by the Product Owner.** Proves a tenant onboards a camera into its location
> hierarchy, that **credentials are vaulted and never returned**, that authorization gates every
> route, and that **cameras never cross tenants**. Automated by the `@vip/crypto`, `@vip/contracts`,
> and `@vip/service-camera` suites; this is the human sign-off.

## Prerequisites

```bash
pnpm dev:stack                       # MongoDB on :47017
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_camera?authSource=admin'
export JWT_SECRET='change_me_dev_only_min_16_chars'
export CREDENTIAL_ENCRYPTION_KEY='change_me_dev_only_min_16_chars'
pnpm --filter @vip/service-camera build && node services/camera/dist/index.js   # :8080
```

Obtain an access token from identity (slice-007) for an `admin` under some tenant `tnt_a`, and a
`viewer` token for the same tenant. The camera service **verifies** these tokens (`iss=identity`);
it does not issue them. Assume an `OrgNode` zone id `on_zone1` exists in `tnt_a` (from slice-006).

## Scenario A — Onboard & credential safety

| Step | Action                                                                                                    | Expected                                                             |
| ---- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A1   | `POST /cameras` (admin) `{zoneId:on_zone1, name, protocol:rtsp, streamUrl:rtsp://cam/1, credentials:{…}}` | `201`; `data.hasCredentials:true`; response contains **no** password |
| A2   | `POST /cameras` with `streamUrl: rtsp://user:pw@cam/1`                                                    | `400` — credentials must not be embedded in the URL                  |
| A3   | `POST /cameras` with `protocol:rtmp` but an `rtsp://` URL                                                 | `400` — scheme/protocol mismatch                                     |
| A4   | Inspect the stored doc in Mongo (`db.cameras.findOne()`)                                                  | `credentialCipher` is `v1.gcm.…` ciphertext; **no plaintext**        |

## Scenario B — Authorization (deny-by-default)

| Step | Action                                | Expected                        |
| ---- | ------------------------------------- | ------------------------------- |
| B1   | `GET /cameras` with **no** token      | `401`                           |
| B2   | `GET /cameras` with the viewer token  | `200` (viewer has `*:read`)     |
| B3   | `POST /cameras` with the viewer token | `403` (missing `camera:create`) |
| B4   | `POST /cameras` with the admin token  | `201`                           |

## Scenario C — Lifecycle

| Step | Action                                          | Expected                                    |
| ---- | ----------------------------------------------- | ------------------------------------------- |
| C1   | `GET /cameras/:id` (admin)                      | `200`, the camera (no credentials)          |
| C2   | `PATCH /cameras/:id` `{name, status:disabled}`  | `200`, updated fields                       |
| C3   | `GET /cameras/:id/health`                       | `200`, `{cameraId, status:"unknown"}`       |
| C4   | `DELETE /cameras/:id` → then `GET /cameras/:id` | `204`, then `404`                           |
| C5   | `POST /cameras/discover`                        | `501` — ONVIF discovery not yet implemented |

## Scenario D — Cross-tenant isolation (fail-closed)

Obtain an `admin` token for a **different** tenant `tnt_b`.

| Step | Action                                                       | Expected                                      |
| ---- | ------------------------------------------------------------ | --------------------------------------------- |
| D1   | With `tnt_a` admin, create a camera; note its `:id`          | `201`                                         |
| D2   | With `tnt_b` admin, `GET /cameras`                           | `200`, list does **not** contain A's camera   |
| D3   | With `tnt_b` admin, `GET/PATCH/DELETE /cameras/:id` (A's id) | `404` (no existence leak — never `403`/`200`) |

## Pass criteria

- **A1 + A4** — credentials are stored only as ciphertext and never appear in any response.
- **B1/B3 denied**, B2/B4 allowed — deny-by-default authorization works.
- **D2/D3** — a principal of tenant B can neither see nor mutate tenant A's cameras.

> Automated equivalents: `pnpm --filter @vip/crypto test`, `… @vip/contracts test`,
> `… @vip/service-camera test` (+ real-Mongo integration with `MONGO_URI`).
