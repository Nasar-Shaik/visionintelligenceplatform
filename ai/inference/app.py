"""Bootstrap / composition root: load config, wire the model resolver + backend adapter for the
configured backend (`stub` = dependency-free default; `onnx` = real onnxruntime + MLflow registry),
discover + initialize capabilities from MANIFESTS via the registry (zero-code registration), and
serve. Graceful shutdown on SIGTERM/SIGINT.

The heavy `onnx` backend is imported LAZILY, so the default/dev path and the unit tests never load
onnxruntime/mlflow/numpy/pillow. Run: `python -m app` (from ai/inference) or `python ai/inference/app.py`.
"""

from __future__ import annotations

import signal
import sys

from config import InferenceConfig, load_config
from manifest import CapabilityManifest
from pipeline import EventSink, ModelAdapter, NullEventSink
from registry import CapabilityRegistry
from resolver import FakeModelResolver, ModelResolver

_RUNTIME_VERSION = "0.1.0"


def _build_event_sink(config: InferenceConfig) -> EventSink:
    """Pick the event sink for the configured backbone wiring. `null` is dependency-free (default);
    `nats` lazily imports nats-py (integration-only) and publishes detections onto the backbone."""
    if config.event_sink == "nats":
        from adapters.nats_sink import NatsEventSink  # noqa: WPS433 - HEAVY, integration-only

        return NatsEventSink(config.nats_url)
    return NullEventSink()


def _factories(config: InferenceConfig):
    """Return (resolver_factory, adapter_factory) for the configured backend."""
    if config.backend == "onnx":
        # Lazy import — only the real backend needs onnxruntime/mlflow/numpy/pillow.
        from adapters.mlflow_resolver import MlflowModelResolver  # noqa: WPS433
        from adapters.onnx_adapter import OnnxModelAdapter  # noqa: WPS433

        def resolver_factory(_m: CapabilityManifest) -> ModelResolver:
            return MlflowModelResolver(config.mlflow_tracking_uri, config.s3_endpoint_url)

        def adapter_factory(_m: CapabilityManifest) -> ModelAdapter:
            return OnnxModelAdapter()

        return resolver_factory, adapter_factory

    from adapters.fake_adapter import FakeModelAdapter  # noqa: WPS433

    def resolver_factory(_m: CapabilityManifest) -> ModelResolver:
        return FakeModelResolver()

    def adapter_factory(_m: CapabilityManifest) -> ModelAdapter:
        return FakeModelAdapter()

    return resolver_factory, adapter_factory


def build_registry(config: InferenceConfig) -> CapabilityRegistry:
    registry = CapabilityRegistry(_RUNTIME_VERSION, event_sink=_build_event_sink(config))
    resolver_factory, adapter_factory = _factories(config)
    registry.load_from_dir(config.manifests_dir, resolver_factory, adapter_factory)
    return registry


def main() -> None:
    config = load_config()
    registry = build_registry(config)  # initializes enabled capabilities (binds models by selector)

    # Control plane (P2-2 G-3): the managed model registry + inference-session manager. In-memory for
    # now (deterministic + persistence is a later concern); wired into the same HTTP surface.
    from model_registry import ModelRegistry  # noqa: WPS433
    from sessions import SessionManager  # noqa: WPS433

    model_registry = ModelRegistry()
    sessions = SessionManager()

    # Live ingestion + multi-camera sessions (AI-5b). The supervisor gives the G-3 control plane a
    # data plane: each live session runs its pump on its own thread, bounded by INFERENCE_MAX_SESSIONS.
    from session_runner import SessionSupervisor, ThreadExecutor  # noqa: WPS433

    # AI-5c: scheduling + resource management. A deployment profile (INFERENCE_DEPLOYMENT_PROFILE)
    # supplies operational defaults as CONFIG, so retail/warehouse/hospital differ without code.
    from compute import ResourceMonitor, detect_resources  # noqa: WPS433
    from resources import ResourceAccountant  # noqa: WPS433
    from scheduler import InferenceScheduler  # noqa: WPS433

    deployment = None
    if config.deployment_profile:
        from deployment import load_profile  # noqa: WPS433

        deployment = load_profile(config.deployment_profile)

    compute = detect_resources()
    scheduler = InferenceScheduler(
        compute,
        ResourceAccountant(),
        policy=deployment.scheduler if deployment is not None else None,
        max_sessions=deployment.max_sessions if deployment is not None else config.max_sessions,
        analyzer_costs=deployment.analyzer_costs if deployment is not None else None,
        protected_analyzers=deployment.protected_analyzers if deployment is not None else None,
    )
    supervisor = SessionSupervisor(
        sessions,
        max_sessions=deployment.max_sessions if deployment is not None else config.max_sessions,
        executor_factory=ThreadExecutor,
        scheduler=scheduler,
        monitor=ResourceMonitor(),
        deployment=deployment,
    )

    from server import build_server  # noqa: WPS433 - after registry so /ready is meaningful

    httpd = build_server(
        config.host,
        config.port,
        registry,
        config.internal_api_key,
        "inference",
        _RUNTIME_VERSION,
        model_registry=model_registry,
        sessions=sessions,
        supervisor=supervisor,
        live_defaults={
            "queue_size": config.stream_queue_size,
            "drop_policy": config.stream_drop_policy,
            "target_fps": config.stream_target_fps,
            "reconnect_max_attempts": config.reconnect_max_attempts,
            "reconnect_base_ms": config.reconnect_base_ms,
            "reconnect_max_ms": config.reconnect_max_ms,
            "backend": config.backend,
        },
    )

    def shutdown(_signum, _frame) -> None:  # noqa: ANN001
        # Stop every live session first so no thread, queue or source outlives the process
        # (AI-5b refinement 8) — then stop accepting requests.
        supervisor.shutdown()
        httpd.shutdown()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, shutdown)

    print(
        f"inference runtime {_RUNTIME_VERSION} ({config.backend}) listening on "
        f"{config.host}:{config.port} — capabilities: {[d['id'] for d in registry.descriptors()]}",
        file=sys.stderr,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
