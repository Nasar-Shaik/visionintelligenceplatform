# Real-Time Event Delivery Layer (P2-2 G-5)

> **Status:** ✅ code + tests complete · ⏳ **Architect review pending** · Author: Claude · _2026-07-31_
> **Scope:** the platform's production-grade real-time communication layer — Server-Sent Events at the
> gateway edge, streaming live incidents/alerts/events/system status to the console and future
> clients, over the tenant-partitioned event backbone.

This is the **stable foundation** on which all future AI event streaming (RTSP → inference → tracking →
behaviour → events → dashboard) will run. It introduces **no new service** — the API gateway (the frozen
single trust boundary) gains an event-fan-out edge beside its reverse proxy.

---

## 1. Architecture

```
 backbone (NATS JetStream, tenant-partitioned)          Gateway (edge)                 Clients
 t.{tenant}.incident.>    ─┐                     ┌──────────────────────────┐
 t.{tenant}.notification.>─┼── deliverNew ─────► │  StreamHub               │
 t.{tenant}.event.>       ─┘   (per tenant×src)  │   • cursor + ring buffer │──ConnectionSink──► SSE ─► console
                                                 │   • per-conn priority Q  │      (adapter)     (EventSource-
                                                 │   • lifecycle + timers   │                     over-fetch)
                                                 │   • diagnostics + metrics│
                                                 └──────────────────────────┘
                                                    ▲ transport-agnostic       ▲ future: WS / gRPC adapters
```

- **StreamHub** ([services/gateway/src/application/stream-hub.ts](../../../services/gateway/src/application/stream-hub.ts))
  owns everything transport-independent: per-tenant backbone subscriptions, cursor assignment, the
  bounded reconnect **ring buffer**, per-connection **priority send-queues**, connection **lifecycle**,
  heartbeat/duration timers, **diagnostics**, and **metrics**. It depends only on the `EventBus` port
  (`InMemoryEventBus` in tests, `NatsEventBus` in prod — injected) and a `ConnectionSink`.
- **ConnectionSink** is the one-way transport port (Architect rec 5). The **SSE adapter**
  ([routes/stream.ts](../../../services/gateway/src/transport/routes/stream.ts)) is the only G-5 code
  that knows about `text/event-stream`; a WebSocket or gRPC adapter drops in beside it **without
  touching StreamHub**.
- **Stream domain** ([domain/stream.ts](../../../services/gateway/src/domain/stream.ts)) is pure: the
  subject↔topic map, priority classification, permission map, and the lifecycle state model.

**Boundaries.** Gateway → `@vip/messaging` + `@vip/permissions` + `@vip/contracts` only (import-graph
legal). No business logic in the gateway: it does authentication, authorization, routing, **buffering,
replay, and transport** — nothing domain-specific. Frames carry an **opaque payload**.

## 2. Topics, subjects, permissions

One multiplexed SSE connection carries any subset of four topics. Each maps to a tenant-scoped subject
family and a distinct read permission (deny-by-default via `@vip/permissions`):

| Topic       | Subject family (per tenant)       | Stream        | Permission          | Notes                                                   |
| ----------- | --------------------------------- | ------------- | ------------------- | ------------------------------------------------------- |
| `incidents` | `t.{tenant}.incident.>`           | AUTOMATION    | `incident:read`     | lifecycle only; `candidate` is internal, never streamed |
| `alerts`    | `t.{tenant}.notification.>`       | NOTIFICATIONS | `notification:read` | delivery signals                                        |
| `events`    | `t.{tenant}.event.>` (non-system) | EVENTS        | `event:read`        | perception/domain events                                |
| `system`    | `t.{tenant}.event.system.>`       | EVENTS        | `camera:read`       | operational status                                      |

The granted set is **requested ∩ permitted**; an empty result is **403**. `events` and `system` share the
EVENTS consumer (classified per message) — never two overlapping subscriptions.

## 3. Multi-tenant isolation

Structural, not incidental: a connection's upstream consumers are filtered to `t.{itsTenant}.…`, and the
hub fans a frame only to connections on the **same tenant channel**. A per-message defence-in-depth check
(`tenantIdFromSubject`) re-verifies. Diagnostics are tenant-scoped. **A client can never receive another
tenant's frames** — proven over the wire (`stream-http.test.ts`) and in the hub (`stream-hub.test.ts`).

## 4. Connection lifecycle (Architect rec 1)

```
Connecting → Authenticating → Authorized → Subscribed → Streaming ⇄ Heartbeat → (Reconnecting) → Closed
```

