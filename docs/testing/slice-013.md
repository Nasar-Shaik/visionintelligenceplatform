# Slice 13 — P1-8 Incident lifecycle + Alert engine

> **Manually executable by the Product Owner.** Closes the camera→alert vertical (**M4**): a rule's
> `incident.candidate` becomes a **raised Incident** (workflow), which the **Alert Engine** (notify)
> turns into a **delivered notification with ack** — tenant-scoped, loop-free, with an unbroken
> `correlationId`. Automated by the `@vip/service-workflow` (19) + `@vip/service-notify` (18) suites
>
> - the incident/notification contracts (8).

## Prerequisites

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d nats mongodb
export NATS_URL='nats://localhost:44222' JWT_SECRET='test-secret-at-least-16-chars'
# workflow (incident lifecycle) on 8087
MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_workflow?authSource=admin' PORT=8087 node services/workflow/dist/index.js
# notify (alert engine) on 8088
MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_notify?authSource=admin' PORT=8088 node services/notify/dist/index.js
# to drive the full chain, also run rules (8086) + events (8084) + inference (P1-6)
# mint an admin/operator token for tnt_a (helper: signAccessToken, iss=identity aud=vip)
```

## Scenario A — Candidate → raised Incident (workflow, acceptance)

Publish an `incident.candidate` on `t.tnt_a.incident.candidate` (or drive the real chain: a
`DetectionResult` → `perception.person.detected` event → rule match → candidate).

| Step | Action                                               | Expected                                                                                                        |
| ---- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1   | publish a matching `incident.candidate`              | workflow publishes `incident.raised` on `t.tnt_a.incident.raised`; a `raised` Incident is persisted             |
| A2   | `GET /incidents` (operator)                          | the incident: `status:"raised"`, `severity`, `correlationId` present, `history:[{to:"raised"}]`, `matchedCount` |
| A3   | publish the **same** candidate again (same dedupKey) | **no** second incident, **no** second `incident.raised` (idempotent promotion)                                  |
| A4   | publish an invalid (non-`IncidentCandidate`) message | **dead-lettered** (`term`), never promoted (fail-closed)                                                        |

## Scenario B — Raised Incident → delivered notification (notify / Alert Engine, acceptance)

`POST /notification-channels` (admin) an in-app channel `{name, type:"in-app"}`, then publish/raise an
incident (Scenario A drives this over the backbone).

| Step | Action                                                   | Expected                                                                                                             |
| ---- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| B1   | an `incident.raised` arrives                             | notify delivers per channel: publishes `notification.sent` then `notification.delivered` on `t.tnt_a.notification.*` |
| B2   | `GET /notifications`                                     | one record: `status:"delivered"`, `channelType:"in-app"`, `correlationId` = the incident's (rec 1), `causationId`    |
| B3   | a channel with `minSeverity:"critical"`, `high` incident | **no** notification (severity floor)                                                                                 |
| B4   | a `webhook` channel whose endpoint 5xx's                 | `status:"failed"`, `lastError` recorded; `notification.failed` published                                             |
| B5   | the same `incident.raised` redelivered                   | **no** duplicate notification for that channel (idempotent per incident+channel)                                     |

## Scenario C — Lifecycle transitions + ack (with-ack completion)

| Step | Action                                                  | Expected                                                                             |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| C1   | `POST /incidents/:id/ack` (operator)                    | `200`; `status:"acknowledged"`, version 2, `acknowledgedBy`; `incident.acknowledged` |
| C2   | `POST /incidents/:id/resolve` `{resolution}`            | `200`; `status:"resolved"`, `resolution` recorded; `incident.resolved`               |
| C3   | `POST /incidents/:id/close` on a **raised** incident    | `409` (illegal transition — must be `resolved` first)                                |
| C4   | `POST /notifications/:id/ack` (operator) on a delivered | `200`; `status:"acked"`, `ackedBy`; `notification.acked`                             |
| C5   | `POST /notifications/:id/ack` on a **failed** one       | `409` (not in an ackable state)                                                      |

## Authorization & isolation

| Step | Action                                                | Expected                            |
| ---- | ----------------------------------------------------- | ----------------------------------- |
| Z1   | any route with no token                               | `401`                               |
| Z2   | `POST /incidents/:id/ack` as `viewer`                 | `403` (needs `incident:ack`)        |
| Z3   | `POST /notification-channels` as `viewer`             | `403` (needs `notification:create`) |
| Z4   | `GET /incidents/:id` (or a channel) as another tenant | `404` (no existence leak)           |
| Z5   | a `webhook` channel with an invalid `url`             | `400` (per-type config validation)  |

## Pass criteria

- **A1/A3/A4** — a candidate raises exactly one incident; repeats collapse; invalid input is dead-lettered.
- **B1/B2/B5** — a raised incident yields a delivered notification carrying the incident's correlationId; redelivery never double-notifies.
- **C1/C2/C3/C4/C5** — lifecycle + ack transitions are validated (illegal → 409) and audited.
- **Z1–Z5** — deny-by-default, cross-tenant 404, config validation.

> Automated equivalent: `pnpm --filter @vip/service-workflow test` (19) +
> `pnpm --filter @vip/service-notify test` (18) + `pnpm --filter @vip/contracts test` (real-Mongo
> tests skip when `MONGO_URI` is unreachable).
