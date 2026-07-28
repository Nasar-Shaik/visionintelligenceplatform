# Slice 9 — P1-4 RTSP ingestion + recording

> **Manually executable by the Product Owner.** Proves a tenant's camera stream connects, frames are
> produced, a recording lands in MinIO under `{tenantId}/{cameraId}/…`, connection loss reconnects,
> and streams/recordings are tenant-isolated. Automated by the `@vip/storage` and
> `@vip/service-media` suites (incl. real-MinIO); the ffmpeg/RTSP live path uses the `media` profile.

## Prerequisites

```bash
pnpm dev:stack                                   # Mongo + MinIO (+ vip-recordings bucket)
docker compose -f infra/docker/docker-compose.dev.yml --profile media up -d   # rtsp://localhost:8554/test
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_camera?authSource=admin'
export JWT_SECRET='change_me_dev_only_min_16_chars'
export CREDENTIAL_ENCRYPTION_KEY='change_me_dev_only_min_16_chars'
export INTERNAL_API_KEY='internal-key-at-least-16-chars'
export S3_ENDPOINT='http://localhost:49000' AWS_ACCESS_KEY_ID='vip_dev' AWS_SECRET_ACCESS_KEY='change_me_dev_only'
# camera on :8082, media on :8083 (PORT per service); requires the ffmpeg binary on PATH
node services/camera/dist/index.js &   # :8082
PORT=8083 CAMERA_URL=http://localhost:8082 node services/media/dist/index.js &   # :8083
```

Onboard a camera (slice-008) whose `streamUrl` is `rtsp://localhost:8554/test` under tenant `tnt_a`,
note its `:cameraId`, and get an `admin` token from identity (slice-007).

## Scenario A — Connect & record

| Step | Action                                                           | Expected                                                     |
| ---- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| A1   | `POST /streams/:cameraId/start` (admin)                          | `202`, `data.state` `connecting`                             |
| A2   | `GET /streams/:cameraId/status` after a few seconds              | `state` `connected`, `recording: true`, `framesReceived` > 0 |
| A3   | List MinIO `vip-recordings` under `tnt_a/<cameraId>/recordings/` | one or more `seg-….mp4` objects appear as segments finalize  |
| A4   | `GET /streams` (admin)                                           | the worker is listed                                         |

## Scenario B — Authorization

| Step | Action                                            | Expected                         |
| ---- | ------------------------------------------------- | -------------------------------- |
| B1   | `POST /streams/:cameraId/start` with **no** token | `401`                            |
| B2   | `POST /streams/:cameraId/start` with a **viewer** | `403` (missing `stream:control`) |
| B3   | `GET /streams` with a **viewer**                  | `200` (viewer has `*:read`)      |

## Scenario C — Loss & reconnect

| Step | Action                                                    | Expected                                                    |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------- |
| C1   | Stop the RTSP source (`docker stop …-rtsp-test-source-1`) | status → `lost`; `media.stream.lost` in the media log       |
| C2   | Wait (backoff) / restart the source                       | worker reconnects → `connected`; `reconnectAttempts` resets |

## Scenario D — Tenant isolation

| Step | Action                                                            | Expected                            |
| ---- | ----------------------------------------------------------------- | ----------------------------------- |
| D1   | With a `tnt_b` admin token, `GET /streams`                        | does **not** list tenant A's stream |
| D2   | With `tnt_b`, `GET/POST /streams/:cameraId/status\|stop` (A's id) | `404` (no existence leak)           |
| D3   | Inspect MinIO — A's segments are only under `tnt_a/…`             | no object crosses the tenant prefix |

## Scenario E — Internal credential resolve (service-to-service)

| Step | Action                                                                        | Expected                                               |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| E1   | `GET :8082/internal/cameras/:id/stream` with `x-internal-key` + `x-tenant-id` | `200` with `streamUrl` + decrypted `username/password` |
| E2   | Same without the key, or **through the gateway** `/api/camera/internal/...`   | `401` (gateway strips `x-internal-key`)                |

## Pass criteria

- **A2 + A3** — the stream connects, frames are produced, and a recording lands under
  `{tenantId}/{cameraId}/recordings/`.
- **C1/C2** — loss emits `media.stream.lost` and the worker reconnects with backoff.
- **D1–D3** — a principal of tenant B can neither see, control, nor read tenant A's streams/recordings.

> Automated equivalents: `pnpm --filter @vip/storage test`, `pnpm --filter @vip/service-media test`
> (both with `S3_ENDPOINT` set for the real-MinIO suites), `pnpm --filter @vip/service-camera test`.
