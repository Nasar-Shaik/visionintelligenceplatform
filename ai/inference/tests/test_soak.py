"""AI-5e soak-framework tests.

A soak run is simulated here by advancing an injected clock, so a 72-hour run is asserted in
microseconds. That matters: the *result* of a soak needs real hours on real hardware, but the
*procedure* deserves regression tests, and a soak you cannot run in CI is a soak nobody runs.

The properties under test are the ones that make a soak worth running at all — that drift is judged by
direction rather than magnitude, that a short run reports the shortfall instead of quietly passing, and
that a soak on simulated evidence certifies nothing.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from soak import (  # noqa: E402
    DEFAULT_TOLERANCES,
    STANDARD_DURATIONS_HOURS,
    Drift,
    SoakPolicy,
    SoakRun,
    render_report,
)

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731


class _Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += seconds
        return self.now


def _run(clock, *, hours=24.0, interval=300.0, source="hardware") -> SoakRun:
    return SoakRun(
        "test-cam",
        policy=SoakPolicy(planned_hours=hours, sample_interval_seconds=interval),
        source_type={"hardware": "rtsp", "simulated": "simulated"}[source],
        clock=clock,
        now_iso=AT,
    )


class DriftTest(unittest.TestCase):
    def test_drift_percent_is_relative_to_the_first_sample(self):
        d = Drift(metric="memoryMb", first=100.0, last=112.0, minimum=98.0, maximum=112.0,
                  tolerated_percent=10.0)
        self.assertEqual(d.drift, 12.0)
        self.assertEqual(d.drift_percent, 12.0)
        self.assertEqual(d.status, "fail")

    def test_a_metric_that_started_at_zero_does_not_report_infinite_drift(self):
        # A first sample taken before the pipeline warmed up would otherwise fail every run.
        d = Drift(metric="fps", first=0.0, last=5.0, minimum=0.0, maximum=5.0, tolerated_percent=10.0)
        self.assertEqual(d.drift_percent, 0.0)
        self.assertEqual(d.status, "pass")

    def test_only_the_adverse_direction_counts(self):
        """Memory falling 30% is not a failure; fps falling 30% is. A soak that judged magnitude
        rather than direction would fail every run where the machine got quieter overnight."""
        memory_down = Drift(metric="memoryMb", first=200.0, last=140.0, minimum=140.0, maximum=200.0,
                            tolerated_percent=10.0)
        self.assertEqual(memory_down.status, "pass")
        fps_down = Drift(metric="fps", first=5.0, last=3.0, minimum=3.0, maximum=5.0,
                         tolerated_percent=10.0)
        self.assertEqual(fps_down.status, "fail")
        fps_up = Drift(metric="fps", first=5.0, last=6.0, minimum=5.0, maximum=6.0,
                       tolerated_percent=10.0)
        self.assertEqual(fps_up.status, "pass")

    def test_a_metric_with_no_tolerance_is_recorded_but_not_judged(self):
        d = Drift(metric="somethingNew", first=1.0, last=99.0, minimum=1.0, maximum=99.0)
        self.assertEqual(d.status, "skipped")

    def test_the_standard_durations_are_the_architects_list(self):
        self.assertEqual(STANDARD_DURATIONS_HOURS, (6.0, 12.0, 24.0, 48.0, 72.0))

    def test_memory_has_the_tightest_default_tolerance(self):
        # A leak is a leak; a busy machine's latency legitimately wanders.
        self.assertLess(DEFAULT_TOLERANCES["memoryMb"], DEFAULT_TOLERANCES["inferenceLatencyMs"])


class SamplingTest(unittest.TestCase):
    def test_the_first_sample_is_always_due(self):
        clock = _Clock()
        self.assertTrue(_run(clock).due)

    def test_a_sample_is_due_only_after_the_interval(self):
        clock = _Clock()
        run = _run(clock, interval=300.0)
        run.sample({"memoryMb": 100.0})
        clock.advance(299.0)
        self.assertFalse(run.due)
        clock.advance(2.0)
        self.assertTrue(run.due)

    def test_a_single_sample_yields_no_drift(self):
        # One reading has no trend, and inventing one from it would be fabrication.
        run = _run(_Clock())
        run.sample({"memoryMb": 100.0})
        self.assertEqual(run.drift(), [])

    def test_a_metric_present_in_only_one_sample_is_skipped(self):
        run = _run(_Clock())
        run.sample({"memoryMb": 100.0, "oneOff": 5.0})
        run.sample({"memoryMb": 101.0})
        self.assertEqual([d.metric for d in run.drift()], ["memoryMb"])


class VerdictTest(unittest.TestCase):
    def _complete(self, clock, run, *, memory=(100.0, 101.0), health=(95.0, 94.0), hours=24.0):
        for i, (m, h) in enumerate(zip(memory, health)):
            run.sample({"memoryMb": m, "healthScore": h}, frames_processed=1000 * (i + 1))
            clock.advance(hours * 3600.0 / max(1, len(memory) - 1) if len(memory) > 1 else 0.0)
        return run

    def test_a_full_clean_run_on_hardware_passes(self):
        clock = _Clock()
        run = self._complete(clock, _run(clock))
        report = run.report()
        self.assertTrue(report["passed"], report["blockers"])
        self.assertEqual(report["blockers"], [])
        self.assertEqual(report["evidenceClass"], "hardware")

    def test_a_memory_leak_fails_the_soak(self):
        clock = _Clock()
        run = self._complete(clock, _run(clock), memory=(100.0, 190.0))
        report = run.report()
        self.assertFalse(report["passed"])
        self.assertTrue(any("memoryMb drifted" in b for b in report["blockers"]))

    def test_a_run_that_ended_early_reports_the_shortfall(self):
        """A 3-hour abort must never be mistaken for a completed 24-hour soak."""
        clock = _Clock()
        run = _run(clock, hours=24.0)
        run.sample({"memoryMb": 100.0})
        clock.advance(3 * 3600.0)
        run.sample({"memoryMb": 100.0})
        report = run.report()
        self.assertFalse(report["passed"])
        self.assertTrue(any("of a planned 24h" in b for b in report["blockers"]))
        self.assertAlmostEqual(report["actualHours"], 3.0, places=2)

    def test_an_aborted_run_records_why(self):
        clock = _Clock()
        run = self._complete(clock, _run(clock))
        run.abort("host lost power")
        report = run.report()
        self.assertFalse(report["passed"])
        self.assertIn("run aborted: host lost power", report["blockers"])

    def test_excessive_restarts_fail_the_soak_regardless_of_drift(self):
        # A runtime that recovers forty times in a night is not stable, however good its numbers look.
        clock = _Clock()
        run = _run(clock)
        run.sample({"memoryMb": 100.0}, restarts=0)
        clock.advance(24 * 3600.0)
        run.sample({"memoryMb": 100.0}, restarts=40)
        report = run.report()
        self.assertFalse(report["passed"])
        self.assertTrue(any("restarts exceeds" in b for b in report["blockers"]))

    def test_frame_loss_above_the_ceiling_fails(self):
        clock = _Clock()
        run = _run(clock)
        run.sample({"memoryMb": 100.0}, frames_processed=100, frames_dropped=0)
        clock.advance(24 * 3600.0)
        run.sample({"memoryMb": 100.0}, frames_processed=900, frames_dropped=100)
        report = run.report()
        self.assertEqual(report["droppedFramePercent"], 10.0)
        self.assertTrue(any("dropped 10.00%" in b for b in report["blockers"]))

    def test_a_soak_on_simulated_evidence_certifies_nothing(self):
        """The same rule as certification, in the place a soak could most easily be misread as proof:
        it ran for the full duration and every number was perfect."""
        clock = _Clock()
        run = self._complete(clock, _run(clock, source="simulated"))
        report = run.report()
        self.assertFalse(report["passed"])
        self.assertTrue(any("certifies nothing without hardware" in b for b in report["blockers"]))

    def test_the_health_trend_is_carried_for_the_sparkline(self):
        clock = _Clock()
        run = self._complete(clock, _run(clock), memory=(100.0, 100.0), health=(95.0, 88.0))
        report = run.report()
        self.assertEqual(report["healthTrend"], [95.0, 88.0])
        self.assertEqual(report["healthFirst"], 95.0)
        self.assertEqual(report["healthLast"], 88.0)
        self.assertEqual(report["healthMin"], 88.0)

    def test_the_rendered_report_shows_direction(self):
        clock = _Clock()
        run = self._complete(clock, _run(clock), memory=(100.0, 190.0))
        text = render_report(run.report())
        self.assertIn("memoryMb", text)
        self.assertIn("+90.0%", text)
        self.assertIn("passed   : NO", text)


class SessionSamplingTest(unittest.TestCase):
    class _Runner:
        restart_count = 2

        def diagnostics(self):
            return {
                "ingestion": {"availabilityPercent": 99.5, "reconnectCount": 3},
                "backpressure": {
                    "queueUtilization": 0.4,
                    "processingDelayMs": 12.0,
                    "framesProcessed": 5000,
                    "framesDropped": 4,
                },
                "restartCount": 2,
            }

        health = None

        def score_health(self):
            class _S:
                score = 91.0

            return _S()

    def test_it_reads_only_what_the_runtime_already_publishes(self):
        clock = _Clock()
        run = _run(clock)
        sample = run.sample_session(self._Runner())
        self.assertEqual(sample.metrics["queueUtilization"], 0.4)
        self.assertEqual(sample.metrics["availabilityPercent"], 99.5)
        self.assertEqual(sample.metrics["healthScore"], 91.0)
        self.assertEqual(sample.restarts, 2)
        self.assertEqual(sample.reconnects, 3)
        self.assertEqual(sample.frames_processed, 5000)


if __name__ == "__main__":
    unittest.main()
