"""AI-5c — Scheduler simulation at 4 / 8 / 16 / 32 cameras (Architect rec 7).

These are the load tests that would otherwise need 32 cameras and a saturated box. They drive the
REAL scheduler/admission/governor against synthetic arrivals, so the properties that only appear under
contention — fairness, starvation-freedom, refusal-instead-of-collapse — are asserted in CI.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scheduler import SchedulerPolicy
from scheduler_sim import STANDARD_SIMULATION_SIZES, simulate, standard_suite


class SimulationSweepTest(unittest.TestCase):
    def test_covers_the_four_requested_camera_counts(self):
        self.assertEqual(STANDARD_SIMULATION_SIZES, (4, 8, 16, 32))

    def test_no_session_is_ever_starved_at_any_scale(self):
        # The single most important scheduler property: contention must never silence a camera.
        for result in standard_suite(ticks=200):
            self.assertEqual(
                result.starved_sessions,
                [],
                f"{result.cameras} cameras starved: {result.starved_sessions}",
            )

    def test_throughput_does_not_collapse_as_cameras_scale(self):
        # Regression guard: an early version suspended every session under sustained overload, which
        # dropped fleet throughput to a third. Serving *something* every tick is the invariant.
        for result in standard_suite(ticks=200):
            served = sum(result.served.values())
            self.assertGreaterEqual(
                served, 190, f"{result.cameras} cameras served only {served}/200 ticks"
            )

    def test_admission_refuses_rather_than_overcommitting(self):
        # 32 cameras on 8 units of compute: the runtime must refuse, not accept and fail everyone.
        result = simulate(32, ticks=50, capacity_units=8.0, max_sessions=32)
        self.assertGreater(result.refused, 0)
        self.assertLessEqual(result.admitted, 32)
        self.assertGreater(result.admitted, 0)

    def test_results_are_byte_identical_across_runs(self):
        first = simulate(8, ticks=100).to_dict()
        second = simulate(8, ticks=100).to_dict()
        self.assertEqual(first, second)  # deterministic: no wall-clock, no randomness


class SimulationBehaviorTest(unittest.TestCase):
    def test_busy_cameras_do_not_starve_quiet_ones(self):
        result = simulate(8, ticks=300, busy_fraction=0.25, busy_arrival=5.0, idle_arrival=0.2)
        shares = result.fairness["shares"]
        served = [count for count in shares.values() if count > 0]
        self.assertEqual(len(shares), result.admitted)
        self.assertTrue(all(count > 0 for count in shares.values()), shares)
        # No session may take more than a small multiple of the least-served one.
        self.assertLess(max(served) / max(1, min(served)), 8.0)

    def test_sustained_overload_degrades_rather_than_failing(self):
        result = simulate(16, ticks=300, busy_fraction=1.0, busy_arrival=5.0, queue_capacity=8)
        self.assertGreater(len(result.degradations), 0)
        # Degradation, not failure: sessions are still being served at the end.
        self.assertGreater(sum(result.served.values()), 0)

    def test_priorities_shape_the_share_under_contention(self):
        result = simulate(
            4, ticks=400, priorities=["critical", "low", "low", "low"], busy_fraction=1.0,
            busy_arrival=4.0, capacity_units=16.0,
        )
        shares = result.fairness["shares"]
        self.assertGreater(shares["ses_0"], shares["ses_1"])  # critical outruns low
        self.assertGreater(shares["ses_1"], 0)  # but low is never starved

    def test_a_generous_box_degrades_nobody(self):
        result = simulate(4, ticks=200, capacity_units=64.0, busy_fraction=0.0, idle_arrival=0.2)
        self.assertEqual(result.degradations, [])
        self.assertEqual(result.refused, 0)

    def test_report_shape_is_reviewable(self):
        report = simulate(4, ticks=50).to_dict()
        for key in ("cameras", "ticks", "admitted", "refused", "servedTotal", "fairness", "scheduler"):
            self.assertIn(key, report)

    def test_strict_priority_still_serves_low_priority_sessions(self):
        policy = SchedulerPolicy(
            strategy="strict-priority", max_consecutive_per_session=2, reserved_capacity_percent=0.0
        )
        result = simulate(
            4, ticks=300, policy=policy, priorities=["critical", "low", "low", "low"],
            busy_fraction=1.0, busy_arrival=4.0, capacity_units=16.0,
        )
        self.assertEqual(result.starved_sessions, [])


if __name__ == "__main__":
    unittest.main()
