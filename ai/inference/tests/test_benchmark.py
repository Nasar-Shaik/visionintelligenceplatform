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


class ReproducibilityFingerprintTest(unittest.TestCase):
    """AI-5b refinement 5: a report records the five anchors that make it comparable."""

    def test_report_records_all_five_reproducibility_anchors(self):
        from benchmark import run_benchmark as run

        report = run(BenchmarkWorkload(name="single-camera", cameras=1, frames=4))
        for key in ("runtimeVersion", "benchmarkVersion", "deploymentClass", "configurationFingerprint", "hardwareFingerprint"):
            self.assertIn(key, report)

    def test_fingerprints_are_stable_for_identical_inputs(self):
        from benchmark import stable_fingerprint

        payload = {"frames": 60, "cameras": 4, "mode": "deterministic-synthetic"}
        first = stable_fingerprint(payload, prefix="cfg")
        # Key order must not matter, and the digest must be stable across calls/processes.
        reordered = {"mode": "deterministic-synthetic", "cameras": 4, "frames": 60}
        self.assertEqual(first, stable_fingerprint(reordered, prefix="cfg"))
        self.assertTrue(first.startswith("cfg_"))

    def test_different_configurations_fingerprint_differently(self):
        from benchmark import stable_fingerprint

        self.assertNotEqual(
            stable_fingerprint({"cameras": 1}, prefix="cfg"),
            stable_fingerprint({"cameras": 8}, prefix="cfg"),
        )


class LiveWorkloadTest(unittest.TestCase):
    """AI-5b live workloads run the STREAMING path while staying deterministic (simulated sources)."""

    def test_live_suite_covers_the_production_scenarios(self):
        from benchmark import live_suite

        names = [w.name for w in live_suite(frames=10)]
        self.assertEqual(
            names, ["live-single-camera", "live-multi-camera", "continuous-execution", "reconnect-recovery"]
        )

    def test_a_live_run_measures_the_streaming_path(self):
        from benchmark import live_analyze, live_suite
        from benchmark import run_benchmark as run

        workload = live_suite(frames=12)[0]
        report = run(
            workload, analyze=live_analyze(workload), mode="deterministic-live", report_id="live_1"
        )
        self.assertGreater(report["kpis"]["framesProcessed"], 0)
        self.assertEqual(report["configuration"]["mode"], "deterministic-live")
        self.assertIn("streamAvailabilityPercent", report["configuration"])

    def test_reconnect_workload_records_recovery_not_just_speed(self):
        from benchmark import live_analyze, live_suite
        from benchmark import run_benchmark as run

        workload = live_suite(frames=12)[3]
        report = run(
            workload,
            analyze=live_analyze(workload, drop_after=4),
            mode="deterministic-live",
            report_id="live_reconnect",
        )
        self.assertGreaterEqual(report["configuration"]["reconnectCount"], 1)

    def test_offline_runs_never_report_sampling_as_frame_loss(self):
        from benchmark import run_benchmark as run

        # 30 fps source sampled to 5 fps skips ~83% of frames BY DESIGN; loss must stay 0.
        report = run(BenchmarkWorkload(name="single-camera", cameras=1, frames=30, target_fps=5.0))
        self.assertEqual(report["kpis"]["droppedFramePercent"], 0.0)


if __name__ == "__main__":
    unittest.main()


class BaselineComparisonTest(unittest.TestCase):
    """AI-5c: the evidence gate — never merge an optimization without a measurable improvement."""

    BASE = {
        "id": "b1", "deploymentClass": "dev-laptop", "workload": {"name": "single-camera"},
        "configurationFingerprint": "cfg_a", "hardwareFingerprint": "hw_a",
        "kpis": {"fps": 100.0, "eventLatencyMs": 10.0, "droppedFramePercent": 0.0,
                 "inferenceLatencyP50Ms": 5.0, "inferenceLatencyP95Ms": 8.0, "eventThroughput": 100.0},
    }

    def _candidate(self, **kpi_overrides):
        from copy import deepcopy

        candidate = deepcopy(self.BASE)
        candidate["id"] = "c1"
        candidate["kpis"].update(kpi_overrides)
        return candidate

    def test_accepts_a_measurable_improvement(self):
        from benchmark import compare_reports

        result = compare_reports(self.BASE, self._candidate(fps=130.0))
        self.assertTrue(result["accepted"])
        self.assertIn("fps", result["improved"])
        self.assertTrue(result["summary"].startswith("ACCEPT"))

    def test_rejects_a_regression(self):
        from benchmark import compare_reports

        result = compare_reports(self.BASE, self._candidate(fps=70.0))
        self.assertFalse(result["accepted"])
        self.assertIn("fps", result["regressed"])

    def test_rejects_change_inside_the_noise_band(self):
        from benchmark import compare_reports

        # A 2% "improvement" on a wall-clock benchmark is jitter, not a result.
        result = compare_reports(self.BASE, self._candidate(fps=102.0))
        self.assertFalse(result["accepted"])
        self.assertEqual(result["improved"], [])
        self.assertIn("no measurable change", result["summary"])

    def test_lower_is_better_kpis_are_scored_correctly(self):
        from benchmark import compare_reports

        result = compare_reports(self.BASE, self._candidate(eventLatencyMs=5.0))
        self.assertIn("eventLatencyMs", result["improved"])
        result2 = compare_reports(self.BASE, self._candidate(droppedFramePercent=3.0))
        self.assertIn("droppedFramePercent", result2["regressed"])

    def test_refuses_to_compare_runs_from_different_hardware(self):
        from benchmark import compare_reports

        candidate = self._candidate(fps=500.0)
        candidate["hardwareFingerprint"] = "hw_b"
        result = compare_reports(self.BASE, candidate)
        self.assertFalse(result["comparable"])
        self.assertFalse(result["accepted"])  # a 5x "win" from new hardware is not an optimization
        self.assertIn("hardware differs", result["incomparableReason"])

    def test_refuses_to_compare_different_configurations_or_workloads(self):
        from benchmark import compare_reports

        candidate = self._candidate(fps=200.0)
        candidate["configurationFingerprint"] = "cfg_b"
        self.assertFalse(compare_reports(self.BASE, candidate)["comparable"])

        other_workload = self._candidate(fps=200.0)
        other_workload["workload"] = {"name": "eight-cameras"}
        self.assertFalse(compare_reports(self.BASE, other_workload)["comparable"])

    def test_bundles_are_paired_by_workload_name(self):
        from benchmark import compare_bundles

        baseline = [self.BASE, {**self.BASE, "id": "b2", "workload": {"name": "four-cameras"}}]
        candidate = [self._candidate(fps=130.0)]
        results = compare_bundles(baseline, candidate)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["workload"], "single-camera")
