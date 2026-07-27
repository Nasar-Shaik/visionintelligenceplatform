# Slice 004 — Registry bootstrap (MLflow + DVC) · Manual Test Scenarios

- **Target:** the MLOps registry infrastructure (Model Registry = MLflow+Postgres+MinIO; Dataset Registry = DVC+MinIO).
- **Prereqs:** Docker running; `cp .env.example .env`; Python 3.10+ for the client (a venv).

## How to run it

```bash
pnpm dev:stack                      # brings up MinIO, Postgres, MLflow, bucket bootstrap
# MLflow UI:  http://localhost:45000     MinIO console: http://localhost:49001 (vip_dev / change_me_dev_only)
```

## Positive Tests

### T-1 MLflow server is healthy

- **Steps:** `curl -i http://localhost:45000/health`
- **Expected:** `200`.
- **Pass Criteria:** 200. **Result:** ☐ Pass ☐ Fail

### T-2 Buckets were created

- **Steps:** open MinIO console → Buckets.
- **Expected:** `mlflow-artifacts` and `vip-datasets` exist.
- **Pass Criteria:** both buckets present. **Result:** ☐ Pass ☐ Fail

### T-3 End-to-end registry smoke (the key test)

- **Steps:**
  ```bash
  python -m venv .venv && . .venv/bin/activate
  pip install -r ai/mlops/requirements.txt
  set -a && source .env && set +a
  python ai/mlops/verify_registry.py
  ```
- **Expected:** `OK: run <id> logged; model vip-smoke-model v1 registered + read back.`
- **Pass Criteria:** exit 0; the run + model appear in the MLflow UI; an artifact appears under `mlflow-artifacts` in MinIO. **Result:** ☐ Pass ☐ Fail

### T-4 Config unit tests (no stack, no deps)

- **Steps:** `python -m unittest discover -s ai/mlops/tests`
- **Expected:** 5 tests pass.
- **Pass Criteria:** OK. **Result:** ☐ Pass ☐ Fail

### T-5 DVC remote is configured

- **Steps:** `pip install dvc dvc-s3 && dvc remote list`
- **Expected:** `minio  s3://vip-datasets`.
- **Pass Criteria:** remote listed. **Result:** ☐ Pass ☐ Fail

## Negative / Edge

### T-6 Invalid config is rejected

- **Steps:** `MLFLOW_TRACKING_URI= python ai/mlops/verify_registry.py`
- **Expected:** fails fast with a "config … is present but empty" ValueError.
- **Pass Criteria:** non-zero exit, clear error. **Result:** ☐ Pass ☐ Fail

### T-7 Data bytes stay out of git

- **Steps:** confirm `.gitignore` scopes `/datasets/` to root and DVC writes a per-dir `.gitignore`; `git status` after a hypothetical `dvc add` shows only the `*.dvc` pointer staged.
- **Expected:** dataset bytes are never tracked by git (Constraint 14b).
- **Pass Criteria:** only pointers/metadata tracked. **Result:** ☐ Pass ☐ Fail

## Failure Cases

### T-8 MLflow rejects an unknown Host header

- **Steps:** call the REST API with a Host not in `--allowed-hosts`.
- **Expected:** `403 Invalid Host header` (DNS-rebinding protection) — this is why internal clients use the `mlflow` service name that is allowlisted.
- **Pass Criteria:** protection active; documented in [ED-0017](../project/ENGINEERING_DECISION_LOG.md). **Result:** ☐ Pass ☐ Fail

## Manual Validation

- MLflow UI shows the experiment `vip-registry-smoke`, the run, its metric/param, and the registered model version.
- `pnpm dev:stack:down` tears everything down cleanly.

## Performance Tests

➖ **N/A** — bootstrap wiring; registry scale/HA is validated in P9.

## Summary

- **Automated coverage:** 5 stdlib unit tests (CI `mlops` job) + the `verify_registry.py` integration script (run against the live stack — passed during Slice 4 build).
- **Overall Pass Criteria:** T-1…T-8 pass.
