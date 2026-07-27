# CURRENT PRIORITIES

> Pointer file — the **canonical** actionable list is [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → **Now**. Read it there.

## Right now (Phase 0, in order)
1. **P0-3** — CI skeleton (build/test/lint/scan + import-graph + contract-testing harness). *(next slice)*
2. **P0-7** — first service scaffold (`services/identity`, Fastify template).
3. **P0-5** — registry bootstrap (MLflow + DVC).

Done: Slice 0 → P0-1 (monorepo), P0-4 (dev docker-compose), P0-6 partial, stack ADRs. Slice 1 → **P0-2 `@vip/contracts`** (schemas + codegen + 19 tests; toolchain on latest stable).

Open decisions: [ND-2 vector DB], [ND-3 edge orchestrator] — not blocking Phase 0. (ND-1 resolved → NATS, [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md).)
