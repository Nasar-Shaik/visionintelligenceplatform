# CURRENT CONTEXT

> The immediate "what's happening now" for a resuming assistant. Keep this to a few lines; update it at the start/end of each slice.

- **Date updated:** 2026-07-27 (Slice 3)
- **Sprint:** Phase 0 — Program Setup ([CURRENT_SPRINT](../project/CURRENT_SPRINT.md)).
- **Just completed:** Slice 3 — **`@vip/service-identity`** reference Fastify template (layering transport→application→domain→adapters; zod fail-fast config; `/health` `/ready`+readiness registry `/metrics` Prometheus; tenant-context seam vs `TenantContext` contract; `ApiError` envelope + correlation ids; graceful SIGTERM). First `@vip/contracts` consumer. 19 tests (38 total) + live smoke-test green.
- **Next slice (awaiting approval):** **P0-5** — registry bootstrap (MLflow models + DVC datasets skeleton wired to object storage). P0-6 secrets (Vault/KMS) also still open.
- **Do not:** implement business/vertical features, or anything past Phase 0. Retail logic stays in `plugins/`.
- **Full detail:** latest [daily log](../daily/2026-07/2026-07-27.md) and [TASK-BOARD → Now](../../tracking/TASK-BOARD.md).
