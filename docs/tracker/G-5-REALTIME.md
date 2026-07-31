# G-5 — Real-Time Event Delivery Layer

> **Milestone:** P2-2 **G-5** · **Status:** ✅ **ACCEPTED** (Architect review 2026-07-31)
> **Scope:** the platform's production-grade real-time communication layer — SSE at the gateway edge
> streaming live incidents/alerts/events/system status, over the tenant-partitioned backbone.
> No new service (the gateway gains an event-fan-out edge). **Author:** Claude · _2026-07-31_

Full design + validation matrix: [phase2/REALTIME_DELIVERY](../architecture/phase2/REALTIME_DELIVERY.md).
Decision record: [ED-0035](../project/ENGINEERING_DECISION_LOG.md).

---

## 1. What shipped

- **Contracts** ([`@vip/contracts/stream`](../../packages/contracts/src/stream/stream.ts), **+2 → 55 schemas**):
  `StreamEnvelope` (**opaque `payload`** → decoupled from `EventEnvelope` evolution), `StreamControl`,
  `StreamTopic`, `StreamPriority`.
- **Messaging** ([`@vip/messaging`](../../packages/messaging/)): a `deliverNew` `EventBus` option
  (`DeliverPolicy.New`) so live consumers get only new events; the ring buffer serves reconnect catch-up.
- **Gateway** ([`services/gateway`](../../services/gateway/)) — an event-fan-out edge beside the proxy:
  - **StreamHub** (transport-agnostic): per-tenant backbone subscriptions, cursor + bounded reconnect
    ring buffer, per-connection **priority send-queues**, connection lifecycle, heartbeat/duration timers,
    diagnostics, metrics.
  - **`ConnectionSink`** transport port + **SSE adapter** (`GET /api/stream`) + **diagnostics** route
    (`GET /stream/diagnostics`) + hand-rolled **CORS** plugin.
  - **StreamMetrics** on `/metrics` incl. **delivery-latency** histograms.
- **Console** ([`apps/console`](../../apps/console/)): a **fetch-based SSE client** (bearer header; no
  token-in-URL) + `useLiveStream` mounted in the shell → feeds the `live` slice + invalidates query caches;
  **polling retained as fallback**.

## 2. The 7 Architect refinements — where each landed

| #   | Refinement                  | Where                                                                                                                                   |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Connection lifecycle**    | explicit `ConnectionState` + [REALTIME_DELIVERY §4](../architecture/phase2/REALTIME_DELIVERY.md#4-connection-lifecycle-architect-rec-1) |
| 2   | **Stream diagnostics**      | `hub.diagnostics()` + `GET /stream/diagnostics` (per-connection snapshot)                                                               |
| 3   | **Delivery latency**        | `stream_delivery_latency_seconds` (e2e) + `stream_edge_latency_seconds`                                                                 |
| 4   | **Configurable limits**     | all env-driven ([§9](../architecture/phase2/REALTIME_DELIVERY.md#9-configurable-operational-limits-architect-rec-4))                    |
| 5   | **Transport independence**  | `ConnectionSink` port; SSE is one adapter (WS/gRPC additive)                                                                            |
| 6   | **Future coalescing**       | documented seam at the priority-drop path; no impl (TD-19)                                                                              |
| 7   | **Architecture validation** | [REALTIME_DELIVERY §11](../architecture/phase2/REALTIME_DELIVERY.md#11-real-time-architecture-validation-architect-rec-7) matrix        |

(Plus the first addendum's ordering + replay-strategy + envelope-independence docs — §5/§6/§8.)

## 3. Validation (Architect rec 7) — proven by tests

tenant isolation · permission filtering · connection lifecycle · heartbeat · reconnect · replay ·
backpressure · priority · delivery latency · stream metrics · transport abstraction · deterministic
testing · documentation — each row mapped to a test in
[REALTIME_DELIVERY §11](../architecture/phase2/REALTIME_DELIVERY.md#11-real-time-architecture-validation-architect-rec-7).

## 4. Tests (deterministic; no infra)

| Suite                           |      Count | Covers                                                                                                                         |
| ------------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------ |
| contracts `stream.test.ts`      | 5 (of 128) | envelope shape, `streamVersion` default, opaque payload, priority rank                                                         |
| gateway `stream-domain.test.ts` |         13 | subject↔topic, priority classification, sources, permission map                                                                |
| gateway `stream-hub.test.ts`    |         11 | fan-out, tenant isolation, priority-drop backpressure, ring-buffer replay, diagnostics + latency, ceiling, heartbeat, teardown |
| gateway `stream-http.test.ts`   |          6 | SSE over the wire: 401/403, ready + live frame, cross-tenant isolation, diagnostics                                            |
| console `streamClient.test.ts`  |          4 | SSE frame parser, connect/resume (Last-Event-ID), polling fallback                                                             |

**Gateway 42 · contracts 128 · console 41.** All repo gates green (typecheck, import-graph 0-viol,
contracts 55, lint, build, format).

## 5. Deferred ([TD-19](../../tracking/TECH-DEBT.md))

Durable JetStream replay · WebSocket/gRPC adapters · multi-instance fan-out · low-priority coalescing.
All additive behind the shipped `ConnectionSink` + ring-buffer + priority seams.

## 6. Definition of Done

- [x] Real-time layer at the gateway edge; no new service; no frozen doc (01–28) changed.
- [x] Contract-first (+2 → 55); StreamHub transport-agnostic; tenant-isolated; permission-gated.
- [x] Deterministic tests (gateway 42, console 41, contracts 128); all gates green.
- [x] All 7 Architect refinements incorporated; validation matrix documented.
- [x] **Architect review of G-5** ✅ **APPROVED** (2026-07-31) — foundational platform (G-1…G-5) complete; AI Processing Phase authorized.
