"""Integration smoke test for the MLflow registry wiring.

Proves the full path end-to-end: tracking server reachable → experiment/run logged
to the **Postgres backend store** → a small artifact stored in **MinIO (S3)** → a
model version **registered** and read back from the Model Registry.

This is an INTEGRATION check — it needs the dev stack running and the deps installed.
It is intentionally NOT part of the stdlib unit tests (which run in CI without deps).

Usage:
    pnpm dev:stack                          # bring up MinIO/Postgres/MLflow
    pip install -r ai/mlops/requirements.txt
    set -a && source .env && set +a         # export MLFLOW_TRACKING_URI etc.
    python ai/mlops/verify_registry.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from config import load_config


def main() -> int:
    import mlflow  # imported lazily so the module loads without the dep present
    from mlflow.tracking import MlflowClient

    cfg = load_config()
    mlflow.set_tracking_uri(cfg.tracking_uri)
    print(f"tracking: {cfg.tracking_uri} · artifacts: {cfg.artifacts_uri}")

    experiment = "vip-registry-smoke"
    mlflow.set_experiment(experiment)

    with mlflow.start_run(run_name="bootstrap-verify") as run:
        mlflow.log_param("bootstrap", "P0-5")
        mlflow.log_metric("ok", 1.0)
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "registry-verified.txt"
            marker.write_text("VIP MLflow registry wiring verified.\n", encoding="utf8")
            mlflow.log_artifact(str(marker))
        run_id = run.info.run_id

    # Register a dummy model version to exercise the Model Registry tables.
    client = MlflowClient()
    model_name = "vip-smoke-model"
    try:
        client.create_registered_model(model_name)
    except Exception:
        pass  # already exists on a re-run
    version = client.create_model_version(
        name=model_name, source=f"runs:/{run_id}/registry-verified.txt", run_id=run_id
    )

    read_back = client.get_model_version(model_name, version.version)
    assert read_back.run_id == run_id, "registry read-back mismatch"

    print(f"OK: run {run_id} logged; model {model_name} v{version.version} registered + read back.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as err:  # noqa: BLE001 — smoke script: surface any failure clearly
        print(f"FAILED: {err}", file=sys.stderr)
        sys.exit(1)
