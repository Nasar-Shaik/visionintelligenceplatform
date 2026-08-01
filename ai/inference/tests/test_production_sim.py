"""Production condition simulations (AI-5d rec 7).

Every scenario the Architect named, asserted deterministically before anything touches real hardware.
Two runs must produce identical output — a non-reproducible simulation cannot gate a release.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure  # noqa: E402
from production_sim import (  # noqa: E402
    SCENARIOS,
    burst_reconnects,
    degraded_hardware,
    heterogeneous_hardware,
    intermittent_disconnects,
    mixed_priorities,
    production_suite,
    prolonged_operation,
    recovery_storm,
    repeated_model_failures,
    run_scenario,
    simultaneous_recoveries,
    summarize,
    varying_frame_rates,
)


class SuiteTest(unittest.TestCase):
    def test_every_named_condition_has_a_scenario(self):
        # The union of the Architect's AI-5c and AI-5d lists.
        expected = {
            "prolonged-operation",
            "intermittent-disconnects",
            "burst-reconnects",
            "varying-frame-rates",
            "heterogeneous-hardware",
            "mixed-priorities",
            "degraded-hardware",
            "repeated-model-failures",
            "simultaneous-recoveries",
            "recovery-storm",
        }
        self.assertEqual(set(SCENARIOS), expected)

    def test_the_whole_suite_passes(self):
        summary = summarize(production_suite())
        self.assertEqual(summary["failed"], [], f"violations: {summary['violations']}")
        self.assertEqual(summary["passed"], len(SCENARIOS))

    def test_the_suite_is_deterministic(self):
        # A simulation that differs run-to-run cannot gate a release.
        self.assertEqual(
            summarize(production_suite())["results"],
            summarize(production_suite())["results"],
        )

    def test_an_unknown_scenario_fails_fast(self):
        with self.assertRaises(ConfigurationFailure):
            run_scenario("hurricane")


class LongRunningTest(unittest.TestCase):
    def test_nothing_grows_without_bound_over_a_long_run(self):
        # The failure invisible at 200 ticks and fatal at 200,000.
        result = prolonged_operation(cameras=8, ticks=3000)
        self.assertTrue(result.passed, result.violations)
        self.assertLessEqual(result.metrics["decisionLogEntries"], 200)
        self.assertLessEqual(result.metrics["maxTrendSamples"], 5)

    def test_a_long_run_still_serves_frames(self):
        result = prolonged_operation(cameras=4, ticks=1000)
        self.assertGreater(result.metrics["served"], 0)


class ConnectionScenariosTest(unittest.TestCase):
    def test_intermittent_disconnects_are_recovered_within_budget(self):
        result = intermittent_disconnects(cameras=8, ticks=400)
        self.assertTrue(result.passed, result.violations)
        self.assertGreater(result.metrics["disconnects"], 0)
        self.assertGreater(result.metrics["recovered"], 0)

    def test_a_reconnect_burst_cannot_consume_the_reserve(self):
        # The thundering herd: if the fleet can take every last unit, the critical camera that
        # returns one tick later is refused — which is the outage the reserve exists to prevent.
        result = burst_reconnects(cameras=16)
        self.assertTrue(result.passed, result.violations)
        self.assertGreater(result.metrics["refused"], 0)
        self.assertGreater(result.metrics["reservedUnits"], 0)

    def test_a_recovery_storm_is_bounded_by_the_stabilization_window(self):
        result = recovery_storm(flaps=30)
        self.assertTrue(result.passed, result.violations)
        self.assertLess(result.metrics["restarts"], result.metrics["flaps"])
        self.assertGreater(result.metrics["deferred"], 0)


class SchedulingScenariosTest(unittest.TestCase):
    def test_varying_frame_rates_never_starve_a_camera(self):
        result = varying_frame_rates(cameras=12, ticks=600)
        self.assertTrue(result.passed, result.violations)
        self.assertGreater(result.metrics["minServed"], 0)

    def test_mixed_priorities_shape_the_share_without_starving(self):
        result = mixed_priorities(cameras=16, ticks=800)
        self.assertTrue(result.passed, result.violations)
        self.assertGreaterEqual(result.metrics["served:critical"], result.metrics["served:low"])

    def test_work_spreads_across_heterogeneous_accelerators(self):
        result = heterogeneous_hardware(cameras=12)
        self.assertTrue(result.passed, result.violations)
        placed = [k for k in result.metrics if k.startswith("placed:")]
        self.assertGreaterEqual(len(placed), 2)


class DegradationScenariosTest(unittest.TestCase):
    def test_losing_an_accelerator_degrades_rather_than_collapses(self):
        result = degraded_hardware(cameras=8, ticks=400)
        self.assertTrue(result.passed, result.violations)
        self.assertGreater(result.metrics["servedAfter"], 0)

    def test_a_permanently_broken_model_stops_being_retried(self):
        result = repeated_model_failures(attempts=20)
        self.assertTrue(result.passed, result.violations)
        self.assertLessEqual(result.metrics["restartsExecuted"], 3)
        self.assertGreater(result.metrics["outcome:budget-exhausted"], 0)

    def test_simultaneous_failures_each_spend_their_own_budget(self):
        result = simultaneous_recoveries(cameras=16)
        self.assertTrue(result.passed, result.violations)
        self.assertEqual(result.metrics["restarted"], 16)


class ScenarioResultTest(unittest.TestCase):
    def test_a_scenario_reports_every_violation_not_only_the_first(self):
        result = prolonged_operation(cameras=2, ticks=50)
        result.check(False, "first problem")
        result.check(False, "second problem")
        self.assertEqual(len(result.violations), 2)
        self.assertFalse(result.passed)

    def test_results_serialize_for_a_ci_gate(self):
        out = burst_reconnects(cameras=8).to_dict()
        for key in ("scenario", "cameras", "passed", "metrics", "violations", "notes"):
            self.assertIn(key, out)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
