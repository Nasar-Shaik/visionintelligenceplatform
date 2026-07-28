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


if __name__ == "__main__":
    unittest.main()
