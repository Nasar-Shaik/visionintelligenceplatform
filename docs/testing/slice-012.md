# Slice 12 — P1-7 Rule engine

> **Manually executable by the Product Owner.** Proves the automation brain: a tenant authors a
> versioned rule (sandboxed predicate DSL over the `EventEnvelope`), and when a matching
> `event.persisted` arrives the engine raises an `incident.candidate` (+ `rule.matched`) on the
> automation backbone — tenant-scoped, deterministic, loop-free, with a no-side-effect dry-run.
> Automated by the `@vip/service-rules` suite (35) + the perception/events contracts.

## Prerequisites

```bash
docker compose -f infra/docker/docker-compose.dev.yml up -d nats mongodb
export MONGO_URI='mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_rules?authSource=admin'
export NATS_URL='nats://localhost:44222' JWT_SECRET='test-secret-at-least-16-chars' PORT=8086
node services/rules/dist/index.js            # starts the engine consumer + ensures EVENTS + AUTOMATION streams
# (to see the full chain, also run the events service on 8084 — slice-011)
# mint an admin token for tnt_a (helper: signAccessToken, iss=identity aud=vip)
```

## Scenario A — Author + dry-run a rule (no side effects)

`POST /rules` (admin) with a rule that raises a **critical** incident on a high-confidence person:

```json
{
  "name": "high-conf person",
  "lifecycle": "enabled",
  "priority": 200,
  "eventTypes": ["perception.person.detected"],
  "condition": {
    "all": [
      { "field": "confidence", "op": "gte", "value": 0.8 },
      { "field": "category", "op": "eq", "value": "perception" }
    ]
  },
  "severity": "critical",
  "actions": [{ "type": "raise-incident", "title": "Person detected" }]
}
```

| Step | Action                                                  | Expected                                                                        |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A1   | `POST /rules` (admin)                                   | `201`; rule `version: 1`, `lifecycle: "enabled"`                                |
| A2   | `GET /rules/:id/versions`                               | one audit row, `changeKind: "created"`, `changedBy` = principal                 |
| A3   | `POST /rules/:id/dry-run` `{event: <person, conf 0.9>}` | `200 {matched: true, candidate: {severity:"critical"}}` — **nothing published** |
| A4   | `POST /rules/:id/dry-run` `{event: <person, conf 0.4>}` | `200 {matched: false, candidate: absent}`                                       |

## Scenario B — Live evaluation → incident candidate (acceptance)

Publish a `perception.person.detected` `EventEnvelope` on `t.tnt_a.event.…` (or drive the real chain via
the events service: publish a `DetectionResult` on `capability.output.*`).

| Step | Action                                        | Expected                                                                                                                            |
| ---- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| B1   | publish a matching event                      | engine publishes `incident.candidate` on `t.tnt_a.incident.candidate` + `rule.matched` on `t.tnt_a.rule.matched`                    |
| B2   | inspect the candidate                         | `severity:"critical"`, `ruleName`, `triggeredBy{eventId,eventType,cameraId}`, `matchedCount:1`, `dedupKey`, `category:"perception"` |
| B3   | publish a non-matching event (low confidence) | no candidate                                                                                                                        |

## Scenario C — Lifecycle, windowing, isolation, fail-closed

| Step | Action                                                                 | Expected                                                                                  |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| C1   | set the rule `lifecycle: "disabled"` (PATCH), publish a matching event | no candidate (only `enabled` rules evaluate); version bumped, audited `lifecycle-changed` |
| C2   | a rule with `window {withinSeconds:60,count:3,groupBy:"camera"}`       | candidate only on the **3rd** matching event within 60s (`matchedCount:3`)                |
| C3   | publish an event for `tnt_b` while only `tnt_a` has rules              | no candidate (rules never cross tenants)                                                  |
| C4   | publish an invalid (non-`EventEnvelope`) message                       | **dead-lettered** (`term`), never evaluated (fail-closed)                                 |
| C5   | the engine's own `incident.*`/`rule.*` outputs                         | never re-consumed (distinct subject root — no self-trigger)                               |

## Authorization

| Step | Action                                | Expected                                            |
| ---- | ------------------------------------- | --------------------------------------------------- |
| Z1   | `POST /rules` with no token           | `401`                                               |
| Z2   | `POST /rules` as `viewer`             | `403` (needs `rule:create`)                         |
| Z3   | `POST /rules/:id/dry-run` as `viewer` | `200` (dry-run needs only `rule:read` via `*:read`) |
| Z4   | `GET /rules/:id` as another tenant    | `404` (no existence leak)                           |

## Pass criteria

- **A3/A4** — dry-run reports the match + would-be candidate and **emits nothing**.
- **B1/B2** — a matching event yields an `incident.candidate` with full provenance on the automation root.
- **C1/C3/C4** — only `enabled` rules fire; no cross-tenant; invalid input is dead-lettered.

> Automated equivalent: `pnpm --filter @vip/service-rules test` (35; real-Mongo skips when `MONGO_URI`
> is unreachable) + `pnpm --filter @vip/contracts test`.
