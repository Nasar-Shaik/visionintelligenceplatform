# CURRENT PRIORITIES

> Pointer file — the **canonical** actionable list is [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md) → **Now**. Read it there.

## Right now (Phase 0 complete → exit)

1. **Phase 0 exit review** — verify exit criteria (CI green on the empty service, contracts generating, dev stack incl. MLflow/DVC runs). _(next)_
2. **Open Phase 1 → P1-1** — tenant model + fail-closed data-layer isolation guard (turns the identity tenant-context seam into enforcement; [R-010](../project/RISK_REGISTER.md)).

Done (Phase 0, all): P0-1 monorepo, P0-2 `@vip/contracts` (19), P0-3 CI gate, P0-4 dev stack, P0-5 MLOps registry (MLflow+DVC; 5 py), P0-6 `.env`-only secrets + `@vip/config` (14), P0-7 `@vip/service-identity` (19). **52 TS + 5 py tests.**

Open decisions: [ND-2 vector DB], [ND-3 edge orchestrator] — not blocking Phase 0. (ND-1 resolved → NATS, [ADR-0016](../adr/ADR-0016-nats-jetstream-event-backbone.md).)
