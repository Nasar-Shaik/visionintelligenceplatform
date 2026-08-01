"""Metrics collector tests (stdlib-only)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from metrics import Metrics  # noqa: E402


class MetricsTests(unittest.TestCase):
    def test_records_processed_frames_and_averages(self) -> None:
        m = Metrics()
        m.record_processed(decode_ms=2.0, inference_ms=10.0, confidences=[0.8, 0.6])
        m.record_processed(decode_ms=4.0, inference_ms=20.0, confidences=[0.9])
        self.assertEqual(m.frames_processed, 2)
        self.assertEqual(m.detections_total, 3)
        self.assertAlmostEqual(m.avg_inference_ms, 15.0)
        self.assertAlmostEqual(m.avg_decode_ms, 3.0)
        self.assertAlmostEqual(m.avg_confidence, (0.8 + 0.6 + 0.9) / 3)

    def test_records_dropped(self) -> None:
        m = Metrics()
        m.record_dropped()
        m.record_dropped()
        self.assertEqual(m.frames_dropped, 2)

    def test_fps_zero_without_two_samples(self) -> None:
        self.assertEqual(Metrics().fps, 0.0)

    def test_prometheus_exposes_expected_series(self) -> None:
        m = Metrics()
        m.record_processed(1.0, 5.0, [0.7])
        text = m.prometheus()
        for name in (
            "inference_frames_processed_total",
            "inference_frames_dropped_total",
            "inference_detections_total",
            "inference_avg_confidence",
            "inference_fps",
            "inference_process_max_rss_kb",
        ):
            self.assertIn(name, text)

    def test_snapshot_has_resource_fields(self) -> None:
        s = Metrics().snapshot()
        self.assertIn("maxRssKb", s)
        self.assertIn("cpuUserSeconds", s)

    # --- P2-2 G-3 extensions ------------------------------------------------------

    def test_runtime_metrics_shape_matches_contract(self) -> None:
        m = Metrics()
        m.record_processed(1.0, 10.0, [0.9])
        m.record_skipped(3)
        m.set_queue_depth(4)
        m.set_model_load_ms(120.0)
        rm = m.runtime_metrics()
        for key in (
            "fps",
            "framesProcessed",
            "framesSkipped",
            "droppedFrames",
            "avgLatencyMs",
            "latencyP50Ms",
            "latencyP95Ms",
            "queueDepth",
            "confidenceDistribution",
            "memoryMb",
            "uptimeSeconds",
            "modelLoadMs",
        ):
            self.assertIn(key, rm)
        self.assertEqual(rm["framesSkipped"], 3)
        self.assertEqual(rm["queueDepth"], 4)
        self.assertEqual(len(rm["confidenceDistribution"]), 10)

    def test_confidence_distribution_buckets(self) -> None:
        m = Metrics()
        # confidences 0.05→bucket0, 0.55→bucket5, 0.99→bucket9
        m.record_processed(0.0, 1.0, [0.05, 0.55, 0.99])
        hist = m.runtime_metrics()["confidenceDistribution"]
        self.assertEqual(hist[0], 1)
        self.assertEqual(hist[5], 1)
        self.assertEqual(hist[9], 1)

    def test_latency_percentiles_are_deterministic(self) -> None:
        m = Metrics()
        for ms in (10.0, 20.0, 30.0, 40.0, 100.0):
            m.record_processed(0.0, ms, [])
        self.assertGreaterEqual(m.latency_p95_ms, m.latency_p50_ms)
        self.assertEqual(m.latency_p95_ms, 100.0)

    def test_uptime_uses_injected_monotonic(self) -> None:
        ticks = iter([1000.0, 1042.5])  # init consumes the first, uptime read the second
        m = Metrics(monotonic=lambda: next(ticks))
        self.assertAlmostEqual(m.uptime_seconds, 42.5)

    def test_gpu_probe_optional(self) -> None:
        self.assertNotIn("gpuPercent", Metrics().runtime_metrics())
        m = Metrics(gpu_probe=lambda: 73.0)
        self.assertEqual(m.runtime_metrics()["gpuPercent"], 73.0)


if __name__ == "__main__":
    unittest.main()


class MetricGroupTests(unittest.TestCase):
    """AI-5c (Architect AI-5b rec 2): operational and AI metrics are separate audiences."""

    def test_groups_do_not_overlap(self):
        from metrics import AI_METRICS, OPERATIONAL_METRICS

        self.assertEqual(OPERATIONAL_METRICS & AI_METRICS, frozenset())

    def test_grouped_snapshot_splits_health_from_perception(self):
        m = Metrics()
        m.record_processed(decode_ms=2.0, inference_ms=8.0, confidences=[0.9, 0.8])
        grouped = m.grouped()
        self.assertIn("operational", grouped)
        self.assertIn("ai", grouped)
        # "is the system healthy?" lives in operational…
        self.assertIn("fps", grouped["operational"])
        self.assertIn("queueDepth", grouped["operational"])
        # …"is the system seeing correctly?" lives in ai.
        self.assertIn("detectionsTotal", grouped["ai"])
        self.assertIn("avgConfidence", grouped["ai"])
        self.assertNotIn("detectionsTotal", grouped["operational"])
        self.assertNotIn("fps", grouped["ai"])

    def test_every_grouped_key_comes_from_the_snapshot(self):
        m = Metrics()
        snapshot = m.snapshot()
        grouped = m.grouped()
        for group in grouped.values():
            for key in group:
                self.assertIn(key, snapshot)
