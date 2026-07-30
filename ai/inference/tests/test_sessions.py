"""Inference Session tests (P2-2 G-3) — deterministic state machine, heartbeat, health derivation,
tenant isolation. No camera. Covers all 7 states + the 5 control actions + fail + heartbeat."""

import itertools
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from errors import Conflict, NotFound, ValidationError  # noqa: E402
from sessions import SessionManager  # noqa: E402


def _fixed_clock(step=1.0, start=1_800_000_000.0):
    t = [start]

    def clock():
        v = t[0]
        t[0] += step
        return v

    return clock


def _ids():
    seq = itertools.count(1)
    return lambda: f"ses_{next(seq)}"


class SessionLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mgr = SessionManager(clock=_fixed_clock(), id_gen=_ids())

    def _start(self):
        return self.mgr.start("tnt_a", camera_id="cam_1", capability_id="perception.person-detection", engine="onnx", model_version="1.0.0")

    def test_start_drives_created_starting_running(self) -> None:
        s = self._start()
        self.assertEqual(s.state, "running")
        self.assertIsNotNone(s.started_at)
        states = [t.to_dict()["to"] for t in s.history]
        self.assertEqual(states, ["created", "starting", "running"])
        d = s.to_dict()
        self.assertEqual(d["engine"], "onnx")
        self.assertEqual(d["modelVersion"], "1.0.0")

    def test_pause_resume_stop(self) -> None:
        s = self._start()
        self.assertEqual(self.mgr.pause("tnt_a", s.session_id).state, "paused")
        self.assertEqual(self.mgr.resume("tnt_a", s.session_id).state, "running")
        self.assertEqual(self.mgr.stop("tnt_a", s.session_id).state, "stopped")

    def test_restart_from_stopped_and_failed(self) -> None:
        s = self._start()
        self.mgr.stop("tnt_a", s.session_id)
        restarted = self.mgr.restart("tnt_a", s.session_id)
        self.assertEqual(restarted.state, "running")
        # transient restarting recorded
        self.assertIn("restarting", [t.to_dict()["to"] for t in restarted.history])
        self.mgr.fail("tnt_a", s.session_id, "gpu oom")
        self.assertEqual(self.mgr.require("tnt_a", s.session_id).state, "failed")
        self.assertEqual(self.mgr.restart("tnt_a", s.session_id).state, "running")

    def test_illegal_transition_conflicts(self) -> None:
        s = self._start()
        with self.assertRaises(Conflict):
            self.mgr.resume("tnt_a", s.session_id)  # resume only from paused

    def test_fail_only_from_active_states(self) -> None:
        s = self._start()
        self.mgr.stop("tnt_a", s.session_id)
        with self.assertRaises(Conflict):
            self.mgr.fail("tnt_a", s.session_id, "x")  # cannot fail a stopped session

    def test_heartbeat_updates_and_carries_metrics(self) -> None:
        s = self._start()
        beat = self.mgr.heartbeat("tnt_a", s.session_id, metrics={"fps": 12})
        self.assertIsNotNone(beat.last_heartbeat)
        self.assertEqual(beat.metrics, {"fps": 12})
        self.mgr.pause("tnt_a", s.session_id)
        with self.assertRaises(Conflict):
            self.mgr.heartbeat("tnt_a", s.session_id)  # only running sessions heartbeat

    def test_start_requires_camera_and_capability(self) -> None:
        with self.assertRaises(ValidationError):
            self.mgr.start("tnt_a", camera_id="", capability_id="x")

    def test_tenant_isolation(self) -> None:
        s = self._start()
        self.assertIsNone(self.mgr.get("tnt_b", s.session_id))
        with self.assertRaises(NotFound):
            self.mgr.stop("tnt_b", s.session_id)


class SessionHealthTests(unittest.TestCase):
    def test_health_derivation(self) -> None:
        const = 1_800_000_000.0
        mgr = SessionManager(clock=lambda: const, id_gen=_ids())
        s = mgr.start("tnt_a", camera_id="cam_1", capability_id="perception.person-detection")
        # running, no heartbeat yet → degraded
        self.assertEqual(s.health(), "degraded")
        mgr.heartbeat("tnt_a", s.session_id)
        self.assertEqual(s.health(now=const + 10, timeout_s=30), "healthy")
        self.assertEqual(s.health(now=const + 40, timeout_s=30), "degraded")  # stale
        mgr.pause("tnt_a", s.session_id)
        self.assertEqual(s.health(), "degraded")
        mgr.resume("tnt_a", s.session_id)
        mgr.stop("tnt_a", s.session_id)
        self.assertEqual(s.health(), "down")

    def test_created_is_unknown(self) -> None:
        from sessions import InferenceSession

        s = InferenceSession(
            session_id="ses_x",
            tenant_id="tnt_a",
            camera_id="cam_1",
            capability_id="perception.person-detection",
            state="created",
            created_at="2026-07-30T00:00:00.000Z",
            updated_at="2026-07-30T00:00:00.000Z",
        )
        self.assertEqual(s.health(), "unknown")


if __name__ == "__main__":
    unittest.main()
