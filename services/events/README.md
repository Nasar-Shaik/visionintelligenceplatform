# @vip/service-events

The event backbone consumer + store (Phase 1, **P1-5**). Grounds:
[EVENT_PIPELINE](../../docs/architecture/phase1/EVENT_PIPELINE.md),
[09-EVENT-PLATFORM](../../docs/architecture/09-EVENT-PLATFORM.md),
[23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md) (Event Context),
[ADR-0005](../../docs/adr/ADR-0005-event-driven-backbone.md), [ADR-0016](../../docs/adr/ADR-0016-nats-jetstream-event-backbone.md).

## What it does

Turns capability outputs into **normalized, correlated, deduplicated, durable** events — the backbone
everything downstream reacts to.

```
capability output (detection)  ──▶  events: decode → validate → normalize → dedup+persist → publish
   t.{tenant}.capability.output.*         │                                         │
                                          ▼                                         ▼
                                    Mongo event store                     t.{tenant}.event.* (event.persisted)
                                    (tenant-scoped, @vip/tenancy)                    │
                                                                                     ▼
                                                                              rules / analytics (later)
```

- **Consume** `t.*.capability.output.*` off NATS JetStream (durable pull consumer, via `@vip/messaging`).
- **Normalize** each `DetectionResult` → one `EventEnvelope` per detection (label → domain-neutral
  catalog type; provenance/timing/subjects carried through; priority from the event catalog).
- **Deduplicate + persist** tenant-scoped to Mongo. The dedup key (`type + camera + zone + track/class
  - time-bucket`, [09 §Dedup](../../docs/architecture/09-EVENT-PLATFORM.md)) backs a **unique index**,
    so at-least-once redelivery and a repeated subject inside the window both collapse to one event.
- **Publish** the persisted envelope on `t.{tenant}.event.{type}` — the `event.persisted` signal.
- **Fail-closed** (Law 5): a payload that is not valid JSON, not a valid `DetectionResult` (e.g. no
  `tenantId`), or whose subject tenant disagrees with its body is **dead-lettered** (`term`), never
  processed. Persist/broker failures NAK for redelivery; the bus terminates a poison message after `maxDeliver`.

## HTTP API (control plane, via gateway)

| Method | Endpoint                          | Purpose                                                                | Auth           |
| ------ | --------------------------------- | ---------------------------------------------------------------------- | -------------- |
| GET    | `/events`                         | Tenant-scoped, cursor-paged, filtered query                            | `event:read`   |
| POST   | `/events/replay`                  | Re-publish a bounded time window onto the backbone (rebuild consumers) | `event:replay` |
| GET    | `/health` · `/ready` · `/metrics` | Liveness / readiness (Mongo) / Prometheus                              | —              |

Tenant scope is resolved from the validated access token (`iss=identity`, `aud=vip`) — a query can
never widen across tenants.

## Config (`@vip/config`, `.env` only)

`MONGO_URI` (event store) · `NATS_URL` (backbone) · `JWT_SECRET` (token verification) ·
`EVENTS_DEDUP_WINDOW_MS` (default 10000) · `EVENTS_REPLAY_CEILING` (default 10000) · `PORT` (default 8084).

## Tested

19 tests — pure normalization + dedup-key, ingest end-to-end on the in-memory bus/store (persist,
dedup, fail-closed dead-lettering, cross-tenant term), permission-gated + tenant-scoped HTTP
routes + replay, and a **real-MongoDB integration** (unique-index idempotency, guarded reads;
skip-if-unreachable). Live-validated end-to-end against dev-stack NATS JetStream + Mongo.
