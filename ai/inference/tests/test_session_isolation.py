"""AI-5c — Formal verification of session isolation (Architect refinement 7).

The requirement: **every session must own its own queue, tracking state, behavior state, temporal
windows, metrics, configuration and connection state, with no mutable cross-session state.**

This is the property that makes multi-camera safe. If two sessions shared a tracker, camera A's
detections would become camera B's tracks — a correctness failure that would surface as impossible
analytics rather than as a crash, which is precisely the kind of bug that survives to production.

The tests below verify isolation two ways:
  1. **Structurally** — the objects backing each concern are distinct instances per session.
  2. **Behaviourally** — running two sessions produces state in one that never appears in the other,
     including under a deliberate cross-tenant collision of camera ids.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import ComputeRegistry, ComputeResource
from operational_log import SessionIdentity
from playground import build_adapter
from resources import ResourceAccountant
from scheduler import InferenceScheduler, SchedulerPolicy
from session_runner import LiveSessionConfig, SessionSupervisor
from sessions import SessionManager
from stream_pipeline import PipelineOptions
from video_analyzer import AnalyzeOptions, VideoAnalyzer


def _options(tenant="tnt_a", camera="cam_1", session="ses_1") -> AnalyzeOptions:
    return AnalyzeOptions(
        tenant_id=tenant, camera_id=camera, session_id=session, min_confidence=0.3
    )


def _config(frames: int = 12, capacity: int = 8) -> LiveSessionConfig:
    return LiveSessionConfig(
        source={"type": "simulated", "uri": "sim://cam", "options": {"totalFrames": frames}},
        analyze=_options(),
        pipeline=PipelineOptions(queue_capacity=capacity, target_fps=5.0, source_fps=30.0),
    )


def _supervisor(*, scheduled: bool = False, max_sessions: int = 8) -> SessionSupervisor:
    manager = SessionManager()
    if not scheduled:
        return SessionSupervisor(manager, max_sessions=max_sessions)
    registry = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=64.0)])
    scheduler = InferenceScheduler(
        registry,
        ResourceAccountant(),
        policy=SchedulerPolicy(reserved_capacity_percent=0.0),
        max_sessions=max_sessions,
    )
    return SessionSupervisor(manager, max_sessions=max_sessions, scheduler=scheduler)


def _start(supervisor, *, tenant="tnt_a", camera="cam_1", frames=12, priority="normal"):
    options = _options(tenant=tenant, camera=camera)
    return supervisor.start(
        tenant,
        camera_id=camera,
        capability_id="playground.detect",
        config=_config(frames=frames),
        analyzer=VideoAnalyzer(build_adapter("stub"), options),
        log_sink=lambda _record: None,
        priority=priority,
    )


class StructuralIsolationTest(unittest.TestCase):
    """Each session's state-bearing objects must be distinct instances."""

    def test_every_owned_concern_is_a_distinct_instance(self):
        supervisor = _supervisor()
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")

        # queue · connection · pipeline · analyzer · sampler
        self.assertIsNot(a._pipeline, b._pipeline)
        self.assertIsNot(a._pipeline.queue, b._pipeline.queue)
        self.assertIsNot(a._supervisor, b._supervisor)
        self.assertIsNot(a._source, b._source)
        self.assertIsNot(a._analyzer, b._analyzer)
        self.assertIsNot(a._pipeline._sampler, b._pipeline._sampler)
        # configuration · identity · logging
        self.assertIsNot(a._config, b._config)
        self.assertIsNot(a.identity, b.identity)
        self.assertIsNot(a._log, b._log)

    def test_tracking_behavior_and_temporal_window_state_are_per_session(self):
        supervisor = _supervisor()
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")
        # The analyzer owns tracking/behavior/window state; distinct analyzers ⇒ distinct state.
        self.assertIsNot(a._analyzer._manager, b._analyzer._manager)
        self.assertIsNot(a._analyzer._behavior_store, b._analyzer._behavior_store)
        self.assertIsNot(a._analyzer._windows, b._analyzer._windows)
        self.assertIsNot(a._analyzer._composite_store, b._analyzer._composite_store)
        self.assertIsNot(a._analyzer._timings, b._analyzer._timings)

    def test_metrics_and_accounts_are_per_session(self):
        supervisor = _supervisor(scheduled=True)
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")
        self.assertIsNot(a.account, b.account)
        self.assertIsNot(a.account.queue_trend, b.account.queue_trend)
        self.assertIsNot(a.metrics(), b.metrics())

    def test_the_governor_is_shared_but_holds_no_per_session_mutable_state(self):
        # The governor is stateless w.r.t. sessions: it reads the account it is HANDED and writes only
        # to that account, so sharing the instance shares no session state.
        supervisor = _supervisor(scheduled=True)
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")
        self.assertIs(a._governor, b._governor)  # shared instance…
        a.account.degradation = "reduced-fps"
        self.assertEqual(b.account.degradation, "none")  # …but no shared state


