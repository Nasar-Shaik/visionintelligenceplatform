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
    # --- model resolution (P-8 Phase 3) --------------------------------------------
    # Where the `onnx` backend finds its models: "local" (the checksummed catalogue baked into the
    # image — the production default) or "mlflow" (the authoring registry; a dev-stack dependency).
    #
    # ⚠️ The default is deliberately NOT mlflow. A production container whose model set is decided by
    # a tracking server it must reach at boot has a dev service on its critical path, and the model it
    # runs stops being a property of the image.
    model_source: str
    # Catalogue document + the artifact directory it describes.
    model_catalogue: str
    model_dir: str
    # Optional operator override: run this registered model id instead of the catalogue's default.
    # Unknown ids are REFUSED, never silently ignored.
    active_model: str
    # Execution providers offered to onnxruntime, best first. The session reports what it got.
    onnx_providers: str
    # onnxruntime thread pools. 0 = derive intra-op from the cgroup CPU quota (see compute.py).
    onnx_intra_threads: int
    onnx_inter_threads: int
    # Run one inference over a blank tensor at load, so the first real frame is not an outlier.
    # ⚠️ Exists as a switch only so the improvement can be MEASURED (P-8 Phase 3H). Production keeps
    # it on; turning it off is how the deployment verification proves it is worth having.
    onnx_warmup: bool
    # Model Registry (MLflow) — only used when model_source is "mlflow".
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
    # --- observability (P-8 Phase 2, TD-60) ----------------------------------------
    # Seconds between runtime heartbeat log lines. Its absence is the signal that the runtime stopped.
    heartbeat_seconds: float
    # --- object tracking (P-8 Phase 4) ---------------------------------------------
    # ⚠️ ON by default, and that is a deliberate reversal of the usual "new subsystem ships off".
    # The switch exists so the deployment verification can prove tracking is what produces track ids
    # — turning it off must make them disappear — and a feature that is off in production is a
    # feature nobody has verified in production. See docs/review/p8/tracking-mutations.mjs.
    tracking_enabled: bool
    # Association floor for a track seen on the previous frame.
    tracking_min_iou: float
    # Stricter floor for a track being re-matched across a gap: a coasting prediction is a guess,
    # and a guess must clear a higher bar before it is allowed to claim an identity.
    tracking_min_iou_lost: float
    # Detections before an identity is trusted (`confirmed`).
    tracking_min_hits: int
    # Frames a track may coast unseen before it is removed. ⚠️ In FRAMES, not seconds: at the
    # deployment's 2 fps, 8 frames is about 4 seconds.
    tracking_max_age: int
    # Trajectory points retained per track (bounded — a week-long session costs the same as a minute).
    tracking_history_max: int
    # How long a departed identity stays eligible to be re-entered, and how far away it may reappear.
    tracking_reentry_seconds: float
    tracking_reentry_distance: float
    # --- behaviour primitives + durable track history (P-11 slice 2.2) -------------
    # ⚠️ ON by default, for the same reason tracking is: a stage that is off in production is a stage
    # nobody has verified in production. It adds no model and no inference — it reads the track
    # history the tracker already keeps.
    behaviour_enabled: bool
    # Comma-separated module names, in execution order. Empty = every registered default.
    behaviour_modules: str
    # Where retired identities are persisted. ⛔ EMPTY BY DEFAULT, and that is deliberate: a movement
    # path is personal data, and a deployment gets one because an operator configured a location for
    # it — never because a module was imported. Empty means history is held in memory only.
    track_history_dir: str
    # How long a stored path is kept, in hours of WALL-CLOCK time since it was written. ⚠️ Not
    # footage time: purging by footage time would erase an archive analysis the instant it was
    # written and keep tomorrow's live footage for ever.
    track_history_retention_hours: float
    # Points retained per identity, and identities retained per stream. Bounded like everything else.
    track_history_max_points: int
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
    "INFERENCE_MODEL_SOURCE": "local",
    "INFERENCE_MODEL_CATALOGUE": os.path.join(_HERE, "models", "registry.json"),
    "INFERENCE_MODEL_DIR": "/opt/vip/models",
    "INFERENCE_ACTIVE_MODEL": "",
    "INFERENCE_ONNX_PROVIDERS": "CPUExecutionProvider",
    "INFERENCE_ONNX_INTRA_THREADS": "0",
    "INFERENCE_ONNX_INTER_THREADS": "1",
    "INFERENCE_ONNX_WARMUP": "1",
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
    "INFERENCE_TRACKING_ENABLED": "1",
    "INFERENCE_TRACKING_MIN_IOU": "0.3",
    "INFERENCE_TRACKING_MIN_IOU_LOST": "0.45",
    "INFERENCE_TRACKING_MIN_HITS": "2",
    "INFERENCE_TRACKING_MAX_AGE": "8",
    "INFERENCE_TRACKING_HISTORY_MAX": "50",
    "INFERENCE_TRACKING_REENTRY_SECONDS": "12",
    "INFERENCE_TRACKING_REENTRY_DISTANCE": "0.35",
    "INFERENCE_BEHAVIOUR_ENABLED": "1",
    "INFERENCE_BEHAVIOUR_MODULES": "",
    "INFERENCE_TRACK_HISTORY_DIR": "",
    "INFERENCE_TRACK_HISTORY_RETENTION_HOURS": "72",
    "INFERENCE_TRACK_HISTORY_MAX_POINTS": "512",
    "INFERENCE_DEPLOYMENT_PROFILE": "",
    "INFERENCE_HEARTBEAT_SECONDS": "30",
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

    model_source = value("INFERENCE_MODEL_SOURCE")
    if model_source not in ("local", "mlflow"):
        raise ValueError(f"INFERENCE_MODEL_SOURCE must be 'local' or 'mlflow', got '{model_source}'")

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
        model_source=model_source,
        model_catalogue=value("INFERENCE_MODEL_CATALOGUE"),
        model_dir=value("INFERENCE_MODEL_DIR"),
        active_model=value("INFERENCE_ACTIVE_MODEL").strip(),
        onnx_providers=value("INFERENCE_ONNX_PROVIDERS"),
        onnx_intra_threads=_nonnegative_int(
            value("INFERENCE_ONNX_INTRA_THREADS"), "INFERENCE_ONNX_INTRA_THREADS"
        ),
        onnx_inter_threads=_nonnegative_int(
            value("INFERENCE_ONNX_INTER_THREADS"), "INFERENCE_ONNX_INTER_THREADS"
        ),
        onnx_warmup=_flag(value("INFERENCE_ONNX_WARMUP"), "INFERENCE_ONNX_WARMUP"),
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
        heartbeat_seconds=_positive_float(
            value("INFERENCE_HEARTBEAT_SECONDS"), "INFERENCE_HEARTBEAT_SECONDS"
        ),
        deployment_profile=value("INFERENCE_DEPLOYMENT_PROFILE").strip(),
        tracking_enabled=_flag(value("INFERENCE_TRACKING_ENABLED"), "INFERENCE_TRACKING_ENABLED"),
        tracking_min_iou=_unit_interval(value("INFERENCE_TRACKING_MIN_IOU"), "INFERENCE_TRACKING_MIN_IOU"),
        tracking_min_iou_lost=_unit_interval(
            value("INFERENCE_TRACKING_MIN_IOU_LOST"), "INFERENCE_TRACKING_MIN_IOU_LOST"
        ),
        tracking_min_hits=_positive_int(value("INFERENCE_TRACKING_MIN_HITS"), "INFERENCE_TRACKING_MIN_HITS"),
        tracking_max_age=_positive_int(value("INFERENCE_TRACKING_MAX_AGE"), "INFERENCE_TRACKING_MAX_AGE"),
        tracking_history_max=_positive_int(
            value("INFERENCE_TRACKING_HISTORY_MAX"), "INFERENCE_TRACKING_HISTORY_MAX"
        ),
        tracking_reentry_seconds=_positive_float(
            value("INFERENCE_TRACKING_REENTRY_SECONDS"), "INFERENCE_TRACKING_REENTRY_SECONDS"
        ),
        tracking_reentry_distance=_unit_interval(
            value("INFERENCE_TRACKING_REENTRY_DISTANCE"), "INFERENCE_TRACKING_REENTRY_DISTANCE"
        ),
        behaviour_enabled=_flag(value("INFERENCE_BEHAVIOUR_ENABLED"), "INFERENCE_BEHAVIOUR_ENABLED"),
        behaviour_modules=value("INFERENCE_BEHAVIOUR_MODULES").strip(),
        track_history_dir=value("INFERENCE_TRACK_HISTORY_DIR").strip(),
        track_history_retention_hours=_positive_float(
            value("INFERENCE_TRACK_HISTORY_RETENTION_HOURS"), "INFERENCE_TRACK_HISTORY_RETENTION_HOURS"
        ),
        track_history_max_points=_positive_int(
            value("INFERENCE_TRACK_HISTORY_MAX_POINTS"), "INFERENCE_TRACK_HISTORY_MAX_POINTS"
        ),
    )


def _unit_interval(raw: str, name: str) -> float:
    """A ratio in [0, 1]. ⚠️ Refused rather than clamped: an IoU floor of 1.5 is a typo whose effect
    is that nothing ever associates, and silently clamping it to 1.0 produces the same broken
    tracking with no way to tell why."""
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a number between 0 and 1, got '{raw}'") from None
    if not 0.0 <= parsed <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {parsed}")
    return parsed


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


def _flag(raw: str, key: str) -> bool:
    """A boolean from the environment. ⚠️ An unrecognised value is a MISCONFIGURATION, not a false:
    `INFERENCE_ONNX_WARMUP=yes` silently meaning "off" is how a performance regression gets shipped."""
    normalized = raw.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"config {key} must be a boolean (1/0, true/false, yes/no, on/off), got '{raw}'")


def _positive_float(raw: str, key: str) -> float:
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"config {key} must be a number, got '{raw}'") from None
    if parsed <= 0:
        raise ValueError(f"config {key} must be > 0, got {parsed}")
    return parsed
