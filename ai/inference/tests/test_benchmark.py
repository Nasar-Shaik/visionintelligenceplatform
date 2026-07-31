"""AI-5a benchmark-harness tests — pure KPI math (percentile), budget evaluation with the PASS/WARNING/
FAIL tiers (informational only), report assembly with reproducibility metadata (version/environment/
configuration), warm-up separation, and a multi-camera harness smoke run over the real pipeline. The KPI
math is asserted deterministically; the pipeline run asserts structure, not absolute wall-clock numbers.
Stdlib-only. AI-5a measures the frozen v1.0 runtime — it adds no capability and no perception contract."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchmark import (  # noqa: E402
    BenchmarkKpis,
    BenchmarkWorkload,
    build_report,
    environment_fingerprint,
    evaluate_budget,
    percentile,
    run_benchmark,
    standard_suite,
)


class PercentileTests(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertEqual(percentile([], 50), 0.0)
        self.assertEqual(percentile([5], 50), 5)
        self.assertEqual(percentile([1, 2, 3, 4, 10], 50), 2)
        self.assertEqual(percentile([1, 2, 3, 4, 10], 95), 10)
        self.assertEqual(percentile([1, 2, 3, 4, 10], 100), 10)
        self.assertEqual(percentile([1, 2, 3, 4, 10], 0), 1)


class BudgetEvaluationTests(unittest.TestCase):
    def _kpis(self, **kw):
        base = {"fps": 6.0, "inferenceLatencyP95Ms": 50.0, "eventLatencyMs": 120.0, "droppedFramePercent": 1.0}
        base.update(kw)
        return base

    def test_pass_and_na(self):
        budget = {"minSustainedFps": 5, "maxEventLatencyMs": 200}
        status, passed = evaluate_budget(self._kpis(), budget)
        self.assertEqual(status["fps"], "pass")
        self.assertEqual(status["eventLatencyMs"], "pass")
        self.assertEqual(status["inferenceLatencyP95Ms"], "na")  # not constrained
        self.assertTrue(passed)

    def test_fail(self):
        budget = {"minSustainedFps": 10, "maxEventLatencyMs": 100}
        status, passed = evaluate_budget(self._kpis(), budget)
        self.assertEqual(status["fps"], "fail")  # 6 < 10
        self.assertEqual(status["eventLatencyMs"], "fail")  # 120 > 100
        self.assertFalse(passed)

    def test_warning_within_margin_does_not_fail(self):
        # eventLatency 190 vs limit 200 → within 10% → warning; fps 5.2 vs 5 min → warning
        budget = {"maxEventLatencyMs": 200, "minSustainedFps": 5}
        status, passed = evaluate_budget(self._kpis(eventLatencyMs=190.0, fps=5.2), budget)
        self.assertEqual(status["eventLatencyMs"], "warning")
        self.assertEqual(status["fps"], "warning")
        self.assertTrue(passed)  # warnings are informational, never fail the run

    def test_no_budget_is_none(self):
        status, passed = evaluate_budget(self._kpis(), None)
        self.assertEqual(status, {})
        self.assertIsNone(passed)


class ReportTests(unittest.TestCase):
    def _kpis(self):
        return BenchmarkKpis(
            fps=6.0, inference_latency_p50_ms=8.0, inference_latency_p95_ms=15.0, event_latency_ms=120.0,
            event_throughput=30.0, dropped_frame_percent=1.0, frames_processed=100, duration_seconds=16.6,
        )

    def test_report_carries_reproducibility_metadata(self):
        report = build_report(
            report_id="b1", deployment_class="edge-device",
            workload=BenchmarkWorkload(name="four", cameras=4, frames=100),
            kpis=self._kpis(), budget={"minSustainedFps": 5}, recorded_at="2026-07-31T10:00:00.000Z",
            environment={"os": "Linux", "arch": "x86_64", "pythonVersion": "3.12.0"},
            configuration={"frames": 100, "warmupCameras": 1, "mode": "deterministic-synthetic"},
        )
        self.assertEqual(report["benchmarkVersion"], "1.0.0")
        self.assertEqual(report["deploymentClass"], "edge-device")
        self.assertEqual(report["environment"]["os"], "Linux")
        self.assertEqual(report["configuration"]["mode"], "deterministic-synthetic")
        self.assertTrue(report["passed"])

    def test_environment_fingerprint_has_required_fields(self):
        env = environment_fingerprint()
        for key in ("os", "arch", "pythonVersion"):
            self.assertIn(key, env)


class HarnessSmokeTests(unittest.TestCase):
    def test_multi_camera_run_produces_valid_report(self):
        wl = standard_suite(frames=8)[1]  # four-cameras
        report = run_benchmark(
            wl, deployment_class="dev-laptop",
            budget={"minSustainedFps": 0.001, "maxEventLatencyMs": 1e9, "maxFrameLossPercent": 100},
            now_iso=lambda: "2026-07-31T10:00:00.000Z", report_id="b_smoke", warmup_cameras=1,
        )
        self.assertEqual(report["workload"]["cameras"], 4)
        self.assertGreaterEqual(report["kpis"]["framesProcessed"], 1)
        self.assertIn("environment", report)
        self.assertEqual(report["configuration"]["warmupCameras"], 1)
        self.assertTrue(report["passed"])  # generous budget → pass

    def test_standard_suite_shape(self):
        suite = standard_suite()
        self.assertEqual([w.cameras for w in suite], [1, 4, 8])

    def test_injected_analyze_is_used_and_warmup_untimed(self):
        calls = []

        class _Res:
            summary = {"framesSampled": 3, "framesDropped": 0}
            events = [{}, {}]
            timings = None

        def _analyze(cam):
            calls.append(cam)
            return _Res()

        wl = BenchmarkWorkload(name="one", cameras=1, frames=3)
        run_benchmark(wl, analyze=_analyze, now_iso=lambda: "t", warmup_cameras=1)
        # 1 warm-up call (cam 0) + 1 measured call (cam 0) = 2 invocations
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
