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
    # Event sink: "null" (default, dependency-free) or "nats" (publish detections to the backbone).
    event_sink: str
    # NATS backbone URL — only used by the "nats" event sink.
    nats_url: str
    # --- live ingestion + multi-camera sessions (AI-5b) ---------------------------
    # Concurrent live sessions this runtime will run. A fixed-size box protects the sessions it is
    # already running by REFUSING new ones (409) rather than degrading all of them.
    max_sessions: int
    # Bounded frame queue per session (backpressure boundary) + what to discard when it overflows.
    stream_queue_size: int
    stream_drop_policy: str
    # Perception frame rate requested per live source (sampling target; NOT the camera's rate).
    stream_target_fps: float
    # Reconnect budget/backoff for a dropped source (bounded exponential, deterministic).
    reconnect_max_attempts: int
    reconnect_base_ms: float
    reconnect_max_ms: float
    # --- deployment profile (AI-5c) ------------------------------------------------
    # Operational defaults as configuration (retail/warehouse/office/school/hospital/factory/parking).
    # Empty = use the env settings above directly (no profile).
    deployment_profile: str


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
    "INFERENCE_EVENT_SINK": "null",
    "NATS_URL": "nats://localhost:44222",
    # AI-5b live ingestion — production-safe defaults; none change perception behavior.
    "INFERENCE_MAX_SESSIONS": "8",
    "INFERENCE_STREAM_QUEUE_SIZE": "32",
    "INFERENCE_STREAM_DROP_POLICY": "drop-oldest",
    "INFERENCE_STREAM_TARGET_FPS": "5",
    "INFERENCE_RECONNECT_MAX_ATTEMPTS": "10",
    "INFERENCE_RECONNECT_BASE_MS": "500",
    "INFERENCE_RECONNECT_MAX_MS": "30000",
    "INFERENCE_DEPLOYMENT_PROFILE": "",
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

    event_sink = value("INFERENCE_EVENT_SINK")
    if event_sink not in ("null", "nats"):
        raise ValueError(f"INFERENCE_EVENT_SINK must be 'null' or 'nats', got '{event_sink}'")

    # --- AI-5b live-ingestion settings (fail fast: a bad limit is a misconfiguration, and a runtime
    # that starts with a nonsensical queue size fails later, in production, where it costs more) ---
    max_sessions = _positive_int(value("INFERENCE_MAX_SESSIONS"), "INFERENCE_MAX_SESSIONS")
    stream_queue_size = _positive_int(value("INFERENCE_STREAM_QUEUE_SIZE"), "INFERENCE_STREAM_QUEUE_SIZE")
    reconnect_max_attempts = _nonnegative_int(
        value("INFERENCE_RECONNECT_MAX_ATTEMPTS"), "INFERENCE_RECONNECT_MAX_ATTEMPTS"
    )
    stream_target_fps = _positive_float(value("INFERENCE_STREAM_TARGET_FPS"), "INFERENCE_STREAM_TARGET_FPS")
    reconnect_base_ms = _positive_float(value("INFERENCE_RECONNECT_BASE_MS"), "INFERENCE_RECONNECT_BASE_MS")
    reconnect_max_ms = _positive_float(value("INFERENCE_RECONNECT_MAX_MS"), "INFERENCE_RECONNECT_MAX_MS")
    if reconnect_max_ms < reconnect_base_ms:
        raise ValueError("INFERENCE_RECONNECT_MAX_MS must be >= INFERENCE_RECONNECT_BASE_MS")

    drop_policy = value("INFERENCE_STREAM_DROP_POLICY")
    if drop_policy not in ("drop-oldest", "drop-newest"):
        raise ValueError(
            f"INFERENCE_STREAM_DROP_POLICY must be 'drop-oldest' or 'drop-newest', got '{drop_policy}'"
        )

    return InferenceConfig(
        host=value("HOST"),
        port=int(value("PORT")),
        log_level=value("LOG_LEVEL"),
        internal_api_key=internal_api_key,
        backend=backend,
        manifests_dir=value("INFERENCE_MANIFESTS_DIR"),
        mlflow_tracking_uri=value("MLFLOW_TRACKING_URI"),
        s3_endpoint_url=value("MLFLOW_S3_ENDPOINT_URL"),
        event_sink=event_sink,
        nats_url=value("NATS_URL"),
        max_sessions=max_sessions,
        stream_queue_size=stream_queue_size,
        stream_drop_policy=drop_policy,
        stream_target_fps=stream_target_fps,
        reconnect_max_attempts=reconnect_max_attempts,
        reconnect_base_ms=reconnect_base_ms,
        reconnect_max_ms=reconnect_max_ms,
        deployment_profile=value("INFERENCE_DEPLOYMENT_PROFILE").strip(),
    )


def _positive_int(raw: str, key: str) -> int:
    parsed = _int(raw, key)
    if parsed < 1:
        raise ValueError(f"config {key} must be >= 1, got {parsed}")
    return parsed


def _nonnegative_int(raw: str, key: str) -> int:
    parsed = _int(raw, key)
    if parsed < 0:
        raise ValueError(f"config {key} must be >= 0, got {parsed}")
    return parsed


def _int(raw: str, key: str) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise ValueError(f"config {key} must be an integer, got '{raw}'") from None


def _positive_float(raw: str, key: str) -> float:
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"config {key} must be a number, got '{raw}'") from None
    if parsed <= 0:
        raise ValueError(f"config {key} must be > 0, got {parsed}")
    return parsed
