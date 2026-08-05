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

import obslog

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
    """Return (resolver_factory, adapter_factory, model_store) for the configured backend.

    ⚠️ The store is returned rather than re-loaded by the caller: two `ModelStore` instances built
    from the same file are two answers to "what is registered", and they diverge the moment one is
    reloaded. One catalogue, one object, passed to whoever needs it.
    """
    if config.backend == "onnx":
        # Lazy import — only the real backend needs onnxruntime/numpy/pillow.
        from adapters.onnx_adapter import OnnxModelAdapter  # noqa: WPS433

        # ⚠️ Threads are derived from the **cgroup quota**, not `os.cpu_count()` (TD-61). Left to
        # itself onnxruntime sizes its pool from the host's core count, so a runtime limited to two
        # cores would spawn ten threads and spend its budget on contention.
        intra = config.onnx_intra_threads
        if intra == 0:
            from compute import available_cores  # noqa: WPS433

            intra = max(1, int(available_cores()))
        providers = [p.strip() for p in config.onnx_providers.split(",") if p.strip()]

        def adapter_factory(_m: CapabilityManifest) -> ModelAdapter:
            return OnnxModelAdapter(
                providers,
                intra_op_threads=intra,
                inter_op_threads=config.onnx_inter_threads,
            )

        if config.model_source == "mlflow":
            from adapters.mlflow_resolver import MlflowModelResolver  # noqa: WPS433

            def resolver_factory(_m: CapabilityManifest) -> ModelResolver:
                return MlflowModelResolver(config.mlflow_tracking_uri, config.s3_endpoint_url)

            return resolver_factory, adapter_factory, None

        # The production path: one checksummed catalogue inside the image, loaded once and shared.
        from model_store import LocalModelResolver, ModelStore  # noqa: WPS433

        store = ModelStore.load(config.model_catalogue, artifact_dir=config.model_dir)

        def resolver_factory(manifest: CapabilityManifest) -> ModelResolver:
            return LocalModelResolver(
                store,
                capability_id=manifest.capability_id,
                preferred_id=config.active_model or None,
            )

        return resolver_factory, adapter_factory, store

    from adapters.fake_adapter import FakeModelAdapter  # noqa: WPS433

    def resolver_factory(_m: CapabilityManifest) -> ModelResolver:
        return FakeModelResolver()

    def adapter_factory(_m: CapabilityManifest) -> ModelAdapter:
        return FakeModelAdapter()

    return resolver_factory, adapter_factory, None


def build_registry(config: InferenceConfig):
    """Build the capability registry, and the model catalogue it resolved against (or `None` when
    the backend does not use one). The catalogue is returned so `/runtime` can report **what is
    registered** beside what is loaded — an operator needs both to explain a selection."""
    registry = CapabilityRegistry(_RUNTIME_VERSION, event_sink=_build_event_sink(config))
    resolver_factory, adapter_factory, store = _factories(config)
    registry.load_from_dir(config.manifests_dir, resolver_factory, adapter_factory)
    return registry, store


def main() -> None:
    config = load_config()
    obslog.configure(config.log_level, service="inference")
    # Initializes enabled capabilities: resolves each selector to a registered model, verifies the
    # artifact's checksum, loads the session and warms it up. A failure here is a failed start.
    registry, model_store = build_registry(config)

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
        model_store=model_store,
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

    # ⚠️ A periodic state line. Its ABSENCE is the signal: an idle runtime and a wedged one produce
    # identical metrics, and only a heartbeat that stopped arriving tells them apart (TD-60).
    from server import runtime_snapshot  # noqa: WPS433 - after build_server, same module

    heartbeat = obslog.Heartbeat(
        config.heartbeat_seconds,
        lambda: runtime_snapshot(registry, supervisor),
    )

    def shutdown(_signum, _frame) -> None:  # noqa: ANN001
        # Stop every live session first so no thread, queue or source outlives the process
        # (AI-5b refinement 8) — then stop accepting requests.
        obslog.info("shutdown signal received, draining")
        heartbeat.stop()
        supervisor.shutdown()
        httpd.shutdown()
        obslog.info("shutdown complete")

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, shutdown)

    obslog.info(
        "inference runtime listening",
        version=_RUNTIME_VERSION,
        backend=config.backend,
        address=f"{config.host}:{config.port}",
        capabilities=[d["id"] for d in registry.descriptors()],
        eventSink=config.event_sink,
        modelSource=config.model_source if config.backend == "onnx" else None,
        modelsRegistered=None if model_store is None else [m.id for m in model_store.all()],
        modelsLoaded=[
            entry.get("model", {}).get("name")
            for entry in registry.health()
            if entry.get("model")
        ]
        or None,
        executionProviders=sorted(
            {entry.get("executionProvider") for entry in registry.health() if entry.get("executionProvider")}
        )
        or None,
        maxSessions=config.max_sessions,
        deploymentProfile=config.deployment_profile or None,
        computeUnits=[f"{r.id}:{r.capacity_units}" for r in compute.resources()]
        if hasattr(compute, "resources")
        else None,
    )
    # ⚠️ Kept for anyone tailing stderr from before P-8 Phase 2; the structured line above is the one
    # an aggregator reads.
    print(
        f"inference runtime {_RUNTIME_VERSION} ({config.backend}) listening on "
        f"{config.host}:{config.port} — capabilities: {[d['id'] for d in registry.descriptors()]}",
        file=sys.stderr,
    )
    heartbeat.start()
    httpd.serve_forever()


if __name__ == "__main__":
    main()
