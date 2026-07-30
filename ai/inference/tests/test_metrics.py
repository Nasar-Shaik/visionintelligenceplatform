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
