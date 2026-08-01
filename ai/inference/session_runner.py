"""Session Runner + Supervisor (AI-5b) — multi-camera session management.

Before AI-5b the `SessionManager` (G-3) was a control plane with nothing behind it: a 7-state machine
and a `heartbeat()` endpoint that no running pipeline ever called. This module closes that gap — it
binds ONE session to ONE live pipeline, and supervises N of them across cameras and tenants.

**Ownership** (Architect AI-5b refinement 2 — no overlap between tiers):

    StreamSource     owns  connection · reconnect · frame acquisition
    StreamPipeline   owns  queue · frame lifecycle · drop policy
    VideoAnalyzer    owns  AI processing only
    SessionRunner    owns  orchestration only                          ← THIS MODULE

`SessionRunner` therefore does exactly five things — **read · execute · heartbeat · metrics ·
lifecycle** — and contains no tracking logic, no behavior logic, no business logic, and no camera
configuration. When you find yourself wanting to add any of those here, they belong one tier down.

**Logical identity** (refinement 1): a runner is identified by `(tenantId, cameraId, sessionId)` and
never by a thread id or process id. Threads are an implementation detail that changes on every
restart; the identity is what metrics, logs, diagnostics and events reference.

**Resource cleanup** (refinement 8): stop, restart and fail all converge on `_teardown()`, which
releases queue, source, thread, heartbeat and metrics state. A stopped session leaves nothing behind.

Deterministic: the executor and clock are injected, so unit tests run the whole lifecycle synchronously
with no threads and no sleeps. Threads are used only in production (`ThreadExecutor`).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from errors import (
    ConfigurationFailure,
    Conflict,
    ModelFailure,
    NotFound,
    failure_category,
    failure_code,
)
from operational_log import OperationalLog, SessionIdentity
from sessions import SessionManager
from stream_pipeline import PipelineOptions, StreamPipeline
from stream_source import ConnectionSupervisor, ReconnectPolicy, StreamSource, build_source
from video_analyzer import AnalyzeOptions, VideoAnalyzer

_DEFAULT_MAX_SESSIONS = 8


# --- execution seam (injected so tests never spawn a thread) --------------------------------------


class SynchronousExecutor:
    """Runs the pump inline — the deterministic default for tests and benchmarks."""

    def submit(self, fn: Callable[[], None], *, name: str) -> None:  # noqa: ARG002
        fn()

    def join(self, timeout: Optional[float] = None) -> None:  # noqa: ARG002
        return None


class ThreadExecutor:
    """Runs each session pump on its own daemon thread (production). The thread is an implementation
    detail: it is never part of the session's identity, and it is always joined on teardown."""

    def __init__(self) -> None:
        self._thread: Optional[threading.Thread] = None

    def submit(self, fn: Callable[[], None], *, name: str) -> None:
        thread = threading.Thread(target=fn, name=name, daemon=True)
        self._thread = thread
        thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        thread, self._thread = self._thread, None
        if thread is not None and thread.is_alive():
            thread.join(timeout)

    @property
    def alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()


@dataclass
class LiveSessionConfig:
    """Everything needed to run one live session. Camera configuration is passed IN — the runner never
    resolves, defaults, or interprets it (refinement 2)."""

    source: dict  # a StreamSourceConfig dict
    analyze: AnalyzeOptions
    pipeline: PipelineOptions = field(default_factory=PipelineOptions)
    reconnect: ReconnectPolicy = field(default_factory=ReconnectPolicy)
    max_frames: Optional[int] = None


