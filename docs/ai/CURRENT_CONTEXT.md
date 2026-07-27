# CURRENT CONTEXT

> The immediate "what's happening now" for a resuming assistant. Keep this to a few lines; update it at the start/end of each slice.

- **Date updated:** 2026-07-27 (Slice 4)
- **Sprint:** Phase 0 — Program Setup ([CURRENT_SPRINT](../project/CURRENT_SPRINT.md)).
- **Just completed:** Slice 4 — **MLOps registry bootstrap (P0-5)**: Model Registry = MLflow 3.14 + Postgres + MinIO (dev stack services `mlflow`/`mlflow-postgres`/`createbuckets`, pinned image); Dataset Registry = DVC + MinIO S3 remote (`ai/datasets/`, `.dvc/`). `ai/mlops/` config + integration smoke + 5 stdlib tests + CI `mlops` job. **Validated end-to-end on the live stack** then torn down. 43 tests total.
- **Next slice (awaiting approval):** **P0-6** — secrets management pattern (resolve Q-006 Vault vs cloud KMS) beyond `.env.example`; then Phase 0 exit review. **This is the last Phase-0 item.**
- **Do not:** implement business/vertical features, or anything past Phase 0. Retail logic stays in `plugins/`.
- **Full detail:** latest [daily log](../daily/2026-07/2026-07-27.md) and [TASK-BOARD → Now](../../tracking/TASK-BOARD.md).
