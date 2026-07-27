# CURRENT PRIORITIES

> Pointer file — the **canonical** actionable list is [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → **Now**. Read it there.

## Right now (Phase 0, in order)

1. **P0-6** — secrets management pattern (Vault vs cloud KMS, [Q-006](../project/OPEN_QUESTIONS.md)) beyond `.env.example`. _(next slice — last Phase-0 item)_
2. **Phase 0 exit review** — CI green on the empty service, contracts generating, dev stack runs (now incl. MLflow/DVC).

Done: Slice 0 → P0-1 (monorepo), P0-4 (dev docker-compose), P0-6 partial, stack ADRs. Slice 1 → **P0-2 `@vip/contracts`** (19 tests). Slice 2 → **P0-3 CI gate** (import-graph + contract harness + security). Slice 3 → **P0-7 `@vip/service-identity`** (Fastify template; 19 tests). Slice 4 → **P0-5 MLOps registry** (MLflow+DVC; validated end-to-end; 5 tests).

Open decisions: [ND-2 vector DB], [ND-3 edge orchestrator] — not blocking Phase 0. (ND-1 resolved → NATS, [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md).)
