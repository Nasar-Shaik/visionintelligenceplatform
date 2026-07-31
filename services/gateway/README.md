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

## Real-time delivery — SSE (P2-2 G-5)

Beyond the proxy, the gateway is the platform's **real-time edge**: it subscribes to the tenant-partitioned
backbone and fans live frames to clients over **Server-Sent Events**. No new service — the gateway is the
single trust boundary, so "gateway event subscriptions" belong here.
Full design: [phase2/REALTIME_DELIVERY](../../docs/architecture/phase2/REALTIME_DELIVERY.md).

| Method + path             | Purpose                                                                  | Auth  |
| ------------------------- | ------------------------------------------------------------------------ | ----- |
| `GET /api/stream`         | open a multiplexed SSE stream (`?topics=incidents,alerts,events,system`) | req'd |
| `GET /stream/diagnostics` | per-connection operational snapshot (tenant-scoped)                      | req'd |

- **StreamHub** ([src/application/stream-hub.ts](src/application/stream-hub.ts)) is transport-agnostic
  (talks to a `ConnectionSink`; the [SSE adapter](src/transport/routes/stream.ts) is the only SSE-aware
  code — WebSocket/gRPC drop in beside it). It owns per-tenant backbone subscriptions, a bounded reconnect
  **ring buffer**, per-connection **priority send-queues** (HIGH>MEDIUM>LOW drop order), the connection
  **lifecycle**, heartbeats, **diagnostics**, and **latency metrics**.
- **Topics → permission:** `incidents`→`incident:read`, `alerts`→`notification:read`, `events`→`event:read`,
  `system`→`camera:read`. Granted = requested ∩ permitted; empty ⇒ **403**. Per-tenant subject filter ⇒
  **cross-tenant isolation** is structural.
- **Envelope is version-safe:** `StreamEnvelope` carries an **opaque payload**, decoupled from
  `EventEnvelope` evolution.
- Enabled by `STREAM_ENABLED` (default on); when off, the gateway is a pure proxy. Metrics on `/metrics`
  (`stream_*`), including `stream_delivery_latency_seconds`.

## Configuration

Via [`@vip/config`](../../packages/config/README.md): `HOST`, `PORT`, `LOG_LEVEL`, `JWT_SECRET`
(edge verification), `IDENTITY_URL`, `TENANT_URL`, and the upstream `*_URL`s. **Real-time (G-5):**
`STREAM_ENABLED`, `CORS_ALLOWED_ORIGINS`, `NATS_URL`, `STREAM_MAX_CONNECTIONS_PER_TENANT`,
`STREAM_MAX_QUEUE_DEPTH`, `STREAM_REPLAY_BUFFER_SIZE`, `STREAM_HEARTBEAT_INTERVAL_MS`,
`STREAM_MAX_CONNECTION_DURATION_MS`, `STREAM_RECONNECT_RETRY_MS`
([limits table](../../docs/architecture/phase2/REALTIME_DELIVERY.md#9-configurable-operational-limits-architect-rec-4)).

## Run & test

```bash
pnpm --filter @vip/service-gateway test        # edge auth + trust-boundary proxy (stub upstream)
pnpm --filter @vip/service-gateway build && node dist/index.js
```

**Future:** RS256/JWKS verification (public key from identity), rate limiting, and full
service routing ([27-CONTROL-DATA-PLANE](../../docs/architecture/27-CONTROL-DATA-PLANE.md)).
