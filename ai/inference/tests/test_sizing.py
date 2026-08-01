"""AI-5e hardware sizing tests.

Sizing is arithmetic over the runtime's own cost model, so most of what matters is that it stays
honest about *where the numbers came from*: an unmeasured recommendation must be marked as an
estimate, and a box that only fits at 95% must be reported as not fitting, because the reconnect storm
after a site power cut is exactly when there is no headroom left to find.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sizing import (  # noqa: E402
    DEFAULT_HEADROOM_PERCENT,
    REFERENCE_HARDWARE,
    SizingRequest,
    per_camera_units,
    recommend,
    render_table,
    sizing_table,
    workload_multiplier,
)


class WorkloadTest(unittest.TestCase):
    def test_no_workload_costs_nothing_extra(self):
        self.assertEqual(workload_multiplier([]), 1.0)

    def test_behaviours_accumulate(self):
        self.assertGreater(workload_multiplier(["loitering", "queue"]), workload_multiplier(["queue"]))

    def test_an_unknown_analyzer_costs_the_generic_rate_not_zero(self):
        """An unrecognised analyzer is still an analyzer. Sizing it at zero is the error that
        produces an under-specified box."""
        self.assertGreater(workload_multiplier(["something-new"]), 1.0)

    def test_the_expensive_behaviours_cost_more(self):
        self.assertGreater(workload_multiplier(["violence"]), workload_multiplier(["zones"]))


class CostTest(unittest.TestCase):
    def test_cost_is_linear_in_frame_rate(self):
        low, _ = per_camera_units(target_fps=5.0, workload=[])
        high, _ = per_camera_units(target_fps=10.0, workload=[])
        self.assertAlmostEqual(high, low * 2, places=4)

    def test_an_accelerator_costs_less_than_a_cpu(self):
        cpu, _ = per_camera_units(target_fps=5.0, workload=[], kind="cpu")
        cuda, _ = per_camera_units(target_fps=5.0, workload=[], kind="cuda")
        self.assertLess(cuda, cpu)

    def test_without_a_benchmark_the_figure_is_not_measured(self):
        _, measured = per_camera_units(target_fps=5.0, workload=[])
        self.assertFalse(measured)

    def test_with_a_benchmark_the_figure_is_measured(self):
        benchmark = {
            "id": "bench_1",
            "workload": {"cameras": 4, "targetFps": 5.0},
            "kpis": {"fps": 5.0},
        }
        _, measured = per_camera_units(target_fps=5.0, workload=[], benchmark=benchmark)
        self.assertTrue(measured)

    def test_a_box_that_fell_short_of_its_target_costs_more_per_camera(self):
        # A box that sustained 3 of a requested 5 fps costs 5/3 as much per camera. Ignoring that is
        # how a site gets sized on a benchmark it never actually met.
        met = {"id": "b", "workload": {"cameras": 4, "targetFps": 5.0}, "kpis": {"fps": 5.0}}
        short = {"id": "b", "workload": {"cameras": 4, "targetFps": 5.0}, "kpis": {"fps": 3.0}}
        met_units, _ = per_camera_units(target_fps=5.0, workload=[], benchmark=met)
        short_units, _ = per_camera_units(target_fps=5.0, workload=[], benchmark=short)
        self.assertGreater(short_units, met_units)


class RecommendationTest(unittest.TestCase):
    def _rec(self, cameras, **kw):
        return recommend(SizingRequest(profile="retail-store", cameras=cameras, **kw))

    def test_a_small_site_fits_the_smallest_class(self):
        row = self._rec(4)
        self.assertTrue(row["feasible"])
        self.assertGreaterEqual(row["headroomPercent"], DEFAULT_HEADROOM_PERCENT)

    def test_more_cameras_need_more_capacity(self):
        self.assertGreater(
            self._rec(32)["requiredCapacityUnits"], self._rec(8)["requiredCapacityUnits"]
        )

    def test_a_recommendation_with_no_benchmark_is_marked_as_an_estimate(self):
        """Nobody should quote a catalogue default to a customer as if it were a measurement."""
        row = self._rec(8)
        self.assertTrue(row["estimated"])
        self.assertNotIn("basis", row)
        self.assertIn("not measured", row["rationale"])

    def test_headroom_below_target_means_infeasible_not_a_tight_fit(self):
        # There has to be room for every camera reconnecting at once after a power cut.
        row = self._rec(4, headroom_percent=99.0)
        self.assertFalse(row["feasible"])
        self.assertIn("below the 99% target", row["rationale"])

    def test_a_developer_laptop_is_never_recommended(self):
        for cameras in (1, 4, 8, 16, 32):
            self.assertNotEqual(self._rec(cameras)["recommendedClass"], "dev-laptop")

    def test_a_laptop_is_used_when_it_is_the_only_class_allowed(self):
        row = self._rec(2, allowed_classes=["dev-laptop"])
        self.assertEqual(row["recommendedClass"], "dev-laptop")

    def test_an_impossible_site_returns_the_closest_answer_marked_infeasible(self):
        row = self._rec(5000)
        self.assertFalse(row["feasible"])
        self.assertIn("rationale", row)

    def test_a_measured_recommendation_names_its_basis(self):
        benchmark = {
            "id": "bench_baseline_1",
            "workload": {"cameras": 4, "targetFps": 5.0},
            "kpis": {"fps": 5.0},
        }
        row = recommend(SizingRequest(profile="retail-store", cameras=8), benchmark=benchmark)
        self.assertFalse(row["estimated"])
        self.assertEqual(row["basis"], "bench_baseline_1")
        self.assertIn("measured benchmark", row["rationale"])

    def test_the_workload_is_echoed_so_a_quote_records_what_it_assumed(self):
        row = self._rec(8, workload=["loitering", "queue"])
        self.assertEqual(row["workload"], ["loitering", "queue"])

    def test_every_reference_class_declares_its_capacity(self):
        for hardware in REFERENCE_HARDWARE:
            self.assertGreater(hardware.capacity_units, 0)
            self.assertTrue(hardware.label)


class TableTest(unittest.TestCase):
    def test_the_table_covers_the_standard_camera_counts(self):
        rows = sizing_table("retail-store")
        self.assertEqual([r["cameras"] for r in rows], [4, 8, 16, 24, 32, 48, 64])

    def test_the_table_prints_whether_each_row_was_measured(self):
        text = render_table(sizing_table("retail-store"))
        self.assertIn("estimate", text)
        self.assertIn("headroom", text)


if __name__ == "__main__":
    unittest.main()
