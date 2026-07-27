# CURRENT SPRINT

- **Phase:** Phase 0 — Program Setup & Architecture ([ROADMAP](../../tracking/ROADMAP.md)).
- **Goal:** Stand up the monorepo, contracts pipeline, CI, dev stack, and continuity system so feature work can begin on a solid, self-documenting foundation.
- **Definition of exit (Phase 0):** repo self-documenting; `packages/contracts` generating types; CI green (build/test/scan + import-graph + contract-testing harness) on an empty service; dev stack (Mongo/Redis/MinIO/NATS) runs.

## Slices (one at a time)

| Slice                                    | Item(s)                                                                                                                                                | Status                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| **Slice 0 — Program & Continuity Setup** | stack ADRs (0016/0017); `docs/ai/*`, `docs/project/*`, `docs/daily/*`; monorepo skeleton (P0-1); dev docker-compose (P0-4); `.env.example` (part P0-6) | ✅ done 2026-07-27         |
| **Slice 1 — Contracts**                  | **P0-2** `packages/contracts` schema-first + codegen + 19 tests                                                                                        | ✅ done 2026-07-27         |
| **Slice 2 — CI**                         | **P0-3** GitHub Actions: build/test/lint/scan + import-graph + contract-testing                                                                        | ✅ done 2026-07-27         |
| **Slice 3 — First service**              | **P0-7** `services/identity` Fastify template (/health,/ready,/metrics; no business logic)                                                             | ✅ done 2026-07-27         |
| **Slice 4 — Registry bootstrap**         | **P0-5** MLflow + DVC skeleton (validated end-to-end)                                                                                                  | ✅ done 2026-07-27         |
| **Slice 5 — Secrets**                    | **P0-6** `.env`-only secrets + centralized `@vip/config` (ADR-0018)                                                                                    | ✅ done 2026-07-27         |
| **Phase 0 Exit**                         | Exit review → open Phase 1 (P1-1 tenant model + fail-closed isolation)                                                                                 | ⏭ next (awaiting approval) |

## Rules for this sprint

Setup only — **no business/vertical features**, nothing past Phase 0. Retail logic (the first industry) is deferred to Industry-Pack work in later phases and always lives in `plugins/`.

See also: [../../tracking/TASK-BOARD.md](../../tracking/TASK-BOARD.md) (canonical Now list), [../ai/CURRENT_CONTEXT.md](../ai/CURRENT_CONTEXT.md).