class SessionRunner:
    """Binds one inference session to one live pipeline. Orchestration only.

    The runner reads frames from the source tier, hands them to the pipeline tier, keeps the session's
    heartbeat and metrics current, and honours the lifecycle (pause/resume/stop/restart/fail). It makes
    no perception decision of any kind.
    """

    def __init__(
        self,
        identity: SessionIdentity,
        manager: SessionManager,
        config: LiveSessionConfig,
        *,
        analyzer: VideoAnalyzer,
        source: Optional[StreamSource] = None,
        executor=None,  # noqa: ANN001 - SynchronousExecutor | ThreadExecutor
        clock: Callable[[], float] = time.monotonic,
        sleep: Optional[Callable[[float], None]] = None,
        log: Optional[OperationalLog] = None,
        on_result: Optional[Callable[[object], None]] = None,
        account=None,  # noqa: ANN001 - resources.SessionAccount (AI-5c; None = unscheduled)
        governor=None,  # noqa: ANN001 - scheduler.ResourceGovernor (AI-5c; None = no degradation)
    ) -> None:
        self.identity = identity
        # AI-5c: this session's OWN account + the shared governor that decides its rung. The account is
        # private to this runner; the governor is stateless w.r.t. sessions (it reads the account it is
        # given), so no mutable state is shared between sessions (refinement 7).
        self._account = account
        self._governor = governor
        self._manager = manager
        self._config = config
        self._log = log or OperationalLog(identity)
        self._executor = executor or SynchronousExecutor()
        self._clock = clock
        self._on_result = on_result
        self.restart_count = 0
        self._paused = False
        self._stopping = False
        self._finished = threading.Event()

        # Source tier — built from config; a bad config fails FAST as `configuration`, never retried.
        self._source = source if source is not None else build_source(config.source)
        self._supervisor = ConnectionSupervisor(
            self._source, policy=config.reconnect, clock=clock, sleep=sleep, log=self._log
        )
        # Pipeline tier — owns queue/lifecycle/drop policy.
        self._analyzer = analyzer
        self._pipeline = StreamPipeline(
            analyzer, options=config.pipeline, clock=clock, log=self._log
        )

    # --- lifecycle (read · execute · heartbeat · metrics · lifecycle) -------------

    def start(self) -> None:
        """Begin pumping. The session must already be `running` in the SessionManager (the control
        plane owns state transitions; the runner only reacts to them)."""
        self._log.emit(
            "session.started",
            source=self._supervisor.redacted_uri,
            queueCapacity=self._config.pipeline.queue_capacity,
        )
        self._executor.submit(self._pump, name=f"session-{self.identity.session_id}")

    def pause(self) -> None:
        """Stop consuming frames without tearing down the source (fast resume)."""
        self._paused = True
        self._log.emit("session.paused")

    def resume(self) -> None:
        self._paused = False
        self._log.emit("session.resumed")

    def stop(self, *, timeout: Optional[float] = 5.0) -> None:
        """Stop the session and release everything it owns. Idempotent."""
        self._stopping = True
        self._supervisor.stop()
        self._executor.join(timeout)
        self._teardown(reason="stopped")

    def restart(self) -> None:
        """Restart the pump after a stop/failure. The logical identity is UNCHANGED — only the
        underlying thread/source are new, which is precisely why identity must not encode them."""
        self.restart_count += 1
        self._log.emit("session.restarting", restartCount=self.restart_count)
        self._stopping = False
        self._paused = False
        self._finished.clear()
        # Fresh source + supervisor + pipeline; the analyzer (and its tracking/behavior state) is
        # deliberately rebuilt by the caller when a clean perception state is wanted.
        self._source = build_source(self._config.source)
        self._supervisor = ConnectionSupervisor(
            self._source, policy=self._config.reconnect, clock=self._clock, log=self._log
        )
        self._pipeline = StreamPipeline(
            self._analyzer, options=self._config.pipeline, clock=self._clock, log=self._log
        )
        self.start()

    @property
    def finished(self) -> bool:
        return self._finished.is_set()

    @property
    def paused(self) -> bool:
        return self._paused

    # --- the pump ----------------------------------------------------------------

    def _pump(self) -> None:
        """Read → execute → heartbeat → metrics, until stopped or the source is exhausted."""
        try:
            analyzed = self._pipeline.run(
                self._supervisor.frames(),
                on_result=self._handle_result,
                should_continue=self._should_continue,
            )
            self._log.emit("session.drained", framesAnalyzed=analyzed)
            # Close out behaviors still active when the stream ended (same path as batch).
            self._pipeline.flush()
            if self._supervisor.state == "failed":
                # The reconnect budget is exhausted — a connection failure, categorized as such.
                self._fail_session(
                    ConnectionExhausted(self._supervisor.last_error or "reconnect budget exhausted")
                )
            elif not self._stopping and not self._paused:
                # A finite source ran to completion: the session is DONE, so the control plane must
                # say so rather than leaving a `running` session with nothing behind it.
                self._complete_session()
        except ModelFailure as exc:
            # A model failure is NOT recoverable by reconnecting — fail the session immediately.
            self._fail_session(exc)
        except Exception as exc:  # noqa: BLE001 - never let a pump error escape a session boundary
            self._fail_session(exc)
        finally:
            self._finished.set()
            if not self._stopping:
                self._teardown(reason="completed")

    def _should_continue(self) -> bool:
        """Lifecycle → data plane. A paused session stops consuming; a stopped one exits the pump."""
        if self._stopping:
            return False
        if self._paused:
            return False
        return True

    def _handle_result(self, analysis) -> None:  # noqa: ANN001 - FrameAnalysis
        """Heartbeat + metrics on every analyzed frame (the runner's own two jobs). The session's
        perception output goes to the caller's sink untouched — the runner never inspects it."""
        self._account_frame()
        try:
            self._manager.heartbeat(self.identity.tenant_id, self.identity.session_id, self.metrics())
        except (Conflict, NotFound):
            # The control plane moved on (paused/stopped/removed) — not the data plane's business.
            pass
        if self._on_result is not None:
            self._on_result(analysis)

    # --- AI-5c: report measurements up, apply decisions down ----------------------
    # The runner remains ORCHESTRATION ONLY (AI-5b refinement 2): it reports what it measured and
    # applies what the governor decided. It never decides anything itself.

    def _account_frame(self) -> None:
        """Feed this session's own account (never another's — AI-5c refinement 7)."""
        if self._account is None:
            return
        backpressure = self._pipeline.stats()
        timings = self._analyzer.timings
        frames = max(1, self._pipeline.frames_processed)
        self._account.frames_processed = self._pipeline.frames_processed
        self._account.inference_ms_total = timings.inference_ms
        self._account.event_latency_ms_total = sum(timings.as_dict().values())
        self._account.dropped_frames = backpressure["framesDropped"]
        self._account.queue_depth = backpressure["queueDepth"]
        self._account.average_queue_depth = backpressure["averageQueueDepth"]
        self._account.reconnect_count = self._supervisor.reconnect_count
        uptime = self._supervisor.uptime_seconds
        self._account.effective_fps = (
            round(self._pipeline.frames_processed / uptime, 3) if uptime > 0 else 0.0
        )
        self._account.health = self._session_health()

    def govern(self, *, snapshot=None) -> Optional[object]:  # noqa: ANN001 - ResourceSnapshot
        """One governor observation for this session. Returns the decision taken, if any.

        Called on the supervisor's cadence, not per frame: degradation is a slow control loop, and
        running it per frame would make it react to noise instead of to trends.
        """
        if self._account is None or self._governor is None:
            return None
        backpressure = self._pipeline.stats()
        decision = self._governor.observe(
            self._account,
            queue_utilization=backpressure["queueUtilization"],
            event_latency_ms=self._account.event_latency_ms,
            snapshot=snapshot,
        )
        if decision is not None:
            self._apply_degradation()
        return decision

    def _apply_degradation(self) -> None:
        """Apply the account's current rung to the data plane. Suspension pauses consumption; it does
        NOT fail the session, and it is fully reversible."""
        if self._account is None:
            return
        level = self._account.degradation
        self._paused = level == "suspended"
        self._log.emit(
            "session.degradation_applied",
            level="warn" if level != "none" else "info",
            degradation=level,
            effectiveFps=self._governor.effective_fps_for(self._account) if self._governor else None,
        )

    def _session_health(self) -> str:
        """Derived health for SLA reporting — read from the control plane, never invented here."""
        session = self._manager.get(self.identity.tenant_id, self.identity.session_id)
        return session.health() if session is not None else "unknown"

    @property
    def account(self):  # noqa: ANN201 - resources.SessionAccount | None
        """This session's resource account — its own, never shared (refinement 7)."""
        return self._account

    def _complete_session(self) -> None:
        """Move the session to `stopped` after its source is exhausted (best-effort: the control plane
        may already have moved it)."""
        try:
            self._manager.stop(self.identity.tenant_id, self.identity.session_id)
            self._log.emit("session.completed")
        except (Conflict, NotFound):
            pass

    def _fail_session(self, exc: BaseException) -> None:
        category = failure_category(exc)
        self._log.failure(exc, event="session.failed")
        try:
            self._manager.fail(
                self.identity.tenant_id,
                self.identity.session_id,
                f"[{failure_code(category)}] {str(exc)[:500]}",
            )
        except (Conflict, NotFound):
            pass

    # --- teardown (refinement 8: queue · source · thread · heartbeat · metrics) ---

    def _teardown(self, *, reason: str) -> None:
        """Release every resource this runner owns. Idempotent and safe from any state, so stop,
        restart and fail all converge here and nothing leaks."""
        released = self._pipeline.close()  # queue frames released
        self._supervisor.stop()  # source closed (decoder released)
        self._executor.join(0.1)  # thread joined
        self._paused = False  # heartbeat/pause state cleared
        self._log.emit(
            "session.torn_down",
            reason=reason,
            releasedFrames=released,
            framesProcessed=self._pipeline.frames_processed,
        )

    # --- metrics (the runner's fifth job) ----------------------------------------

    def metrics(self) -> dict:
        """A `RuntimeMetrics`-shaped snapshot for this session — the union of the source tier, the
        pipeline tier, and the lifecycle. Assembled here because the runner is the only tier that can
        see all three; computed by NONE of it."""
        ingestion = self._supervisor.stats()
        backpressure = self._pipeline.stats()
        timings = self._analyzer.timings
        frames = max(1, self._pipeline.frames_processed)
        uptime = self._supervisor.uptime_seconds
        return {
            "fps": round(self._pipeline.frames_processed / uptime, 3) if uptime > 0 else 0.0,
            "framesProcessed": self._pipeline.frames_processed,
            "framesSkipped": backpressure["framesSkipped"],
            "droppedFrames": backpressure["framesDropped"],
            "avgLatencyMs": round(timings.inference_ms / frames, 3),
            "latencyP50Ms": round(timings.inference_ms / frames, 3),
            "latencyP95Ms": round(timings.inference_ms / frames, 3),
            "queueDepth": backpressure["queueDepth"],
            "uptimeSeconds": round(uptime, 3),
            # AI-5b additive operational fields (each now has a real producer).
            "reconnectCount": ingestion["reconnectCount"],
            "restartCount": self.restart_count,
            "streamAvailability": ingestion["availabilityPercent"],
            "averageRecoveryTime": ingestion["averageRecoveryMs"],
            "queueHighWatermark": backpressure["queueHighWatermark"],
            "queueUtilization": backpressure["queueUtilization"],
            "averageQueueDepth": backpressure["averageQueueDepth"],
            "processingDelayMs": backpressure["processingDelayMs"],
        }

    def diagnostics(self) -> dict:
        """A `SessionDiagnostics`-shaped snapshot: identity + source tier + pipeline tier + lifecycle."""
        session = self._manager.get(self.identity.tenant_id, self.identity.session_id)
        ingestion = self._supervisor.stats()
        # Pipeline-tier failures are folded in here so an operator sees ONE categorized list.
        for category, count in self._pipeline.failure_counts().items():
            ingestion["failures"].append(
                {"category": category, "code": failure_code(category), "count": count}
            )
        return {
            "identity": self.identity.to_dict(),
            "state": session.state if session is not None else "stopped",
            "ingestion": ingestion,
            "backpressure": self._pipeline.stats(),
            "restartCount": self.restart_count,
            **({"startedAt": session.started_at} if session and session.started_at else {}),
            **({"lastHeartbeat": session.last_heartbeat} if session and session.last_heartbeat else {}),
        }


