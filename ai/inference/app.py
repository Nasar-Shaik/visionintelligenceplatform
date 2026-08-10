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
from pipeline import EventSink, ModelAdapter, NoopTracker, NullEventSink
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
                warmup=config.onnx_warmup,
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


def _build_tracker(config: InferenceConfig):
    """The live tracking stage (P-8 Phase 4), or the no-op when tracking is switched off.

    ⚠️ Built here rather than inside the registry so the composition root stays the only place that
    reads configuration — and so `INFERENCE_TRACKING_ENABLED=0` produces a runtime with genuinely no
    tracking, rather than one holding a disabled tracker that still allocates per-camera state.
    """
    if not config.tracking_enabled:
        return NoopTracker()
    from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: WPS433 - keeps imports lean

    recorder = _build_track_history(config)
    tracker = RuntimeTracker(
        TrackingOptions(
            enabled=True,
            min_iou=config.tracking_min_iou,
            min_iou_lost=config.tracking_min_iou_lost,
            min_hits=config.tracking_min_hits,
            max_age=config.tracking_max_age,
            history_max=config.tracking_history_max,
            reentry_gap_seconds=config.tracking_reentry_seconds,
            reentry_distance=config.tracking_reentry_distance,
        ),
        history=recorder,
    )
    if recorder is None or not config.behaviour_enabled:
        return tracker

    # ⭐ Two stages in the ONE slot the pipeline already has (P-11 slice 2.2). `StageChain` is itself
    # `Tracker`-shaped, so `CapabilityRuntime` still sees exactly one tracker and the frozen runtime
    # architecture gains no layer. Order is not a preference: behaviour reads the identity tracking
    # assigns, so it must run second.
    from behaviour_stage import BehaviourStage  # noqa: WPS433 - keeps imports lean
    from pipeline import StageChain  # noqa: WPS433

    modules = [m.strip() for m in config.behaviour_modules.split(",") if m.strip()] or None
    return StageChain(tracker, BehaviourStage(recorder=recorder, modules=modules))


def _build_track_history(config: InferenceConfig):
    """The durable track-history recorder (ADR-0051), or `None` when this deployment keeps none.

    ⛔ **`None` when neither behaviour nor a storage directory is configured**, and that is the point
    of the branch: a runtime that keeps nobody's movement path should hold no structure that could
    start. When behaviour is on but no directory is set, history exists in memory for the primitives
    and is never written — `stats()["store"]["durable"]` reads `False` so an operator can see which
    of the two they have.
    """
    from track_history import (  # noqa: WPS433 - keeps imports lean
        JsonlTrackHistoryStore,
        NullTrackHistoryStore,
        RetentionPolicy,
        TrackHistoryRecorder,
    )

    if not config.behaviour_enabled and not config.track_history_dir:
        return None
    policy = RetentionPolicy(
        max_age_hours=config.track_history_retention_hours,
        max_points=config.track_history_max_points,
    )
    store = (
        JsonlTrackHistoryStore(config.track_history_dir, policy)
        if config.track_history_dir
        else NullTrackHistoryStore()
    )
    if config.track_history_dir:
        # ⚠️ On start, not on a timer. A runtime that has been down for a week must not serve records
        # that outlived their retention while it was off, and a purge thread would be a second clock
        # to reason about for a job that costs milliseconds at boot.
        store.purge()
    return TrackHistoryRecorder(store=store, max_points=config.track_history_max_points)


def build_registry(config: InferenceConfig):
    """Build the capability registry, and the model catalogue it resolved against (or `None` when
    the backend does not use one). The catalogue is returned so `/runtime` can report **what is
    registered** beside what is loaded — an operator needs both to explain a selection."""
    registry = CapabilityRegistry(
        _RUNTIME_VERSION,
        event_sink=_build_event_sink(config),
        tracker=_build_tracker(config),
    )
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
    # ⚠️ `_stage` too: the shutdown flush must reach the recorder the same way every reader does —
    # by the distinctive attribute, never by position in the chain (P-11 slice 2.2).
    from server import _stage, runtime_snapshot  # noqa: WPS433 - after build_server, same module

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

        # ⛔ **Then flush evidence, and this line is the Evidence Integrity milestone.**
        #
        # Measured on the deployed stack before it was written: `docker restart` destroyed three
        # live identities and the durable record count did not move by one, with `write_failures`
        # still at zero — nothing had been attempted. The behaviour read collapsed from
        # `{carried: 3, picked: 3, observed: 5}` to `{observed: 2}` and said nothing about a loss.
        #
        # ⚠️ **Ordered after `supervisor.shutdown()` deliberately.** Sessions are stopped first so no
        # frame arrives *during* the flush and re-opens an identity that has just been closed; the
        # 20-second `stop_grace_period` this container has always had is more than enough for both.
        #
        # ⚠️ It never raises. A runtime that refused to stop because a disk was full would turn an
        # evidence problem into an availability one — the failure is counted, logged, and the
        # process still exits (`drain_pending` contains it, and `retire_all` reports the count).
        flushed = 0
        try:
            tracker = _stage(registry, "history")
            recorder = getattr(tracker, "history", None)
            if recorder is not None:
                flushed = recorder.retire_all()
        except Exception as exc:  # noqa: BLE001 - shutdown must complete
            obslog.error("evidence flush failed at shutdown", error=str(exc)[:200])

        httpd.shutdown()
        obslog.info("shutdown complete", identitiesFlushed=flushed)

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
