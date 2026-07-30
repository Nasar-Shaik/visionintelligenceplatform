# @vip/e2e — End-to-End Pipeline Validation (G-3.5)

A deterministic, broker-free harness that composes the **real** application spine of the four backbone
services and proves the whole backend chain works end-to-end — with **no camera, no Mongo, no NATS**.

```
DetectionResult ─▶ events ─ t.*.event.> ─▶ rules ─ incident.candidate ─▶ workflow ─ incident.raised ─▶ notify
                    (normalize·persist)      (evaluate)                   (promote)                    (alert)
```

## Why it lives under `tools/`

Composing more than one service's internals is forbidden for production code
(`noCrossServiceInternals`, [import-graph](../import-graph/boundaries.json)). The `tool` layer is
outside the runtime dependency graph, so this validation rig may import the service application classes
directly — production code never does; services communicate over the bus alone.

## How it works

- [`src/harness.ts`](src/harness.ts) — `PlatformHarness` wires `EventIngestService`, `RuleEngine`,
  `IncidentPromoter`+`IncidentService`, and `AlertEngine` (the real classes) onto one
  [`InMemoryEventBus`](../../packages/messaging/src/event-bus.ts), with the services' own in-memory
  adapters. The bus delivers **synchronously and recursively**, so one `emitDetection()` drives the
  entire cascade within a single awaited call — no sleeps, fully deterministic.
- [`src/determinism.ts`](src/determinism.ts) — injected clock + sequential UUID factory (nothing calls
  `Date.now()`/`randomUUID()`), so replay and regression are byte-reproducible.
- [`src/scenarios.ts`](src/scenarios.ts) — the nine reusable AI scenarios (regression **and** demo).

## Run

```bash
pnpm --filter @vip/e2e test        # 7 files, 33 tests
pnpm --filter @vip/e2e typecheck
```

## Tests

| File                                | Covers                                           |
| ----------------------------------- | ------------------------------------------------ |
| `test/smoke.e2e.test.ts`            | spine composes + cascade runs                    |
| `test/scenarios.e2e.test.ts`        | 9 AI scenarios + contracts + strict boundary     |
| `test/traceability.e2e.test.ts`     | traceability + correlationId + 5 Architect flows |
| `test/multi-tenant.e2e.test.ts`     | tenant isolation                                 |
| `test/rules-behaviour.e2e.test.ts`  | rule conflict, duplicate, replay/determinism     |
| `test/performance.e2e.test.ts`      | 100/1k/10k baseline                              |
| `test/failure-recovery.e2e.test.ts` | fail-closed + recovery + degraded delivery       |

Full write-up: [`docs/tracker/G-3.5-VALIDATION.md`](../../docs/tracker/G-3.5-VALIDATION.md).
