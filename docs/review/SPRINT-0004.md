# SPRINT-0004 — Registry bootstrap (P0-5)

- **Date:** 2026-07-27 · **Phase/Slice:** Phase 0 · Slice 4 · **Branch:** feature/v1 · **Engineer:** Claude

## Objective

Bootstrap the MLOps registries defined in [docs/architecture/08](../architecture/08-AI-ML-PLATFORM.md): a **Model Registry** (MLflow + Postgres backend + MinIO artifacts) and a **Dataset Registry** (DVC + MinIO S3 remote), wired to the local dev stack. Skeleton only — no training/model code.

## Completed Work

- **Dev stack** extended (`infra/docker/docker-compose.dev.yml`): `mlflow` (built from a pinned image), `mlflow-postgres` (backend store), `createbuckets` (one-shot MinIO bucket bootstrap). Ports in the 4xxxx range (MLflow 45000, Postgres 45432).
- **Pinned MLflow image** `infra/docker/mlflow/Dockerfile` (mlflow 3.14.0 + psycopg2-binary 2.9.12 + boto3 1.43.56).
- **`ai/mlops/`**: `config.py` (stdlib-only, env-driven), `verify_registry.py` (integration smoke), `requirements.txt` (pinned), `tests/test_config.py` (5 stdlib unit tests). README.
- **`ai/datasets/`** + **DVC** initialised (`.dvc/config`, `.dvc/.gitignore`, `.dvcignore`) with the `minio` S3 remote; `.gitignore` scoped so dataset bytes stay out but pointers/READMEs are tracked.
- **`.env.example`** extended (MLflow/Postgres/S3/DVC vars). **CI** gained an `mlops` job (stdlib config tests) in the `ci-summary` rollup.

## Architecture Compliance

Implements doc 08 §2 (Model Registry) and §3 (Dataset Registry). No core coupling (infra + `ai/` only); import-graph unaffected. New [Constraint 14b/14c](../project/CONSTRAINTS.md): weights/data never in git; models bound by registry selector ([ADR-0002](../adr/ADR-0002-model-agnostic-inference.md)).

## Definition of Done

| #   | Item                    | Status                                                                                   |
| --- | ----------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Implementation Complete | ✅ (bootstrap scope)                                                                     |
| 2   | Documentation Updated   | ✅ governance suite + READMEs                                                            |
| 3   | README Updated          | ✅ ai/mlops + ai/datasets                                                                |
| 4   | Unit Tests              | ✅ 5 stdlib config tests                                                                 |
| 5   | Integration Tests       | ✅ live end-to-end smoke (`verify_registry.py`)                                          |
| 6   | Scenario Tests          | ✅ [slice-004](../testing/slice-004.md)                                                  |
| 7   | Logging                 | ➖ N/A (infra; MLflow logs itself)                                                       |
| 8   | Metrics                 | ➖ N/A this slice                                                                        |
| 9   | Health Checks           | ✅ MLflow + Postgres compose healthchecks                                                |
| 10  | Docker Validation       | ✅ image built + full stack launched healthy + smoke passed + torn down                  |
| 11  | Dependency Review       | ✅ registry-verified, recorded in DEPENDENCIES                                           |
| 12  | Security Review         | ✅ no secrets committed; DVC creds via config.local; MLflow auth/TLS = prod TODO (R-014) |
| 13  | Architecture Review     | ⏳ PENDING ARCHITECT REVIEW                                                              |

## Files Created

`infra/docker/mlflow/Dockerfile`; `ai/mlops/{README.md,config.py,verify_registry.py,requirements.txt,tests/test_config.py}`; `ai/datasets/README.md`; `.dvc/config`, `.dvc/.gitignore`, `.dvcignore`; `docs/testing/slice-004.md`; `docs/review/SPRINT-0004.md`.

## Files Modified

`infra/docker/docker-compose.dev.yml`, `.env.example`, `.gitignore`, `.github/workflows/ci.yml`, governance suite (`ENGINEERING_DECISION_LOG`, `RISK_REGISTER`, `ASSUMPTIONS`, `OPEN_QUESTIONS`, `CONSTRAINTS`, `QUALITY_GATES`, `API_INVENTORY`, `DEPENDENCIES`), trackers, daily log, `docs/{testing,review}/README.md`, `docs/ai/*` + `docs/project/CURRENT_SPRINT.md`.

## Risks

New: **R-012** (MLflow host allowlisting), **R-013** (Python deps unlocked), **R-014** (MLflow no auth/TLS). **R-011** downgraded to Mitigating (postgres/python pinned). See [RISK_REGISTER](../project/RISK_REGISTER.md).

## Technical Debt

TD-1 (carried). New implicit: MinIO/NATS images still floating `latest` (pin next); Python lockfile + linter absent (Q-011).

## Known Issues

None open.

## Commands Executed

```
docker compose --env-file .env.example -f infra/docker/docker-compose.dev.yml config
docker compose --env-file .env.example -f infra/docker/docker-compose.dev.yml build mlflow
docker compose --env-file .env.example -f infra/docker/docker-compose.dev.yml up -d minio createbuckets mlflow-postgres mlflow
python -m unittest discover -s ai/mlops/tests
docker compose ... run --rm mlflow python verify_registry.py
docker compose --env-file .env.example -f infra/docker/docker-compose.dev.yml down
```

## Tests Performed

Stdlib config unit tests; live end-to-end integration (log run → MinIO artifact → register model → read back) against the running stack; compose config validation; image build.

## Test Results

**5 unit tests pass.** Integration smoke: `OK: run 0f0d3ce9… logged; model vip-smoke-model v1 registered + read back.` MLflow/Postgres/MinIO all reported healthy. Full root gate (format/lint/typecheck/test/build/check:imports/verify:contracts) green.

## Breaking Changes

None.

## Next Sprint Recommendation

- **Proposed by:** Claude
- **Status:** WAITING FOR ARCHITECT APPROVAL
- **Reason:** Close out Phase 0 → **Slice 5 = P0-6** (secrets management: resolve Q-006 Vault vs cloud KMS; wire the integration pattern beyond `.env.example`), then a **Phase 0 exit review** against the exit criteria (CI green on the empty service, contracts generating, dev stack runs — now including MLflow/DVC).
- **Dependencies:** Q-006 decision (Vault vs KMS). Independent of feature work.
- **Risks:** secret-store choice affects local dev ergonomics + prod parity; R-014 (registry auth) partly addressed by the same secrets work.
- **Estimated Complexity:** Medium (integration pattern + docs; low code volume).

## Architect Review

> PENDING ARCHITECT REVIEW