| Transition                  | Trigger                                                                           | Behaviour                                                                 |
| --------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Connecting → Authenticating | request received                                                                  | route validates the Bearer access token (edge-auth)                       |
| Authenticating → **401**    | missing/invalid token                                                             | JSON 401, no stream opened                                                |
| Authenticating → Authorized | token valid                                                                       | resolve requested ∩ permitted topics                                      |
| Authorized → **403**        | no permitted topics                                                               | JSON 403                                                                  |
| Authorized → **429**        | tenant at connection ceiling                                                      | JSON 429 (pre-hijack)                                                     |
| Authorized → Subscribed     | capacity OK                                                                       | SSE headers written, `reply.hijack()`, hub `open()` ensures upstream subs |
| Subscribed → Streaming      | `ready` control sent (+ ring-buffer replay if `Last-Event-ID`)                    | live frames flow                                                          |
| Streaming ⇄ Heartbeat       | every `heartbeatIntervalMs`                                                       | `event: heartbeat` keepalive; a write throw ⇒ failed heartbeat ⇒ Closed   |
| Streaming → Reconnecting    | network interruption / server `error` control                                     | client auto-reconnects with `Last-Event-ID` (SSE `retry:`)                |
| Streaming → Closed          | client disconnect, **token expiration** (max-duration reached), graceful shutdown | timers cleared, connection removed, unused upstream subs stopped          |

**Token expiration** is handled by bounding a connection's max-duration ≤ the access-token TTL (config):
a stream never outlives its token; the client reconnects with a refreshed token (→ Reconnecting → replay).
**Graceful shutdown** closes all connections (`error` control) and drains the backbone subscriptions.

## 5. Retry, reconnect & replay strategy (Architect rec 4)

- **Reconnect:** SSE-native. The gateway emits `retry: {reconnectRetryMs}`; the client resumes with the
  `Last-Event-ID` header (the browser sends it automatically; the fetch-based console client sets it).
- **Replay — current strategy (G-5):** a **bounded in-memory ring buffer per tenant** (`replayBufferSize`,
  default 200). On reconnect the hub re-delivers buffered frames with `id > Last-Event-ID` for the
  connection's topics. Cheap, deterministic, and matched to the at-least-once + idempotent-consumer model
  ([EVENT_SPINE_SEMANTICS](../future/EVENT_SPINE_SEMANTICS.md)).
- **Future — durable replay (deferred, [TD-19](../../../tracking/TECH-DEBT.md)):** deeper catch-up from
  JetStream itself is an **additive enhancement**, not a replacement. The `deliverNew` consumer option
  already keeps live fan-out from replaying whole streams; a durable per-tenant replay consumer would
  slot behind the same ring-buffer API.

## 6. Ordering guarantees per topic (Architect rec 3, first addendum)

- **Per subject family, per tenant: FIFO.** The gateway assigns a strictly increasing cursor `id` as it
  receives each frame; delivery to a connection preserves that order. Replay re-delivers in cursor order.
- **Across topics on one connection:** interleaved by arrival; no cross-topic total order is promised (nor
  needed — each surface consumes its own topic).
- **At-least-once, idempotent:** consistent with the backbone. Under backpressure a **low-priority** frame
  may be **dropped** (never reordered) — see §7.
- **No global order across tenants or gateway instances.** Multi-instance fan-out ordering is out of scope
  (single-instance for G-5; [TD-19](../../../tracking/TECH-DEBT.md)).

## 7. Backpressure & priority (Architect rec 1)

Each connection has a bounded send-queue (`maxQueueDepth`). When the transport saturates (a socket write
returns `false`), the hub pauses and resumes on `drain`. If the queue is **full** on enqueue, it **evicts
the least-urgent queued frame**, always sparing more-urgent ones:

| Priority   | Examples                                                                        | Under saturation                    |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| **HIGH**   | critical/high alerts, camera-offline, fire/smoke/weapon, security/safety events | never dropped for a lower one       |
| **MEDIUM** | incident lifecycle, ordinary perception events                                  | dropped only after LOW is exhausted |
| **LOW**    | analytics, people-counts, statistics, routine system status                     | shed first                          |

Priority is **edge-derived** ([`classifyPriority`](../../../services/gateway/src/domain/stream.ts)), never
authored by producers. **Future event coalescing** (Architect rec 6, first addendum) hooks exactly here:
instead of dropping a LOW analytics frame, a future policy may merge/throttle it into a summary — without
touching transport or critical paths. Deferred ([TD-19](../../../tracking/TECH-DEBT.md)); the seam is marked.

## 8. Envelope version independence (Architect rec 5, first addendum)

`StreamEnvelope` ([contracts/stream](../../../packages/contracts/src/stream/stream.ts)) is **decoupled
from `EventEnvelope`**: the domain event rides in an **opaque `payload`** (`z.unknown()`). A future
`EventEnvelope` change — a new field, a bumped `schemaVersion` — flows through to clients **without a
`StreamEnvelope` change** and without breaking existing realtime clients. The transport frame evolves on
its own `streamVersion` axis (default `1.0.0`). Proven in `contracts/test/stream.test.ts`.

