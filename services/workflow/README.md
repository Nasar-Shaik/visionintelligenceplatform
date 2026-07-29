# @vip/service-workflow — Incident lifecycle (Phase 1, P1-8)

The **Workflow context** owns the **incident lifecycle**. It turns the rule engine's transient
`incident.candidate` into a durable, operator-facing **Incident** and drives it through an explicit
state machine. It is the first half of the P1-8 camera→alert vertical; the second half (the Alert
Engine) is [`@vip/service-notify`](../notify/README.md), which consumes `incident.raised` — never the
rule candidate (P1-8 Architect rec 3).

> Ownership: [22-BOUNDED-CONTEXTS §9](../../docs/architecture/22-BOUNDED-CONTEXTS.md) ·
> [23-SERVICE-OWNERSHIP](../../docs/architecture/23-SERVICE-OWNERSHIP.md) ·
> [11-WORKFLOW-ENGINE](../../docs/architecture/11-WORKFLOW-ENGINE.md) ·
> [phase1/INCIDENT_LIFECYCLE](../../docs/architecture/phase1/INCIDENT_LIFECYCLE.md).

## What it does

- **Promotes** `incident.candidate` (consumed on `t.*.incident.candidate`) into a persisted `raised`
  Incident, **idempotently** — a unique `(tenantId, source.dedupKey)` index collapses a burst of
  candidates into one incident. Publishes `incident.raised`.
- **Lifecycle** (P1-8 rec 2 — defined before the Alert Engine): `raised → acknowledged → resolved →
closed`, a validated state machine (illegal moves are `409`). Each transition bumps a version,
  appends an immutable history entry, and publishes `incident.acknowledged|resolved|closed`.
- **End-to-end correlation** (rec 1): every incident carries a required `correlationId` (the
  triggering event's, else anchored to the event id) + a `causationId` (the candidate) — so the
  frame → detection → event → candidate → incident → notification chain is unbroken.
- **API** (permission-gated, tenant-scoped): `GET /incidents`, `GET /incidents/:id`,
  `POST /incidents/:id/(ack|resolve|close)`. Incidents are **never created via the API** — only
  promoted from a candidate, so the automation flow is the single source of incidents.

## Topology (loop-free by construction)

```
rule engine ──▶ t.{tenant}.incident.candidate ──▶ [workflow promoter] ──▶ t.{tenant}.incident.raised ──▶ alert engine
                                                        │
                             operator API ──────────────┴──▶ t.{tenant}.incident.acknowledged|resolved|closed
```

The promoter consumes **only** `incident.candidate`; its outputs land on sibling `incident.*`
subjects it never consumes. AUTOMATION-stream isolation makes a self-trigger impossible.

## Layout

`domain/` — the pure state machine (`incident-state`) + factory (`incident-factory`: promote +
transition). `application/` — `incident-service` (the single place lifecycle logic lives),
`incident-promoter` (the consumer), `incident-publisher`, `ports`, `metrics`. `adapters/` — Mongo +
in-memory `IncidentStore`. `transport/` — Fastify server, auth/permissions, incident routes.

## Deferred (see [TECH-DEBT](../../tracking/TECH-DEBT.md))

Escalation policies + timers, assignment/on-call, cases, and a hash-chained audit log are the full
Workflow engine — out of P1-8 scope. Auto-acknowledging an incident from a `notification.acked`
signal (the workflow↔notify feedback loop) is deferred.

## Run

```bash
pnpm --filter @vip/service-workflow build
MONGO_URI=… NATS_URL=… JWT_SECRET=… PORT=8087 node services/workflow/dist/index.js
pnpm --filter @vip/service-workflow test   # real-Mongo tests skip when MONGO_URI is unreachable
```
