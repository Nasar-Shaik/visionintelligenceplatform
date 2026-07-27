# ai/mlops/ — Registry Integration (Model Registry + Dataset Registry)

Phase 0 **bootstrap skeleton** for the MLOps registries defined in
[docs/architecture/08-AI-ML-PLATFORM.md](../../docs/architecture/08-AI-ML-PLATFORM.md)
(§2 Model Registry, §3 Dataset Registry). No training or model code yet — this proves the
infrastructure wiring so later phases (P3/P9) can register real artifacts.

## Purpose

- **Model Registry** — MLflow (tracking + model registry) backed by **Postgres** (metadata)
  and **MinIO/S3** (artifacts). The source of truth for versioned, immutable model artifacts
  with lineage + metrics + model cards. Capabilities bind models by **selector**, never by
  hardcoded path ([ADR-0002](../../docs/adr/ADR-0002-model-agnostic-inference.md)).
- **Dataset Registry** — **DVC** with an S3 remote on MinIO. Versioned datasets with lineage
  (raw → labeled → splits) and consent/licensing metadata (recorded per dataset in
  [`../datasets/`](../datasets/README.md)).

## Architecture Position

Control-plane MLOps infrastructure. Owned conceptually by the `registry` service
([docs/architecture/23](../../docs/architecture/23-SERVICE-OWNERSHIP.md) › registry); this
folder holds the client integration + bootstrap, not a running service.

## Components

| File                   | Role                                                                   |
| ---------------------- | ---------------------------------------------------------------------- |
| `config.py`            | Typed, env-driven config (stdlib-only; unit-tested without heavy deps) |
| `verify_registry.py`   | Integration smoke: log run + artifact + register a model, read back    |
| `requirements.txt`     | Pinned client deps (mlflow, dvc[s3], boto3)                            |
| `tests/test_config.py` | Unit tests (stdlib `unittest`) — run in CI                             |

## Configuration

From the environment (see [`.env.example`](../../.env.example)): `MLFLOW_TRACKING_URI`,
`MLFLOW_S3_ENDPOINT_URL`, `MLFLOW_ARTIFACTS_BUCKET`, `DVC_REMOTE_BUCKET`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Dev S3 creds map to the MinIO root user.

## Run / Verify

```bash
# 1. Bring up the stack (MinIO, Postgres, MLflow, bucket bootstrap)
pnpm dev:stack
# MLflow UI:  http://localhost:45000    MinIO console: http://localhost:49001

# 2. Install client deps (use a venv; requires Python 3.10+)
python -m venv .venv && . .venv/bin/activate
pip install -r ai/mlops/requirements.txt

# 3. Export env and run the integration smoke test
set -a && source .env && set +a
python ai/mlops/verify_registry.py         # → "OK: run … registered + read back."
```

## Testing

```bash
# Unit (no deps, no stack) — also runs in CI:
python -m unittest discover -s ai/mlops/tests
```

Integration (`verify_registry.py`) needs the stack up + deps — see [manual scenarios](../../docs/testing/slice-004.md).

## Extension Points

- Add a `model card` schema + `register_model.py` helper in P3/P9 (metrics/lineage/license gates).
- Continuous-training (CT) pipelines + drift/A-B monitoring hook in here later ([08 §MLOps lifecycle](../../docs/architecture/08-AI-ML-PLATFORM.md)).

## References

[08-AI-ML-PLATFORM](../../docs/architecture/08-AI-ML-PLATFORM.md) ·
[18-DATA-ARCHITECTURE](../../docs/architecture/18-DATA-ARCHITECTURE.md) ·
[ADR-0002](../../docs/adr/ADR-0002-model-agnostic-inference.md) ·
[DEPENDENCIES](../../docs/project/DEPENDENCIES.md).
