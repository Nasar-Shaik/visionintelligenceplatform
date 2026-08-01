"""AI-5d end-to-end: health, recovery, journal and timeline through a real SessionSupervisor.

The unit tests prove each mechanism in isolation. This file proves they are actually WIRED — that a
session started through the supervisor scores health, that a failed session is offered to recovery
within its deployment's budget, that everything lands in one journal, and that a runtime configured
with none of it behaves exactly as it did at AI-5c.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import ComputeRegistry, ComputeResource  # noqa: E402
from errors import ConnectionFailure  # noqa: E402
from health import HealthPolicy  # noqa: E402
from journal import DiagnosticsJournal  # noqa: E402
from recovery import AutoRecovery, RecoveryPolicy, healthcare_policy  # noqa: E402
from resources import ResourceAccountant  # noqa: E402
from scheduler import InferenceScheduler, SchedulerPolicy  # noqa: E402
from session_runner import LiveSessionConfig, SessionSupervisor  # noqa: E402
from sessions import SessionManager  # noqa: E402
from stream_pipeline import PipelineOptions  # noqa: E402
from stream_source import FaultPlan, ReconnectPolicy, SimulatedStreamSource  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += seconds
        return self.now


class _Adapter:
    execution_provider = "stub"

    def load(self, ref: dict) -> None:
        return None

    def preprocess(self, ctx):  # noqa: ANN001
        return ctx

    def infer(self, prepared):  # noqa: ANN001
        return []

    def unload(self) -> None:
        return None


def _analyzer() -> VideoAnalyzer:
    return VideoAnalyzer(
        _Adapter(),
        AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_1", enable_behaviors=False),
        now_iso=lambda: "2026-08-01T00:00:00.000Z",
    )


def _scheduler(max_sessions: int = 4) -> InferenceScheduler:
    return InferenceScheduler(
        ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)]),
        ResourceAccountant(),
        policy=SchedulerPolicy(reserved_capacity_percent=0.0, stabilization_samples=0),
        max_sessions=max_sessions,
        now_iso=lambda: "2026-08-01T00:00:00.000Z",
    )


def _supervisor(*, health=True, recovery=None, journal=None) -> SessionSupervisor:
    # The runtime clock stays REAL here. Determinism comes from the simulated source and the
    # synchronous executor, not from freezing time — a frozen clock makes the connection supervisor's
    # backoff wait on a delta that never arrives, which hangs rather than fails.
    return SessionSupervisor(
        SessionManager(),
        max_sessions=4,
        scheduler=_scheduler(),
        health_policy=HealthPolicy() if health else None,
        recovery=recovery,
        journal=journal,
    )


def _config(frames: int = 5) -> LiveSessionConfig:
    return LiveSessionConfig(
        source={"type": "simulated", "uri": "sim://cam", "options": {"totalFrames": frames}},
        analyze=AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_1", enable_behaviors=False),
        pipeline=PipelineOptions(queue_capacity=8, target_fps=5.0, source_fps=30.0),
        # Fast and bounded: the production defaults back off to 30s across 10 attempts, which would
        # make a fault-injection test sleep for minutes.
        reconnect=ReconnectPolicy(max_attempts=3, base_ms=1.0, max_ms=5.0),
    )


def _start(supervisor, *, camera: str = "cam_1", faults: FaultPlan = None, frames: int = 5):
    return supervisor.start(
        "tnt_a",
        camera_id=camera,
        capability_id="playground.detect",
        config=_config(frames),
        analyzer=_analyzer(),
        source=SimulatedStreamSource(uri="sim://cam", total_frames=frames, faults=faults),
        log_sink=lambda _r: None,
    )


class HealthWiringTest(unittest.TestCase):
    def test_a_live_session_scores_health_with_every_component(self):
        supervisor = _supervisor()
        runner = _start(supervisor)
        score = runner.score_health()
        self.assertIsNotNone(score)
        self.assertEqual(
            set(score.components), {"connection", "inference", "scheduler", "resources", "recovery"}
        )

    def test_fleet_health_names_the_weakest_subsystem(self):
        supervisor = _supervisor()
        _start(supervisor, camera="cam_1")
        _start(supervisor, camera="cam_2")
        supervisor.govern()
        fleet = supervisor.fleet_health("tnt_a")
        self.assertEqual(fleet["sessions"], 2)
        self.assertIn(fleet["weakestComponent"], {"connection", "inference", "scheduler", "resources", "recovery"})
        self.assertIn("componentAverages", fleet)

    def test_health_is_tenant_scoped(self):
        supervisor = _supervisor()
        _start(supervisor)
        self.assertEqual(len(supervisor.health("tnt_a")), 1)
        self.assertEqual(supervisor.health("tnt_b"), [])

    def test_govern_feeds_health_into_the_governor(self):
        supervisor = _supervisor()
        runner = _start(supervisor)
        supervisor.govern()
        self.assertIsNotNone(runner.health)
        self.assertIsNotNone(runner.account.health_score)

    def test_a_runtime_without_a_health_policy_scores_nothing(self):
        # Absent policy = exactly the AI-5c behavior. This is what keeps AI-5d additive.
        supervisor = _supervisor(health=False)
        runner = _start(supervisor)
        self.assertIsNone(runner.score_health())
        self.assertIsNone(runner.health)
        self.assertEqual(supervisor.health("tnt_a"), [])


class RecoveryWiringTest(unittest.TestCase):
    def test_a_failed_session_is_recovered_within_budget(self):
        clock = _Clock()
        recovery = AutoRecovery(
            policy=RecoveryPolicy(max_restarts=2, stabilization_seconds=0.0), clock=clock
        )
        supervisor = _supervisor(recovery=recovery)
        runner = _start(supervisor, faults=FaultPlan(fail_opens=99), frames=3)
        self.assertIsNotNone(runner.last_failure, "the session did not fail as scripted")
        attempts = supervisor.recover("tnt_a")
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["reason"]["failureCategory"], "connection")

    def test_a_healthcare_deployment_never_auto_restarts(self):
        supervisor = _supervisor(recovery=AutoRecovery(policy=healthcare_policy(), clock=_Clock()))
        runner = _start(supervisor, faults=FaultPlan(fail_opens=99), frames=3)
        restarts_before = runner.restart_count
        attempts = supervisor.recover("tnt_a")
        self.assertEqual(attempts[0]["outcome"], "operator-required")
        self.assertEqual(runner.restart_count, restarts_before)

    def test_a_healthy_session_is_never_offered_to_recovery(self):
        supervisor = _supervisor(
            recovery=AutoRecovery(policy=RecoveryPolicy(stabilization_seconds=0.0), clock=_Clock())
        )
        _start(supervisor, frames=3)
        self.assertEqual(supervisor.recover("tnt_a"), [])

    def test_a_runtime_without_recovery_behaves_as_before(self):
        supervisor = _supervisor(recovery=None)
        runner = _start(supervisor, faults=FaultPlan(fail_opens=99), frames=3)
        self.assertEqual(supervisor.recover("tnt_a"), [])
        self.assertIsNone(runner.recover())


class JournalWiringTest(unittest.TestCase):
    def test_a_sessions_lifecycle_lands_in_the_journal_automatically(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(journal=journal)
        runner = _start(supervisor)
        self.assertGreater(journal.count(runner.identity), 0)
        events = {e["event"] for e in journal.journal(runner.identity)}
        self.assertIn("session.started", events)

    def test_the_caller_sink_still_receives_everything(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(journal=journal)
        captured = []
        runner = supervisor.start(
            "tnt_a",
            camera_id="cam_1",
            capability_id="playground.detect",
            config=_config(3),
            analyzer=_analyzer(),
            source=SimulatedStreamSource(uri="sim://cam", total_frames=3),
            log_sink=captured.append,
        )
        self.assertGreater(len(captured), 0)
        self.assertGreater(journal.count(runner.identity), 0)

    def test_the_timeline_reads_forwards(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(journal=journal)
        runner = _start(supervisor)
        timeline = supervisor.timeline("tnt_a", runner.identity.session_id)
        self.assertGreater(len(timeline), 0)
        self.assertEqual(timeline[0]["label"], "Session started")

    def test_operational_diagnostics_assembles_the_whole_picture(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(
            journal=journal,
            recovery=AutoRecovery(policy=RecoveryPolicy(stabilization_seconds=0.0), clock=_Clock()),
        )
        runner = _start(supervisor)
        supervisor.govern()
        doc = supervisor.operational_diagnostics("tnt_a", runner.identity.session_id)
        for key in ("identity", "health", "stream", "degradation", "restoreStack", "recovery", "journal", "timeline"):
            self.assertIn(key, doc)
        self.assertEqual(doc["identity"]["sessionId"], runner.identity.session_id)


class CleanupTest(unittest.TestCase):
    """AI-5b refinement 8, extended to the AI-5d stores: a stopped session leaves nothing behind."""

    def test_stopping_a_session_releases_its_journal_and_ledger(self):
        journal = DiagnosticsJournal()
        recovery = AutoRecovery(policy=RecoveryPolicy(stabilization_seconds=0.0), clock=_Clock())
        supervisor = _supervisor(journal=journal, recovery=recovery)
        runner = _start(supervisor)
        identity = runner.identity
        self.assertGreater(journal.count(identity), 0)
        supervisor.stop("tnt_a", identity.session_id)
        self.assertEqual(journal.count(identity), 0)
        self.assertEqual(recovery.ledger.total(identity), 0)

    def test_shutdown_releases_every_session(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(journal=journal)
        _start(supervisor, camera="cam_1")
        _start(supervisor, camera="cam_2")
        self.assertEqual(supervisor.shutdown(), 2)
        self.assertEqual(journal.sessions, 0)
        self.assertEqual(supervisor.active_count, 0)


class IsolationTest(unittest.TestCase):
    """AI-5c refinement 7 extended: the AI-5d state is per-session too."""

    def test_each_session_owns_its_health_monitor_and_trends(self):
        supervisor = _supervisor()
        a = _start(supervisor, camera="cam_1")
        b = _start(supervisor, camera="cam_2")
        self.assertIsNot(a._health, b._health)
        supervisor.govern()
        self.assertIsNot(a.health, b.health)
        self.assertNotEqual(a.health.identity.session_id, b.health.identity.session_id)

    def test_one_tenants_journal_is_invisible_to_another(self):
        journal = DiagnosticsJournal()
        supervisor = _supervisor(journal=journal)
        runner = _start(supervisor)
        self.assertEqual(supervisor.timeline("tnt_a", runner.identity.session_id) != [], True)
        from errors import NotFound

        with self.assertRaises(NotFound):
            supervisor.timeline("tnt_b", runner.identity.session_id)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