class ConnectionExhausted(RuntimeError):
    """The reconnect budget ran out — a terminal `connection` failure for the session."""

    category = "connection"


class SessionSupervisor:
    """Manages N live sessions across cameras and tenants — the multi-camera unit.

    It owns capacity (a bounded number of concurrent sessions), tenant-scoped lookup, and orderly
    shutdown. Session STATE remains owned by the `SessionManager` (G-3, unchanged): the supervisor
    starts/stops runners in response to state, it does not reimplement the state machine.
    """

    def __init__(
        self,
        manager: SessionManager,
        *,
        max_sessions: int = _DEFAULT_MAX_SESSIONS,
        executor_factory: Optional[Callable[[], object]] = None,
        clock: Callable[[], float] = time.monotonic,
        scheduler=None,  # noqa: ANN001 - scheduler.InferenceScheduler (AI-5c; None = AI-5b behavior)
        monitor=None,  # noqa: ANN001 - compute.ResourceMonitor
        deployment=None,  # noqa: ANN001 - deployment.DeploymentProfile
    ) -> None:
        if max_sessions < 1:
            raise ConfigurationFailure(f"max_sessions must be >= 1, got {max_sessions}")
        self._manager = manager
        self._max = int(max_sessions)
        self._executor_factory = executor_factory or SynchronousExecutor
        self._clock = clock
        self._runners: Dict[str, SessionRunner] = {}
        # AI-5c (all optional — absent means exactly the AI-5b behavior, so this stays additive).
        self._scheduler = scheduler
        self._monitor = monitor
        self._deployment = deployment

    @property
    def max_sessions(self) -> int:
        return self._max

    def start(
        self,
        tenant_id: str,
        *,
        camera_id: str,
        capability_id: str,
        config: LiveSessionConfig,
        analyzer: VideoAnalyzer,
        correlation_id: Optional[str] = None,
        source: Optional[StreamSource] = None,
        on_result: Optional[Callable[[object], None]] = None,
        log_sink: Optional[Callable[[dict], None]] = None,
        model_id: Optional[str] = None,
        model_version: Optional[str] = None,
        engine: Optional[str] = None,
        priority: str = "normal",
    ) -> SessionRunner:
        """Start a live session for one camera. Fails with `Conflict` (→ 409) when the runtime is at
        capacity — refusing a session is how a fixed-size box protects the sessions already running.

        With a scheduler attached (AI-5c) the refusal becomes **evidence-based**: admission control
        estimates the session's compute cost and refuses when it cannot be served safely, with a
        structured reason an operator can act on rather than a bare capacity count.
        """
        if self.active_count >= self._max:
            raise Conflict(
                f"session capacity reached ({self.active_count}/{self._max}); stop a session first"
            )
        session = self._manager.start(
            tenant_id,
            camera_id=camera_id,
            capability_id=capability_id,
            model_id=model_id,
            model_version=model_version,
            engine=engine,
        )
        identity = SessionIdentity(
            tenant_id=tenant_id,
            camera_id=camera_id,
            session_id=session.session_id,
            correlation_id=correlation_id,
        )

        # AI-5c admission control. A refusal must not leave a half-started session behind, so the
        # control-plane record is stopped before the Conflict propagates.
        account = None
        if self._scheduler is not None:
            verdict, account = self._scheduler.admit(
                identity,
                target_fps=config.pipeline.target_fps or 5.0,
                priority=priority,
                target_latency_ms=(
                    self._deployment.target_event_latency_ms if self._deployment else None
                ),
            )
            if not verdict.admitted:
                try:
                    self._manager.stop(tenant_id, session.session_id)
                except (Conflict, NotFound):
                    pass
                raise Conflict(verdict.detail)

        runner = SessionRunner(
            identity,
            self._manager,
            config,
            analyzer=analyzer,
            source=source,
            executor=self._executor_factory(),
            clock=self._clock,
            log=OperationalLog(identity, sink=log_sink),
            on_result=on_result,
            account=account,
            governor=self._scheduler.governor if self._scheduler is not None else None,
        )
        self._runners[self._key(tenant_id, session.session_id)] = runner
        runner.start()
        return runner

    # --- lifecycle passthrough (state stays with the SessionManager) --------------

    def pause(self, tenant_id: str, session_id: str) -> SessionRunner:
        self._manager.pause(tenant_id, session_id)
        runner = self.require(tenant_id, session_id)
        runner.pause()
        return runner

    def resume(self, tenant_id: str, session_id: str) -> SessionRunner:
        self._manager.resume(tenant_id, session_id)
        runner = self.require(tenant_id, session_id)
        runner.resume()
        return runner

    def stop(self, tenant_id: str, session_id: str) -> SessionRunner:
        runner = self.require(tenant_id, session_id)
        try:
            self._manager.stop(tenant_id, session_id)
        except Conflict:
            pass  # already stopped/failed — tear the runner down regardless
        runner.stop()
        self._runners.pop(self._key(tenant_id, session_id), None)
        # Hand the compute back — otherwise a stopped session would permanently shrink capacity.
        if self._scheduler is not None:
            self._scheduler.release(runner.identity)
        return runner

    def restart(self, tenant_id: str, session_id: str) -> SessionRunner:
        self._manager.restart(tenant_id, session_id)
        runner = self.require(tenant_id, session_id)
        runner.restart()
        return runner

    # --- reads (tenant-scoped; cross-tenant access is invisible, never an error) ---

    def get(self, tenant_id: str, session_id: str) -> Optional[SessionRunner]:
        runner = self._runners.get(self._key(tenant_id, session_id))
        return runner if runner is not None and runner.identity.tenant_id == tenant_id else None

    def require(self, tenant_id: str, session_id: str) -> SessionRunner:
        runner = self.get(tenant_id, session_id)
        if runner is None:
            raise NotFound(f"live session '{session_id}' not found")
        return runner

    def list(self, tenant_id: str, *, camera_id: Optional[str] = None) -> List[SessionRunner]:
        out = [r for r in self._runners.values() if r.identity.tenant_id == tenant_id]
        if camera_id is not None:
            out = [r for r in out if r.identity.camera_id == camera_id]
        return sorted(out, key=lambda r: r.identity.session_id)

    @property
    def active_count(self) -> int:
        return len(self._runners)

    def stats(self) -> dict:
        """A `SessionSupervisorStats`-shaped snapshot across every running session (fleet health)."""
        by_state: Dict[str, int] = {}
        degraded = 0
        reconnects = 0
        availability: List[float] = []
        for runner in self._runners.values():
            session = self._manager.get(runner.identity.tenant_id, runner.identity.session_id)
            state = session.state if session is not None else "stopped"
            by_state[state] = by_state.get(state, 0) + 1
            diag = runner.diagnostics()
            if diag["ingestion"]["state"] != "connected":
                degraded += 1
            reconnects += diag["ingestion"]["reconnectCount"]
            availability.append(diag["ingestion"]["availabilityPercent"])
        return {
            "activeSessions": self.active_count,
            "maxSessions": self._max,
            "byState": by_state,
            "degradedSessions": degraded,
            "totalReconnects": reconnects,
            "averageAvailabilityPercent": round(sum(availability) / len(availability), 3)
            if availability
            else 0.0,
        }

    # --- AI-5c: the governor control loop ----------------------------------------

    def govern(self) -> List[dict]:
        """One governor pass across every session — the control loop that keeps the box healthy.

        Runs on the supervisor's cadence (not per frame) because degradation is a slow loop: reacting
        per frame would chase noise. Returns the decisions taken, so a caller can log or assert them.
        """
        if self._scheduler is None:
            return []
        snapshot = self._monitor.sample() if self._monitor is not None else None
        if snapshot is not None:
            self._scheduler_accountant.attribute(snapshot)
        decisions: List[dict] = []
        for runner in list(self._runners.values()):
            decision = runner.govern(snapshot=snapshot)
            if decision is not None:
                decisions.append(decision.to_dict())
        return decisions

    @property
    def _scheduler_accountant(self):  # noqa: ANN202 - resources.ResourceAccountant
        return self._scheduler._accountant  # noqa: SLF001 - same-module collaborator

    def scheduler_stats(self) -> dict:
        """A `SchedulerStats`-shaped snapshot, or an empty dict when unscheduled."""
        if self._scheduler is None:
            return {}
        snapshot = self._monitor.sample() if self._monitor is not None else None
        return self._scheduler.stats(snapshot=snapshot)

    def sla(self, tenant_id: Optional[str] = None) -> List[dict]:
        """Per-session SLA: target vs actual, so scheduling is data-driven (rec 6)."""
        if self._scheduler is None:
            return []
        return [a.to_sla_dict() for a in self._scheduler_accountant.list(tenant_id=tenant_id)]

    def resource_usage(self, tenant_id: Optional[str] = None) -> List[dict]:
        """Per-session resource accounting — what each camera actually costs (rec 3)."""
        if self._scheduler is None:
            return []
        return [a.to_usage_dict() for a in self._scheduler_accountant.list(tenant_id=tenant_id)]

    def shutdown(self, *, timeout: Optional[float] = 5.0) -> int:
        """Stop every session and release every resource (refinement 8). Returns how many were stopped.
        After this the supervisor holds no runners, no threads, and no queued frames."""
        stopped = 0
        for key, runner in list(self._runners.items()):
            runner.stop(timeout=timeout)
            self._runners.pop(key, None)
            if self._scheduler is not None:
                self._scheduler.release(runner.identity)
            stopped += 1
        return stopped

    @staticmethod
    def _key(tenant_id: str, session_id: str) -> str:
        # Tenant-qualified so one tenant can never address another's session by id (Law 5).
        return f"{tenant_id}::{session_id}"
