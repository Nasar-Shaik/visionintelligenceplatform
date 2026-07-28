"""Typed configuration for the inference runtime.

Reads the environment (12-factor) into a frozen dataclass. Deliberately **stdlib-only** so it is
importable/unit-testable without onnxruntime/mlflow (those are only needed for the `onnx` backend).
`.env` is the only secrets source (ADR-0018). The capability set + model selectors come from
MANIFESTS (manifest.py), not env — this config carries only runtime/transport/backend wiring.
Mirrors the ai/mlops config style.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping, Optional


@dataclass(frozen=True)
class InferenceConfig:
    host: str
    port: int
    log_level: str
    # Service-to-service auth (the pipeline calls /infer with this key; ADR-0018).
    internal_api_key: str
    # Detector backend: "stub" (deterministic, dependency-free) or "onnx" (real onnxruntime + MLflow).
    backend: str
    # Directory of capability manifests to load (zero-code registration).
    manifests_dir: str
    # Model Registry (MLflow) — only used by the "onnx" backend.
    mlflow_tracking_uri: str
    s3_endpoint_url: str


_HERE = os.path.dirname(os.path.abspath(__file__))

_DEFAULTS: Mapping[str, str] = {
    "HOST": "0.0.0.0",
    "PORT": "8085",
    "LOG_LEVEL": "info",
    # Shared internal key — mirrors .env.example (dev value); MUST be overridden in prod.
    "INTERNAL_API_KEY": "change_me_dev_only_min_16_chars",
    "INFERENCE_BACKEND": "stub",
    "INFERENCE_MANIFESTS_DIR": os.path.join(_HERE, "manifests"),
    "MLFLOW_TRACKING_URI": "http://localhost:45000",
    "MLFLOW_S3_ENDPOINT_URL": "http://localhost:49000",
}

_REQUIRED_NONBLANK = ("INTERNAL_API_KEY", "INFERENCE_MANIFESTS_DIR")


def load_config(env: Optional[Mapping[str, str]] = None) -> InferenceConfig:
    """Build an InferenceConfig from an environment mapping (defaults to os.environ).

    A key present but blank is a misconfiguration (ValueError). `INTERNAL_API_KEY` must be >= 16
    chars; `INFERENCE_BACKEND` must be 'stub' or 'onnx'.
    """
    source = os.environ if env is None else env

    def value(key: str) -> str:
        raw = source.get(key, _DEFAULTS[key])
        if raw is None or (raw == "" and key in _REQUIRED_NONBLANK):
            raise ValueError(f"config {key} is present but empty")
        return raw

    internal_api_key = value("INTERNAL_API_KEY")
    if len(internal_api_key) < 16:
        raise ValueError("INTERNAL_API_KEY must be at least 16 characters")

    backend = value("INFERENCE_BACKEND")
    if backend not in ("stub", "onnx"):
        raise ValueError(f"INFERENCE_BACKEND must be 'stub' or 'onnx', got '{backend}'")

    return InferenceConfig(
        host=value("HOST"),
        port=int(value("PORT")),
        log_level=value("LOG_LEVEL"),
        internal_api_key=internal_api_key,
        backend=backend,
        manifests_dir=value("INFERENCE_MANIFESTS_DIR"),
        mlflow_tracking_uri=value("MLFLOW_TRACKING_URI"),
        s3_endpoint_url=value("MLFLOW_S3_ENDPOINT_URL"),
    )
