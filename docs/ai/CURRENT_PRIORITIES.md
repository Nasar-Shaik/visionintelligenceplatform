# CURRENT PRIORITIES

> Pointer file — the **canonical** actionable list is [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → **Now**. Read it there.

## Right now (Phase 0, in order)

1. **P0-7** — first service scaffold (`services/identity`, Fastify template). _(next slice)_
2. **P0-5** — registry bootstrap (MLflow + DVC).
3. **P0-6** — finish Vault/KMS secrets pattern (`.env.example` conventions done).

Done: Slice 0 → P0-1 (monorepo), P0-4 (dev docker-compose), P0-6 partial, stack ADRs. Slice 1 → **P0-2 `@vip/contracts`** (schemas + codegen + 19 tests; toolchain on latest stable). Slice 2 → **P0-3 CI gate** (import-graph `tools/import-graph/` + contract harness `tools/contracts/` + security scan; repo Prettier baseline).

Open decisions: [ND-2 vector DB], [ND-3 edge orchestrator] — not blocking Phase 0. (ND-1 resolved → NATS, [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md).)
