"""AI-5b — Session Runner + Supervisor: lifecycle, identity, multi-camera isolation, cleanup.

Every test runs the real runner against a real (simulated) source with the synchronous executor, so the
whole lifecycle is exercised with no threads, no sleeps, and no network — the platform's determinism
standard. The runner's contract is narrow on purpose: read · execute · heartbeat · metrics · lifecycle.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure, Conflict, NotFound
from operational_log import SessionIdentity
from playground import build_adapter
from session_runner import LiveSessionConfig, SessionRunner, SessionSupervisor, SynchronousExecutor
from sessions import SessionManager
from stream_pipeline import PipelineOptions
from stream_source import FaultPlan, ReconnectPolicy, SimulatedStreamSource
from video_analyzer import AnalyzeOptions, VideoAnalyzer


def _config(*, frames: int = 12, capacity: int = 8, target_fps: float = 5.0, uri: str = "sim://cam") -> LiveSessionConfig:
    return LiveSessionConfig(
        source={"type": "simulated", "uri": uri, "options": {"totalFrames": frames}},
        analyze=_options(),
        pipeline=PipelineOptions(queue_capacity=capacity, target_fps=target_fps, source_fps=30.0),
        reconnect=ReconnectPolicy(max_attempts=3, base_ms=1.0, max_ms=5.0),
    )


def _options(camera_id: str = "cam_1", session_id: str = "ses_1") -> AnalyzeOptions:
    return AnalyzeOptions(
        tenant_id="tnt_a", camera_id=camera_id, session_id=session_id, min_confidence=0.3
    )


def _analyzer(opts=None) -> VideoAnalyzer:
    return VideoAnalyzer(build_adapter("stub"), opts or _options())


def _supervisor(manager=None, *, max_sessions: int = 4) -> SessionSupervisor:
    return SessionSupervisor(manager or SessionManager(), max_sessions=max_sessions)


def _start(supervisor, *, tenant="tnt_a", camera="cam_1", config=None, results=None):
    return supervisor.start(
        tenant,
        camera_id=camera,
        capability_id="playground.detect",
        config=config or _config(),
        analyzer=_analyzer(_options(camera_id=camera)),
        on_result=(results.append if results is not None else None),
        log_sink=lambda _record: None,
    )


class LifecycleTest(unittest.TestCase):
    def test_a_live_session_actually_pumps_frames_and_produces_results(self):
        results: list = []
        runner = _start(_supervisor(), results=results)
        self.assertTrue(runner.finished)
        self.assertGreater(len(results), 0)
        self.assertGreater(runner.metrics()["framesProcessed"], 0)

    def test_heartbeats_are_produced_by_the_running_pipeline(self):
        manager = SessionManager()
        runner = _start(_supervisor(manager))
        session = manager.get("tnt_a", runner.identity.session_id)
        # G-3 defined heartbeats; until AI-5b nothing ever sent one.
        self.assertIsNotNone(session.last_heartbeat)
        self.assertIsNotNone(session.metrics)
        self.assertIn("framesProcessed", session.metrics)

    def test_a_finite_source_completes_the_session_rather_than_leaving_it_running(self):
        manager = SessionManager()
        runner = _start(_supervisor(manager))
        self.assertEqual(manager.get("tnt_a", runner.identity.session_id).state, "stopped")

    def test_exhausting_the_reconnect_budget_fails_the_session_with_a_coded_error(self):
        manager = SessionManager()
        supervisor = _supervisor(manager)
        config = _config()
        config.source = {"type": "simulated", "uri": "sim://dead", "options": {"totalFrames": 5}}
        runner = supervisor.start(
            "tnt_a",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=config,
            analyzer=_analyzer(),
            source=SimulatedStreamSource(uri="sim://dead", faults=FaultPlan(fail_opens=99)),
            log_sink=lambda _r: None,
        )
        session = manager.get("tnt_a", runner.identity.session_id)
        self.assertEqual(session.state, "failed")
        self.assertIn("AI-CONN", session.last_error)  # connection, not "something went wrong"

    def test_pause_stops_consuming_and_resume_continues(self):
        manager = SessionManager()
        supervisor = _supervisor(manager)
        runner = _start(supervisor, config=_config(frames=40, target_fps=30.0))
        # Re-arm a fresh runner we control frame-by-frame.
        runner.pause()
        self.assertTrue(runner.paused)
        self.assertFalse(runner._should_continue())  # lifecycle reaches the data plane
        runner.resume()
        self.assertFalse(runner.paused)
        self.assertTrue(runner._should_continue())

    def test_restart_preserves_the_logical_identity(self):
        manager = SessionManager()
        supervisor = _supervisor(manager)
        runner = _start(supervisor)
        before = runner.identity
        supervisor.restart("tnt_a", runner.identity.session_id)
        self.assertEqual(runner.identity, before)  # identity survives a restart
        self.assertEqual(runner.restart_count, 1)
        self.assertEqual(runner.metrics()["restartCount"], 1)


class IdentityTest(unittest.TestCase):
    def test_identity_is_logical_and_reported_everywhere(self):
        runner = _start(_supervisor())
        identity = runner.diagnostics()["identity"]
        self.assertEqual(set(identity), {"tenantId", "cameraId", "sessionId"})
        self.assertEqual(identity["tenantId"], "tnt_a")

    def test_correlation_id_flows_into_diagnostics(self):
        supervisor = _supervisor()
        runner = supervisor.start(
            "tnt_a",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=_config(),
            analyzer=_analyzer(),
            correlation_id="corr_42",
            log_sink=lambda _r: None,
        )
        self.assertEqual(runner.diagnostics()["identity"]["correlationId"], "corr_42")


class MultiCameraTest(unittest.TestCase):
    def test_runs_several_cameras_concurrently_with_independent_state(self):
        supervisor = _supervisor(max_sessions=4)
        runners = [_start(supervisor, camera=f"cam_{i}") for i in range(3)]
        self.assertEqual(supervisor.active_count, 3)
        self.assertEqual(len({r.identity.session_id for r in runners}), 3)
        for runner in runners:
            self.assertGreater(runner.metrics()["framesProcessed"], 0)

    def test_capacity_is_bounded_and_refuses_rather_than_degrading_everyone(self):
        supervisor = _supervisor(max_sessions=2)
        _start(supervisor, camera="cam_1")
        _start(supervisor, camera="cam_2")
        with self.assertRaises(Conflict):
            _start(supervisor, camera="cam_3")
        self.assertEqual(supervisor.active_count, 2)

    def test_sessions_are_tenant_isolated(self):
        supervisor = _supervisor()
        runner = _start(supervisor, tenant="tnt_a", camera="cam_1")
        _start(supervisor, tenant="tnt_b", camera="cam_1")
        # Another tenant cannot see or address this session — it simply does not exist for them.
        self.assertIsNone(supervisor.get("tnt_b", runner.identity.session_id))
        with self.assertRaises(NotFound):
            supervisor.require("tnt_b", runner.identity.session_id)
        self.assertEqual(len(supervisor.list("tnt_a")), 1)
        self.assertEqual(len(supervisor.list("tnt_b")), 1)

    def test_supervisor_reports_fleet_capacity_and_health(self):
        supervisor = _supervisor(max_sessions=8)
        _start(supervisor, camera="cam_1")
        _start(supervisor, camera="cam_2")
        stats = supervisor.stats()
        self.assertEqual(stats["activeSessions"], 2)
        self.assertEqual(stats["maxSessions"], 8)
        self.assertIn("byState", stats)
        self.assertLessEqual(stats["averageAvailabilityPercent"], 100.0)

    def test_invalid_capacity_is_a_configuration_failure(self):
        with self.assertRaises(ConfigurationFailure):
            SessionSupervisor(SessionManager(), max_sessions=0)


class MetricsTest(unittest.TestCase):
    def test_metrics_expose_the_ai_5b_operational_fields(self):
        runner = _start(_supervisor())
        metrics = runner.metrics()
        for key in (
            "reconnectCount",
            "restartCount",
            "streamAvailability",
            "averageRecoveryTime",
            "queueHighWatermark",
            "queueUtilization",
            "averageQueueDepth",
            "processingDelayMs",
        ):
            self.assertIn(key, metrics)

    def test_diagnostics_keep_the_three_tiers_separate(self):
        runner = _start(_supervisor())
        diagnostics = runner.diagnostics()
        self.assertEqual(
            set(diagnostics) & {"identity", "ingestion", "backpressure", "state", "restartCount"},
            {"identity", "ingestion", "backpressure", "state", "restartCount"},
        )
        # Source tier owns connection; pipeline tier owns queue. Neither owns the other's fields.
        self.assertIn("reconnectCount", diagnostics["ingestion"])
        self.assertNotIn("queueDepth", diagnostics["ingestion"])
        self.assertIn("queueDepth", diagnostics["backpressure"])
        self.assertNotIn("reconnectCount", diagnostics["backpressure"])

    def test_reconnects_are_counted_in_session_metrics(self):
        supervisor = _supervisor()
        runner = supervisor.start(
            "tnt_a",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=_config(frames=9),
            analyzer=_analyzer(),
            source=SimulatedStreamSource(
                uri="sim://flappy", total_frames=9, faults=FaultPlan(drop_after_frames=3, max_drops=1)
            ),
            log_sink=lambda _r: None,
        )
        self.assertEqual(runner.metrics()["reconnectCount"], 1)


class CleanupTest(unittest.TestCase):
    """Refinement 8: queue · source · thread · heartbeat · metrics all released on stop/restart/fail."""

    def test_stop_releases_every_resource(self):
        manager = SessionManager()
        supervisor = _supervisor(manager)
        runner = _start(supervisor, config=_config(frames=40, capacity=4))
        supervisor.stop("tnt_a", runner.identity.session_id)
        self.assertTrue(runner._pipeline.closed)  # queue released
        self.assertEqual(runner._pipeline.queue.depth, 0)
        self.assertIn(runner._supervisor.state, ("stopped", "failed"))  # source closed
        self.assertFalse(runner.paused)  # lifecycle state cleared
        self.assertEqual(supervisor.active_count, 0)  # no dangling runner

    def test_stop_is_idempotent(self):
        supervisor = _supervisor()
        runner = _start(supervisor)
        supervisor.stop("tnt_a", runner.identity.session_id)
        runner.stop()  # a second stop must not explode or double-release
        self.assertTrue(runner._pipeline.closed)

    def test_shutdown_releases_the_whole_fleet(self):
        supervisor = _supervisor(max_sessions=4)
        runners = [_start(supervisor, camera=f"cam_{i}") for i in range(3)]
        self.assertEqual(supervisor.shutdown(), 3)
        self.assertEqual(supervisor.active_count, 0)
        for runner in runners:
            self.assertTrue(runner._pipeline.closed)
            self.assertEqual(runner._pipeline.queue.depth, 0)

    def test_a_failed_session_also_releases_its_resources(self):
        supervisor = _supervisor()
        runner = supervisor.start(
            "tnt_a",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=_config(),
            analyzer=_analyzer(),
            source=SimulatedStreamSource(uri="sim://dead", faults=FaultPlan(fail_opens=99)),
            log_sink=lambda _r: None,
        )
        self.assertTrue(runner._pipeline.closed)
        self.assertEqual(runner._pipeline.queue.depth, 0)


class OrchestrationOnlyTest(unittest.TestCase):
    """Refinement 2: the runner orchestrates and nothing else."""

    def test_runner_holds_no_perception_or_camera_configuration_state(self):
        runner = _start(_supervisor())
        attributes = set(vars(runner))
        for forbidden in ("_zones", "_tracker", "_behaviors", "_composites", "_manager_tracks", "_camera_config"):
            self.assertNotIn(forbidden, attributes)

    def test_runner_public_surface_is_the_five_declared_jobs(self):
        # read+execute (start) · lifecycle (pause/resume/stop/restart) · metrics · diagnostics,
        # plus lifecycle-status properties. Nothing perception-shaped may appear here.
        #
        # AI-5c adds exactly two members, both still orchestration: `govern` APPLIES a decision the
        # governor made (the runner never decides), and `account` REPORTS this session's own measured
        # cost. Neither performs tracking, behavior, business logic, or camera configuration.
        public = {name for name in dir(SessionRunner) if not name.startswith("_")}
        self.assertEqual(
            public,
            {
                "start",
                "pause",
                "resume",
                "stop",
                "restart",
                "metrics",
                "diagnostics",
                "finished",
                "paused",
                "govern",
                "account",
            },
        )

    def test_executor_is_injectable_so_threads_are_never_part_of_identity(self):
        supervisor = SessionSupervisor(
            SessionManager(), max_sessions=2, executor_factory=SynchronousExecutor
        )
        runner = _start(supervisor)
        self.assertIsInstance(runner.identity, SessionIdentity)
        self.assertNotIn("thread", repr(runner.identity).lower())


if __name__ == "__main__":
    unittest.main()
