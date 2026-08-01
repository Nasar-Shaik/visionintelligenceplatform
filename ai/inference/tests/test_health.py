"""Health monitoring (AI-5d) — scoring, decomposition, projection, and what health must NOT do.

The load-bearing assertions here are the negative ones: health must not conflate sampling with loss,
must not invent readings it does not have, must not contradict lifecycle state, and must not degrade
anything by itself.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from compute import ResourceSnapshot  # noqa: E402
from errors import ConfigurationFailure  # noqa: E402
from health import (  # noqa: E402
    HEALTH_COMPONENTS,
    INDICATOR_COMPONENTS,
    HealthMonitor,
    HealthPolicy,
)
from operational_log import SessionIdentity  # noqa: E402
from resources import SessionAccount  # noqa: E402


def _identity(index: int = 0) -> SessionIdentity:
    return SessionIdentity("tnt_a", f"cam_{index}", f"ses_{index}", correlation_id="corr_1")


def _account(**kwargs) -> SessionAccount:
    account = SessionAccount(identity=_identity(), target_fps=5.0)
    for key, value in kwargs.items():
        setattr(account, key, value)
    return account


def _monitor(**policy_kwargs) -> HealthMonitor:
    return HealthMonitor(
        _identity(), policy=HealthPolicy(**policy_kwargs), now_iso=lambda: "2026-08-01T00:00:00.000Z"
    )


class HealthScoringTest(unittest.TestCase):
    def test_a_perfectly_healthy_session_scores_100(self):
        monitor = _monitor()
        score = monitor.observe(
            account=_account(frames_processed=100, effective_fps=5.0, inference_ms_total=100.0),
            ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
            backpressure={"queueUtilization": 0.0, "framesProcessed": 100, "framesDropped": 0},
        )
        self.assertEqual(score.score, 100.0)
        self.assertEqual(score.status, "healthy")

    def test_every_component_is_always_reported(self):
        # Rec 2: a health report that omits a subsystem is the report that sends someone looking in
        # the wrong place. Even with no inputs at all, all five components must appear.
        score = _monitor().observe()
        self.assertEqual(set(score.components), set(HEALTH_COMPONENTS))

    def test_component_scores_localize_the_problem(self):
        # The Architect's example: overall 83 is not actionable; "connection 98, scheduler 76" is.
        monitor = _monitor()
        score = monitor.observe(
            account=_account(frames_processed=100, effective_fps=5.0),
            ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
            backpressure={"queueUtilization": 90.0, "framesProcessed": 100, "framesDropped": 40},
        )
        self.assertEqual(score.weakest_component, "scheduler")
        self.assertEqual(score.component("connection"), 100.0)
        self.assertLess(score.component("scheduler"), score.component("connection"))

    def test_every_indicator_maps_to_a_declared_component(self):
        self.assertEqual(set(INDICATOR_COMPONENTS.values()), set(HEALTH_COMPONENTS))

    def test_reconnects_degrade_only_the_connection_component(self):
        score = _monitor().observe(
            account=_account(frames_processed=10, effective_fps=5.0),
            ingestion={"availabilityPercent": 60.0, "reconnectCount": 2},
            backpressure={"queueUtilization": 0.0, "framesProcessed": 10, "framesDropped": 0},
        )
        self.assertLess(score.component("connection"), 70.0)
        self.assertEqual(score.component("recovery"), 100.0)
        self.assertEqual(score.component("resources"), 100.0)

    def test_an_absent_reading_is_not_treated_as_a_bad_one(self):
        # A box with no GPU probe must not be reported as unhealthy for lacking a GPU.
        score = _monitor().observe(snapshot=ResourceSnapshot(cpu_percent=None, memory_mb=None))
        self.assertEqual(score.component("resources"), 100.0)

    def test_cpu_pressure_lowers_only_the_resources_component(self):
        score = _monitor().observe(snapshot=ResourceSnapshot(cpu_percent=95.0))
        self.assertAlmostEqual(score.component("resources"), 5.0, places=3)


class SamplingIsNotLossTest(unittest.TestCase):
    """The AI-5b distinction, enforced in health: skipped ≠ dropped."""

    def test_sampled_away_frames_do_not_reduce_health(self):
        # 900 frames deliberately sampled away, zero lost. This is a correctly configured 0.5-fps
        # camera, not a sick one — scoring it as sick would make operators raise the FPS to look good.
        score = _monitor().observe(
            account=_account(frames_processed=100, effective_fps=5.0),
            ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
            backpressure={
                "queueUtilization": 0.0,
                "framesProcessed": 100,
                "framesSkipped": 900,
                "framesDropped": 0,
            },
        )
        loss = next(i for i in score.indicators if i.name == "frame-loss")
        self.assertEqual(loss.score, 100.0)
        self.assertEqual(loss.measured, 0.0)

    def test_genuinely_dropped_frames_do_reduce_health(self):
        score = _monitor().observe(
            account=_account(frames_processed=50, effective_fps=5.0),
            backpressure={"queueUtilization": 0.0, "framesProcessed": 50, "framesDropped": 50},
        )
        loss = next(i for i in score.indicators if i.name == "frame-loss")
        self.assertEqual(loss.measured, 50.0)
        self.assertEqual(loss.score, 50.0)


class PredictiveHealthTest(unittest.TestCase):
    """Rec 1: report where health is HEADING, not only where it is."""

    def _decline(self, monitor, utilizations):
        score = None
        for utilization in utilizations:
            score = monitor.observe(
                account=_account(frames_processed=100, effective_fps=5.0),
                ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
                backpressure={
                    "queueUtilization": utilization,
                    "framesProcessed": 100,
                    "framesDropped": 0,
                },
            )
        return score

    def test_a_declining_trend_is_reported_while_still_healthy(self):
        monitor = _monitor(degraded_below=80.0, projection_horizon_samples=3)
        score = self._decline(monitor, (0.0, 20.0, 40.0, 60.0))
        self.assertEqual(score.status, "healthy")
        self.assertEqual(score.trend, "deteriorating")
        self.assertLess(score.projected_score, score.score)

    def test_a_projected_crossing_sets_predicted_decline(self):
        # The rec-1 signal itself: the CURRENT score is still healthy, but the projection is not — so
        # the governor gets told while there is still headroom to act.
        monitor = _monitor(degraded_below=95.0, projection_horizon_samples=3)
        score = self._decline(monitor, (0.0, 20.0, 40.0, 60.0))
        self.assertEqual(score.status, "healthy")
        self.assertTrue(score.predicted_decline)
        self.assertLess(score.projected_score, monitor.policy.degraded_below)

    def test_a_steady_session_never_predicts_a_decline(self):
        monitor = _monitor()
        score = None
        for _ in range(6):
            score = monitor.observe(
                account=_account(frames_processed=100, effective_fps=5.0),
                ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
                backpressure={"queueUtilization": 10.0, "framesProcessed": 100, "framesDropped": 0},
            )
        self.assertFalse(score.predicted_decline)
        self.assertEqual(score.trend, "stable")

    def test_prediction_can_be_switched_off_by_policy(self):
        monitor = _monitor(predictive_degradation=False)
        score = None
        for utilization in (0.0, 20.0, 40.0, 60.0):
            score = monitor.observe(
                backpressure={"queueUtilization": utilization, "framesProcessed": 1, "framesDropped": 0}
            )
        self.assertFalse(score.predicted_decline)

    def test_a_single_sample_is_never_a_prediction(self):
        score = _monitor().observe(backpressure={"queueUtilization": 99.0})
        self.assertFalse(score.predicted_decline)
        self.assertEqual(score.samples, 1)


class StateAlwaysWinsTest(unittest.TestCase):
    """The score explains WHY a session is unwell; it never claims a stopped session is healthy."""

    def test_a_stopped_session_is_down_at_any_score(self):
        monitor = _monitor()
        score = monitor.observe(
            account=_account(frames_processed=100, effective_fps=5.0),
            ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
            backpressure={"queueUtilization": 0.0, "framesProcessed": 100, "framesDropped": 0},
        )
        self.assertEqual(score.status, "healthy")
        self.assertEqual(monitor.reconcile(score, "stopped").status, "down")

    def test_a_failed_session_is_down(self):
        monitor = _monitor()
        score = monitor.observe()
        self.assertEqual(monitor.reconcile(score, "failed").status, "down")

    def test_a_created_session_is_unknown(self):
        monitor = _monitor()
        score = monitor.observe()
        self.assertEqual(monitor.reconcile(score, "created").status, "unknown")

    def test_a_running_session_keeps_its_scored_status(self):
        monitor = _monitor()
        score = monitor.observe(backpressure={"queueUtilization": 0.0})
        self.assertEqual(monitor.reconcile(score, "running").status, score.status)


class StabilizationTest(unittest.TestCase):
    """Rec 6 input: a session that has just recovered has not proven anything yet."""

    def test_health_is_not_stabilized_until_the_streak_is_met(self):
        monitor = _monitor(stabilization_samples=3)
        for index in range(2):
            monitor.observe(backpressure={"queueUtilization": 0.0})
            self.assertFalse(monitor.stabilized, f"stabilized after only {index + 1} sample(s)")
        monitor.observe(backpressure={"queueUtilization": 0.0})
        self.assertTrue(monitor.stabilized)

    def test_one_bad_observation_resets_the_streak(self):
        monitor = _monitor(stabilization_samples=2, degraded_below=80.0)
        monitor.observe(backpressure={"queueUtilization": 0.0})
        monitor.observe(backpressure={"queueUtilization": 0.0})
        self.assertTrue(monitor.stabilized)
        # Genuinely bad across several components — one weak indicator cannot (and should not) drag
        # a five-component composite below its threshold on its own.
        monitor.observe(
            account=_account(frames_processed=1, effective_fps=0.0, degradation="shedding-frames"),
            ingestion={"availabilityPercent": 10.0, "reconnectCount": 4},
            backpressure={"queueUtilization": 100.0, "framesProcessed": 1, "framesDropped": 99},
        )
        self.assertFalse(monitor.stabilized)

    def test_reset_forgets_a_previous_session_entirely(self):
        monitor = _monitor()
        monitor.observe(backpressure={"queueUtilization": 90.0})
        monitor.reset()
        self.assertEqual(monitor.samples, 0)
        self.assertIsNone(monitor.last)


class HealthPolicyTest(unittest.TestCase):
    def test_thresholds_must_be_ordered(self):
        with self.assertRaises(ConfigurationFailure):
            HealthPolicy(degraded_below=40.0, unhealthy_below=60.0)

    def test_an_unknown_component_weight_is_rejected_at_load(self):
        with self.assertRaises(ConfigurationFailure):
            HealthPolicy(component_weights={"networking": 2.0})

    def test_weights_shift_the_composite(self):
        inputs = dict(
            account=_account(frames_processed=100, effective_fps=5.0),
            ingestion={"availabilityPercent": 20.0, "reconnectCount": 4},
            backpressure={"queueUtilization": 0.0, "framesProcessed": 100, "framesDropped": 0},
        )
        even = _monitor().observe(**inputs)
        weighted = _monitor(component_weights={"connection": 10.0}).observe(**inputs)
        self.assertLess(weighted.score, even.score)

    def test_status_thresholds_are_policy(self):
        strict = HealthPolicy(degraded_below=95.0, unhealthy_below=60.0)
        self.assertEqual(strict.status_for(90.0), "degraded")
        self.assertEqual(HealthPolicy().status_for(90.0), "healthy")


class HealthShapeTest(unittest.TestCase):
    """`to_dict()` must mirror the @vip/contracts `HealthScore` camelCase shape."""

    def test_score_serializes_to_the_contract_shape(self):
        score = _monitor().observe(
            account=_account(frames_processed=10, effective_fps=5.0),
            backpressure={"queueUtilization": 10.0, "framesProcessed": 10, "framesDropped": 0},
        )
        out = score.to_dict()
        for key in ("identity", "score", "status", "components", "indicators", "trend", "samples"):
            self.assertIn(key, out)
        self.assertEqual(set(out["components"]), set(HEALTH_COMPONENTS))
        indicator = out["indicators"][0]
        for key in ("name", "component", "score", "trend", "weight"):
            self.assertIn(key, indicator)
        self.assertEqual(out["identity"]["correlationId"], "corr_1")



class ComponentTrendTest(unittest.TestCase):
    """AI-5d follow-up rec 2: operators care more about the shape than about a single value."""

    def _observe(self, monitor, utilization):
        return monitor.observe(
            account=_account(frames_processed=100, effective_fps=5.0),
            ingestion={"availabilityPercent": 100.0, "reconnectCount": 0},
            backpressure={
                "queueUtilization": utilization,
                "framesProcessed": 100,
                "framesDropped": 0,
            },
        )

    def test_every_component_carries_a_rolling_history(self):
        monitor = _monitor(trend_window_samples=5)
        score = None
        for utilization in (0.0, 20.0, 40.0):
            score = self._observe(monitor, utilization)
        self.assertEqual(set(score.component_trends), set(HEALTH_COMPONENTS))
        self.assertEqual(len(score.component_trends["scheduler"]), 3)

    def test_the_history_is_oldest_first_and_shows_the_decline(self):
        monitor = _monitor()
        for utilization in (0.0, 20.0, 40.0, 60.0):
            score = self._observe(monitor, utilization)
        scheduler = score.component_trends["scheduler"]
        self.assertEqual(scheduler, sorted(scheduler, reverse=True), "the decline is not monotonic")

    def test_the_window_is_bounded_by_policy(self):
        monitor = _monitor(trend_window_samples=3)
        score = None
        for _ in range(10):
            score = self._observe(monitor, 10.0)
        self.assertEqual(len(score.component_trends["connection"]), 3)

    def test_a_sparkline_renders_the_component_score(self):
        # The Architect's sketch: `████████░░`.
        monitor = _monitor()
        score = self._observe(monitor, 0.0)
        self.assertEqual(score.sparkline("connection", width=10), "█" * 10)
        self.assertEqual(len(score.sparkline("scheduler", width=10)), 10)

    def test_the_operator_view_names_every_component_with_a_direction(self):
        monitor = _monitor()
        for utilization in (0.0, 20.0, 40.0, 60.0):
            score = self._observe(monitor, utilization)
        rendered = score.render_components()
        self.assertEqual(len(rendered.splitlines()), len(HEALTH_COMPONENTS))
        for component in HEALTH_COMPONENTS:
            self.assertIn(component, rendered)
        self.assertIn("↓", rendered)  # the scheduler component is falling

    def test_trends_serialize_with_the_score(self):
        monitor = _monitor()
        out = self._observe(monitor, 10.0).to_dict()
        self.assertIn("componentTrends", out)
        self.assertEqual(set(out["componentTrends"]), set(HEALTH_COMPONENTS))

    def test_reset_clears_the_component_history_too(self):
        monitor = _monitor()
        self._observe(monitor, 50.0)
        monitor.reset()
        score = self._observe(monitor, 0.0)
        self.assertEqual(len(score.component_trends["scheduler"]), 1)

if __name__ == "__main__":  # pragma: no cover
    unittest.main()