## 9. Configurable operational limits (Architect rec 4)

All config-driven via `@vip/config` (`.env` only, ADR-0018):

| Env                                 | Default                 | Meaning                                                     |
| ----------------------------------- | ----------------------- | ----------------------------------------------------------- |
| `STREAM_ENABLED`                    | `true`                  | master switch (off ⇒ gateway is a pure proxy)               |
| `CORS_ALLOWED_ORIGINS`              | `''`                    | comma list of allowed browser origins (empty ⇒ same-origin) |
| `STREAM_MAX_CONNECTIONS_PER_TENANT` | `50`                    | connection ceiling per tenant (→ 429)                       |
| `STREAM_MAX_QUEUE_DEPTH`            | `500`                   | per-connection send-queue cap (backpressure/drop threshold) |
| `STREAM_REPLAY_BUFFER_SIZE`         | `200`                   | per-tenant ring-buffer size (reconnect replay depth)        |
| `STREAM_HEARTBEAT_INTERVAL_MS`      | `15000`                 | keepalive cadence                                           |
| `STREAM_MAX_CONNECTION_DURATION_MS` | `3600000`               | hard connection lifetime (set ≤ token TTL)                  |
| `STREAM_RECONNECT_RETRY_MS`         | `3000`                  | SSE `retry:` hint to clients                                |
| `NATS_URL`                          | `nats://localhost:4222` | backbone (dialed only when `STREAM_ENABLED`)                |

## 10. Diagnostics & metrics (Architect recs 2 & 3)

- **Per-connection diagnostics** (`GET /stream/diagnostics`, tenant-scoped, read-gated): connection id,
  tenant, topics, lifecycle state, connected-at + duration, resumed flag, replayed count, queue depth,
  last delivered id/at, heartbeat count + last-at.
- **Prometheus metrics** on `/metrics`
  ([stream-metrics.ts](../../../services/gateway/src/application/stream-metrics.ts)): active connections
  (per tenant), upstream subscriptions, queue depth, reconnects, replayed events, **dropped events by
  priority**, delivered events by topic/priority, heartbeats by outcome, and **delivery latency** —
  `stream_delivery_latency_seconds` (event `occurredAt` → delivered) and `stream_edge_latency_seconds`
  (backbone received → delivered), each yielding avg/p95/max.

## 11. Real-time architecture validation (Architect rec 7)

| Property                       | Guaranteed by                                                        | Proof                                                             |
| ------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Tenant isolation**           | per-tenant subject filter + channel fan-out + defence-in-depth check | `stream-hub.test.ts`, `stream-http.test.ts` (cross-tenant silent) |
| **Permission filtering**       | requested ∩ permitted (`principalCan`), 403 on empty                 | `stream-http.test.ts` (403), `stream-domain.test.ts`              |
| **Connection lifecycle**       | explicit states + timers; 401/403/429 pre-hijack                     | this doc §4; hub + http tests                                     |
| **Heartbeat**                  | interval timer emits `heartbeat`; write-throw ⇒ close                | `stream-hub.test.ts` (fake timers)                                |
| **Reconnect semantics**        | SSE `retry:` + `Last-Event-ID` resume                                | `streamClient.test.ts` (resume header), hub replay test           |
| **Replay**                     | bounded ring buffer, `id > lastEventId`, topic-filtered              | `stream-hub.test.ts` (replays 2/3)                                |
| **Backpressure**               | bounded queue + drain + priority eviction                            | `stream-hub.test.ts` (drops LOW, spares HIGH)                     |
| **Priority handling**          | edge `classifyPriority` + drop order                                 | `stream-domain.test.ts`, hub backpressure test                    |
| **Delivery latency**           | e2e + edge histograms                                                | `stream-hub.test.ts` (e2e ≈ 1s)                                   |
| **Stream metrics**             | `StreamMetrics` on `/metrics`                                        | metrics sink asserted in hub tests                                |
| **Transport abstraction**      | `ConnectionSink` port; SSE is one adapter                            | hub is SSE-free (compiles/tests without HTTP)                     |
| **Deterministic testing**      | InMemoryEventBus + FakeSink + injected clock/fetch                   | all G-5 suites (no infra)                                         |
| **Documentation completeness** | this doc + README + tracker + ED-0035                                | this package                                                      |

## 12. Deferred (tracked — [TD-19](../../../tracking/TECH-DEBT.md))

Durable JetStream replay (beyond the ring buffer) · WebSocket + gRPC transport adapters · multi-instance
gateway fan-out (sticky sessions / shared cursor) · low-priority event coalescing/throttling. All additive
behind the shipped `ConnectionSink` + ring-buffer + priority seams — no structural change required.
