# @vip/service-media

The **Media / Ingestion context** service (Phase 1, P1-4) — the first data-plane service. It runs a
per-camera worker that connects the camera's RTSP/RTMP stream, decodes it (ffmpeg, H.264), extracts
frames for perception, and **records segments to tenant-scoped object storage**, auto-reconnecting
with backoff on loss.

> Design: [phase1/INGESTION_PIPELINE](../../docs/architecture/phase1/INGESTION_PIPELINE.md) ·
> [phase1/STORAGE_ARCHITECTURE](../../docs/architecture/phase1/STORAGE_ARCHITECTURE.md) ·
> ownership: [22-BOUNDED-CONTEXTS §4](../../docs/architecture/22-BOUNDED-CONTEXTS.md).

## Pipeline

```
camera creds ──▶ [resolve]──▶ [ffmpeg decode] ──┬─▶ frames  ──▶ perception (P1-6, null sink today)
(internal API)                                   └─▶ segments ──▶ MinIO  {tenantId}/{cameraId}/recordings/…
                                                        └────────▶ media.stream.* / media.recording.segment
```

- **Per-camera worker** (`StreamSupervisor`): `idle → connecting → connected → (lost → connecting…) → stopped`.
- **Credentials** are resolved from the Camera context's internal endpoint (`x-internal-key`) — the
  one place they're decrypted — used transiently and **never stored or logged**.
- **Recording** goes through [@vip/storage](../../packages/storage/README.md)'s fail-closed
  `TenantObjectStore`, so segments can only land under the tenant's own prefix.
- **Loss** (drop, decode error, resolve failure) → `media.stream.lost` + **exponential-backoff**
  reconnect. **Storage write failure degrades** (logged) and never blocks the live path.
- All I/O is behind ports (`CameraSource`, `Decoder`, `FrameSink`, object store), so the whole
  lifecycle is unit-tested with fakes; the ffmpeg/HTTP/S3 adapters are wired at the composition root.

## Endpoints (behind the gateway)

| Method | Path                              | Purpose                               | Auth             |
| ------ | --------------------------------- | ------------------------------------- | ---------------- |
| POST   | `/streams/:cameraId/start`        | Start a camera's ingestion worker     | `stream:control` |
| POST   | `/streams/:cameraId/stop`         | Stop the worker (no reconnect)        | `stream:control` |
| GET    | `/streams/:cameraId/status`       | Worker status (`StreamStatus`)        | `stream:read`    |
| GET    | `/streams`                        | List the tenant's workers             | `stream:read`    |
| GET    | `/health` `/ready` `/metrics` `/` | liveness / readiness / metrics / info | —                |

Tenant comes from the validated access token (`iss=identity`), so a principal only controls/sees its
own tenant's streams — another tenant's camera is a `404`. Publishes `media.stream.connected|lost`,
`media.recording.segment` via a publisher seam (NATS in P1-5).

## Configuration (env)

Via [`@vip/config`](../../packages/config/README.md): `HOST`, `PORT`, `LOG_LEVEL`, `JWT_SECRET`
(verify tokens), the `storage` group (`S3_ENDPOINT`, `AWS_*`, `S3_RECORDINGS_BUCKET`),
`INTERNAL_API_KEY` (calls camera's resolve endpoint), `CAMERA_URL`, and ingestion tunables
`MEDIA_FRAME_RATE` (fps, default 2), `MEDIA_SEGMENT_SECONDS` (default 6), `FFMPEG_BINARY`.

## The decoder & the RTSP test source

The decoder shells out to the **ffmpeg binary** (a system dependency, not a native npm addon). The
supervisor logic is fully unit-tested with a fake decoder; the real `FfmpegDecoder` is validated
against a synthetic RTSP source in the dev stack's opt-in `media` profile:

```bash
docker compose -f infra/docker/docker-compose.dev.yml --profile media up -d   # rtsp://localhost:8554/test
```

## Run / test

```bash
pnpm --filter @vip/service-media test    # supervisor lifecycle + HTTP (fakes); real-MinIO recording when reachable
pnpm --filter @vip/service-media build && node dist/index.js
```

HTTP/unit tests use `app.inject()` + fakes — no ffmpeg/Docker required. The recording integration
suite runs against dev-stack MinIO (`pnpm dev:stack`) and skips otherwise.
