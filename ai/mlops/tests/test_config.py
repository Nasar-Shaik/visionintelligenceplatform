"""Unit tests for the MLOps registry config loader. Stdlib-only (unittest) so they
run in CI without installing MLflow/DVC. Run:
    python -m unittest discover -s ai/mlops/tests
"""

import os
import sys
import unittest

# Make ai/mlops importable regardless of the invoking cwd.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config import load_config  # noqa: E402


class LoadConfigTests(unittest.TestCase):
    def test_defaults_when_env_empty(self) -> None:
        cfg = load_config({})
        self.assertEqual(cfg.tracking_uri, "http://localhost:45000")
        self.assertEqual(cfg.artifacts_bucket, "mlflow-artifacts")
        self.assertEqual(cfg.datasets_bucket, "vip-datasets")

    def test_env_overrides(self) -> None:
        cfg = load_config(
            {
                "MLFLOW_TRACKING_URI": "http://mlflow:5000",
                "MLFLOW_ARTIFACTS_BUCKET": "custom-artifacts",
                "DVC_REMOTE_BUCKET": "custom-datasets",
            }
        )
        self.assertEqual(cfg.tracking_uri, "http://mlflow:5000")
        self.assertEqual(cfg.artifacts_bucket, "custom-artifacts")
        self.assertEqual(cfg.datasets_bucket, "custom-datasets")

    def test_derived_uris(self) -> None:
        cfg = load_config({})
        self.assertEqual(cfg.artifacts_uri, "s3://mlflow-artifacts")
        self.assertEqual(cfg.datasets_remote_uri, "s3://vip-datasets")

    def test_blank_value_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"MLFLOW_TRACKING_URI": ""})

    def test_config_is_immutable(self) -> None:
        cfg = load_config({})
        with self.assertRaises(Exception):
            cfg.tracking_uri = "mutated"  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