class BehaviouralIsolationTest(unittest.TestCase):
    """Running sessions must not leak observable state into one another."""

    def test_work_in_one_session_never_appears_in_another(self):
        supervisor = _supervisor(scheduled=True)
        busy = _start(supervisor, camera="cam_busy", frames=24)
        idle = _start(supervisor, camera="cam_idle", frames=0)

        self.assertGreater(busy.metrics()["framesProcessed"], 0)
        self.assertEqual(idle.metrics()["framesProcessed"], 0)
        self.assertEqual(idle.account.frames_processed, 0)
        self.assertEqual(idle._pipeline.queue.dropped, 0)

    def test_degrading_one_session_leaves_the_others_untouched(self):
        supervisor = _supervisor(scheduled=True)
        runners = [_start(supervisor, camera=f"cam_{i}") for i in range(3)]
        target = runners[0]
        for _ in range(10):
            supervisor._scheduler.governor.observe(target.account, queue_utilization=99.0)
        self.assertNotEqual(target.account.degradation, "none")
        for other in runners[1:]:
            self.assertEqual(other.account.degradation, "none")
            self.assertFalse(other.paused)

    def test_stopping_one_session_does_not_disturb_the_others(self):
        # NOTE: under the synchronous executor both finite sources run to completion at start, so B's
        # pipeline is already closed by its OWN completion. What isolation requires is that stopping A
        # changes nothing observable about B — its work, its account, and its registration all stand.
        supervisor = _supervisor(scheduled=True)
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")
        before_frames = b.metrics()["framesProcessed"]
        before_degradation = b.account.degradation

        supervisor.stop("tnt_a", a.identity.session_id)

        self.assertTrue(a._pipeline.closed)
        self.assertEqual(b.metrics()["framesProcessed"], before_frames)
        self.assertEqual(b.account.degradation, before_degradation)
        self.assertIsNotNone(supervisor.get("tnt_a", b.identity.session_id))
        self.assertIsNone(supervisor.get("tnt_a", a.identity.session_id))

    def test_identical_camera_ids_in_different_tenants_stay_separate(self):
        # The nastiest collision: same camera id, different tenants.
        supervisor = _supervisor(scheduled=True)
        a = _start(supervisor, tenant="tnt_a", camera="cam_1", frames=20)
        b = _start(supervisor, tenant="tnt_b", camera="cam_1", frames=0)

        self.assertNotEqual(a.identity.session_id, b.identity.session_id)
        self.assertGreater(a.account.frames_processed, 0)
        self.assertEqual(b.account.frames_processed, 0)
        # Neither tenant can see the other's session.
        self.assertIsNone(supervisor.get("tnt_b", a.identity.session_id))
        self.assertIsNone(supervisor.get("tnt_a", b.identity.session_id))
        self.assertEqual(len(supervisor.sla("tnt_a")), 1)
        self.assertEqual(len(supervisor.sla("tnt_b")), 1)

    def test_accounts_are_tenant_qualified_so_ids_cannot_collide(self):
        accountant = ResourceAccountant()
        a = SessionIdentity("tnt_a", "cam_1", "ses_1")
        b = SessionIdentity("tnt_b", "cam_1", "ses_1")  # same session id, different tenant
        accountant.open(a, target_fps=5.0)
        accountant.open(b, target_fps=9.0)
        self.assertEqual(accountant.count, 2)  # not overwritten
        self.assertEqual(accountant.get(a).target_fps, 5.0)
        self.assertEqual(accountant.get(b).target_fps, 9.0)

    def test_closing_a_session_releases_only_its_own_state(self):
        supervisor = _supervisor(scheduled=True)
        a = _start(supervisor, camera="cam_a")
        b = _start(supervisor, camera="cam_b")
        accountant = supervisor._scheduler_accountant
        self.assertEqual(accountant.count, 2)
        supervisor.stop("tnt_a", a.identity.session_id)
        self.assertEqual(accountant.count, 1)
        self.assertIsNotNone(accountant.get(b.identity))

    def test_shutdown_leaves_no_state_behind_for_any_session(self):
        supervisor = _supervisor(scheduled=True)
        runners = [_start(supervisor, camera=f"cam_{i}") for i in range(4)]
        supervisor.shutdown()
        self.assertEqual(supervisor.active_count, 0)
        self.assertEqual(supervisor._scheduler_accountant.count, 0)
        for runner in runners:
            self.assertTrue(runner._pipeline.closed)
            self.assertEqual(runner._pipeline.queue.depth, 0)
        # And all compute is back.
        registry = supervisor._scheduler._registry
        self.assertAlmostEqual(registry.free_capacity, registry.total_capacity, places=6)


if __name__ == "__main__":
    unittest.main()
