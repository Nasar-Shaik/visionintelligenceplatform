# NEXT STEPS

> Canonical actionable list: [`tracking/TASK-BOARD.md`](../../tracking/TASK-BOARD.md). This is the near-term narrative.

1. **Approve Slice 0** (this setup) and merge/commit.
2. **Slice 1 — P0-2 `packages/contracts`:** schema-first foundation (Zod → JSON Schema/OpenAPI; event envelope + capability descriptor + config schemas), TS type codegen. The dependency for services and CI contract-testing.
3. **Slice 2 — P0-3 CI:** GitHub Actions (build/test/lint/scan) + import-graph enforcement + contract-testing harness.
4. **Slice 3 — P0-7 first service:** `services/identity` on Fastify using the service template (health/ready/metrics; tenant context; no business logic).
5. **Slice 4 — P0-5:** MLflow + DVC registry bootstrap.
6. **Exit Phase 0 → Phase 1** (SaaS Foundation) once the exit gate in [CURRENT_SPRINT.md](CURRENT_SPRINT.md) is met.

Nothing past Phase 0 until its exit gate is green. Wait for approval between sprints.
