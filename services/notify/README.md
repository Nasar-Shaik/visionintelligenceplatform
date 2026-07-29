# @vip/service-notify — Alert Engine (Phase 1, P1-8)

The **Notification context** is the **Alert Engine** — the second half of the P1-8 camera→alert
vertical. It consumes **`incident.raised`** (Incident contracts only — never the rule candidate,
P1-8 Architect rec 3), fans each incident out to the tenant's matching channels, records a delivery
log, and lets a recipient acknowledge. The first half (incident lifecycle) is
[`@vip/service-workflow`](../workflow/README.md).

> Ownership: [22-BOUNDED-CONTEXTS §12](../../docs/architecture/22-BOUNDED-CONTEXTS.md) ·
> [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md) ·
> [phase1/ALERT_ENGINE](../../docs/architecture/phase1/ALERT_ENGINE.md).

## What it does

- **Fan-out**: on `incident.raised`, select the tenant's **enabled** channels whose `minSeverity`
  floor the incident meets, build a notification per channel, hand it to the channel transport, and
  record the outcome — publishing `notification.sent` then `notification.delivered|failed`.
- **Channels** (Phase 1, credential-free): `in-app` (the delivery log is the inbox) and `webhook`
  (HTTP POST; 2xx = delivered). Email/SMS/push providers are integration-only and deferred
  ([TECH-DEBT](../../tracking/TECH-DEBT.md)). Senders are injected → the engine is testable without
  real HTTP.
- **Correlation** (rec 1): every notification inherits the incident's `correlationId` +
  `causationId`, so the frame→…→incident→notification chain is unbroken.
- **Ack**: `POST /notifications/:id/ack` moves a delivered notification to `acked` and publishes
  `notification.acked` — the "with-ack" completion of the vertical.
- **Idempotent**: a redelivered `incident.raised` never double-notifies a channel (unique
  `(tenant, incident, channel)` in the delivery log).
- **API** (permission-gated, tenant-scoped): `/notification-channels` CRUD, `GET /notifications`,
  `GET /notifications/:id`, `POST /notifications/:id/ack`.

## Topology (loop-free by construction)

```
workflow ──▶ t.{tenant}.incident.raised ──▶ [alert engine] ──▶ channels (in-app / webhook)
                                                 └──▶ t.{tenant}.notification.sent|delivered|failed|acked
```

The engine consumes **only** `incident.raised` and publishes onto the distinct
`t.*.notification.>` root (NOTIFICATIONS stream), which it never consumes — no self-trigger.

## Layout

`domain/` — pure `channel-selection`, `channel-factory`, `notification-factory` (delivery-state
transitions). `application/` — `alert-engine` (the consumer), `channel-sender` (transport seam +
in-app/webhook senders), `channel-service`/`notification-service`, `notification-publisher`, `ports`,
`metrics`. `adapters/` — Mongo + in-memory channel/notification stores. `transport/` — Fastify server,
auth/permissions, channel + notification routes.

## Run

```bash
pnpm --filter @vip/service-notify build
MONGO_URI=… NATS_URL=… JWT_SECRET=… PORT=8088 node services/notify/dist/index.js
pnpm --filter @vip/service-notify test   # real-Mongo tests skip when MONGO_URI is unreachable
```
