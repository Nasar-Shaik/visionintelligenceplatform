# Slice 11 — P1-5 Event pipeline

> **Manually executable by the Product Owner.** Proves the event backbone: a capability output
> (detection) on NATS becomes a **normalized, deduplicated, persisted** `EventEnvelope`, is
> re-published as `event.persisted` on the tenant subject, is queryable tenant-scoped, and can be
> replayed — and a payload without tenant context is dead-lettered (fail-closed). Automated by the
> `@vip/messaging` (10) + `@vip/service-events` (19, incl. real-Mongo) suites.

## Prerequisites

```bash
# dev-stack NATS + Mongo
docker compose -f infra/docker/docker-compose.dev.yml up -d nats mongodb
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_events?authSource=admin'
export NATS_URL='nats://localhost:44222' JWT_SECRET='test-secret-at-least-16-chars' PORT=8084
node services/events/dist/index.js          # starts consumer + ensures CAPABILITY_OUTPUT + EVENTS streams
# mint an admin token for tnt_a (helper: signAccessToken, iss=identity aud=vip)
```

## Scenario A — Detection → persisted, deduplicated event (acceptance)

Publish a `DetectionResult` (person, conf 0.84) to `t.tnt_a.capability.output.perception.person-detection`
**twice** (at-least-once / repeat).

| Step | Action                                                | Expected                                                                                                                                             |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | publish the detection once                            | events service acks; one `EventEnvelope` persisted                                                                                                   |
| A2   | `GET /events` (admin token)                           | `200`; one event `type: perception.person.detected`, `tenantId`, provenance (`producer`, `model`), `correlationId`, subject `{class:"person", bbox}` |
| A3   | publish the **same** detection again (same window)    | **deduped** — still exactly **one** event (unique `{tenantId,dedupKey}` index)                                                                       |
| A4   | subscribe `t.*.event.>` before publishing a fresh one | the persisted envelope is re-published on `t.tnt_a.event.perception.person.detected` (`event.persisted`)                                             |

## Scenario B — Fail-closed (Law 5)

| Step | Action                                              | Expected                                              |
| ---- | --------------------------------------------------- | ----------------------------------------------------- |
| B1   | publish a payload with **no `tenantId`**            | **dead-lettered** (`term`) — never persisted          |
| B2   | publish invalid JSON / not a `DetectionResult`      | dead-lettered (`term`)                                |
| B3   | publish on `t.tnt_b.…` with a body claiming `tnt_a` | dead-lettered (`term`) — subject/body tenant mismatch |

## Scenario C — Tenant-scoped query + authorization

| Step | Action                                         | Expected                                 |
| ---- | ---------------------------------------------- | ---------------------------------------- |
| C1   | `GET /events` with **no** token                | `401`                                    |
| C2   | `GET /events` with a role lacking `event:read` | `403`                                    |
| C3   | `GET /events` as **tnt_b**                     | never returns tnt_a's events (isolation) |
| C4   | `GET /events?type=perception.vehicle.detected` | filtered to that type only               |

## Scenario D — Replay (admin)

| Step | Action                                  | Expected                                                                                                           |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1   | `POST /events/replay` (viewer/operator) | `403` (needs `event:replay`)                                                                                       |
| D2   | `POST /events/replay {from,to}` (admin) | `200 {replayed:N}`; the window's envelopes re-published on `t.{tenant}.event.*` (idempotent — msgId = envelope id) |

## Scenario E — Inference → backbone (integration, optional)

```bash
python -m pip install -r ai/inference/requirements.txt      # nats-py (+ onnx deps)
INFERENCE_EVENT_SINK=nats NATS_URL=nats://localhost:44222 python ai/inference/app.py
# POST /infer a frame → the NatsEventSink publishes the DetectionResult onto capability.output.*
```

| Step | Action                      | Expected                                                               |
| ---- | --------------------------- | ---------------------------------------------------------------------- |
| E1   | `POST /infer` a frame       | inference publishes to `t.{tenant}.capability.output.{capId}`          |
| E2   | `GET /events` (that tenant) | the detection appears as a persisted `perception.*` event (end-to-end) |

## Pass criteria

- **A1–A4** — a detection becomes exactly one persisted, provenance-complete event and is re-published on the tenant event subject; duplicates collapse.
- **B1–B3** — anything without a valid tenant is dead-lettered, never persisted (fail-closed).
- **C3** — a tenant never reads another tenant's events.

> Automated equivalent: `pnpm --filter @vip/messaging test` (10) + `pnpm --filter @vip/service-events test`
> (19, real-Mongo skips when `MONGO_URI` is unreachable).
