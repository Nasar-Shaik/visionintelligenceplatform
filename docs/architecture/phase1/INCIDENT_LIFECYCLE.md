# Phase 1 — Incident Lifecycle (Workflow context, P1-8)

> Grounds the first half of P1-8 in [11-WORKFLOW-ENGINE](../11-WORKFLOW-ENGINE.md),
> [22-BOUNDED-CONTEXTS §9](../22-BOUNDED-CONTEXTS.md), [23-SERVICE-OWNERSHIP](../23-SERVICE-OWNERSHIP.md).
> Companion: [ALERT_ENGINE](ALERT_ENGINE.md) (the second half — delivery). Implemented by
> [`@vip/service-workflow`](../../../services/workflow/README.md).

## Purpose

Turn the rule engine's transient `incident.candidate` into a durable, operator-facing **Incident**
with an explicit, auditable lifecycle — the single source of raised incidents on the platform.

## The state machine (P1-8 Architect rec 2 — defined before the Alert Engine)

```
            promote (from incident.candidate)
                        │
                        ▼
   ┌────────┐  ack   ┌──────────────┐ resolve ┌──────────┐ close ┌────────┐
   │ raised │ ─────▶ │ acknowledged │ ──────▶ │ resolved │ ────▶ │ closed │
   └────────┘        └──────────────┘         └──────────┘       └────────┘
        │                                          ▲
        └────────────────── resolve ───────────────┘   (may resolve straight from raised)
```

- Only these transitions are legal; anything else is a **409**. Each transition **bumps a version**,
  appends an immutable `history[]` entry (from/to/at/by/note), and publishes
  `incident.acknowledged|resolved|closed`. Promotion publishes `incident.raised`.
- `raised → resolved` is allowed (resolve without an explicit ack); `close` requires `resolved`.

## Promotion (idempotent)

The `workflow` promoter consumes `incident.candidate` (filter `t.*.incident.candidate`) and creates a
`raised` incident. A unique `(tenantId, source.dedupKey)` index makes this **idempotent**: a burst of
candidates that share a dedup key collapses into **one** incident (repeat candidates return the
existing incident and do **not** re-publish `incident.raised`). Incidents are **never created via the
API** — only promoted — so automation is the sole source of incidents.

## End-to-end correlation (rec 1)

Every incident carries a **required `correlationId`** — the triggering event's, else anchored to the
event id — plus a `causationId` (the candidate). Combined with the events normalizer defaulting each
event's `correlationId` to its own id, the chain **frame → detection → event → candidate → incident →
notification** is unbroken and queryable.

## API (permission-gated, tenant-scoped)

`GET /incidents` (filter status/severity, keyset-paged) · `GET /incidents/:id` ·
`POST /incidents/:id/(ack|resolve|close)`. Another tenant's incident is a **404** (no existence leak).
`incident:read` to view; `incident:ack` / `incident:resolve` to transition (operators have both).

## Topology (loop-free)

The promoter filters **only** `incident.candidate`; its lifecycle outputs land on sibling
`incident.*` subjects it never consumes (all on the `AUTOMATION` stream). The Alert Engine consumes
`incident.raised` (Incident contracts only — never the candidate). No consumer can self-trigger.

## Deferred (→ [TD-8](../../../tracking/TECH-DEBT.md))

Escalation policies + timers, assignment/on-call, cases, and a hash-chained audit log (today's audit
is the embedded `history[]`) are the full Workflow engine — out of P1-8 scope. Auto-acknowledging an
incident from `notification.acked` (the workflow↔notify feedback loop) is deferred; evidence-ref
linking (clip/snapshot from `media`) is deferred.
