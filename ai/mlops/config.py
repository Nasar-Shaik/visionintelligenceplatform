"""Typed configuration for MLOps registry integration.

Reads the environment (12-factor) into a frozen dataclass. Deliberately
**stdlib-only** so it is importable and unit-testable without MLflow / DVC / boto3
installed (the heavy deps are only needed to actually talk to the registry).

Architecture: docs/architecture/08-AI-ML-PLATFORM.md (Model + Dataset Registry).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


@dataclass(frozen=True)
class RegistryConfig:
    """Resolved endpoints/buckets for the Model Registry (MLflow) and Dataset Registry (DVC)."""

    tracking_uri: str
    s3_endpoint_url: str
    artifacts_bucket: str
    datasets_bucket: str
    aws_access_key_id: str
    aws_secret_access_key: str

    @property
    def artifacts_uri(self) -> str:
        """S3 URI for MLflow model/experiment artifacts."""
        return f"s3://{self.artifacts_bucket}"

    @property
    def datasets_remote_uri(self) -> str:
        """S3 URI for the DVC dataset remote."""
        return f"s3://{self.datasets_bucket}"


# Defaults mirror .env.example / docker-compose.dev.yml (host-side dev values).
_DEFAULTS = {
    "MLFLOW_TRACKING_URI": "http://localhost:45000",
    "MLFLOW_S3_ENDPOINT_URL": "http://localhost:49000",
    "MLFLOW_ARTIFACTS_BUCKET": "mlflow-artifacts",
    "DVC_REMOTE_BUCKET": "vip-datasets",
    "AWS_ACCESS_KEY_ID": "vip_dev",
    "AWS_SECRET_ACCESS_KEY": "change_me_dev_only",
}


def load_config(env: Optional[Mapping[str, str]] = None) -> RegistryConfig:
    """Build a RegistryConfig from an environment mapping (defaults to os.environ).

    Raises ValueError if a key is present but blank — an explicitly empty value is a
    misconfiguration, not an intent to use the default.
    """
    source = os.environ if env is None else env

    def value(key: str) -> str:
        raw = source.get(key, _DEFAULTS[key])
        if raw is None or raw == "":
            raise ValueError(f"config {key} is present but empty")
        return raw

    return RegistryConfig(
        tracking_uri=value("MLFLOW_TRACKING_URI"),
        s3_endpoint_url=value("MLFLOW_S3_ENDPOINT_URL"),
        artifacts_bucket=value("MLFLOW_ARTIFACTS_BUCKET"),
        datasets_bucket=value("DVC_REMOTE_BUCKET"),
        aws_access_key_id=value("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=value("AWS_SECRET_ACCESS_KEY"),
    )
