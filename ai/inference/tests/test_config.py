"""Config loader tests (stdlib-only)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config import load_config  # noqa: E402


class ConfigTests(unittest.TestCase):
    def test_defaults(self) -> None:
        cfg = load_config({})
        self.assertEqual(cfg.port, 8085)
        self.assertEqual(cfg.backend, "stub")
        self.assertTrue(cfg.manifests_dir.endswith("manifests"))
        # Event publishing defaults to the dependency-free null sink (P1-5).
        self.assertEqual(cfg.event_sink, "null")
        self.assertTrue(cfg.nats_url.startswith("nats://"))

    def test_event_sink_override(self) -> None:
        cfg = load_config({"INFERENCE_EVENT_SINK": "nats", "NATS_URL": "nats://broker:4222"})
        self.assertEqual(cfg.event_sink, "nats")
        self.assertEqual(cfg.nats_url, "nats://broker:4222")

    def test_rejects_unknown_event_sink(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"INFERENCE_EVENT_SINK": "kafka"})

    def test_overrides(self) -> None:
        cfg = load_config({"PORT": "9000", "INFERENCE_BACKEND": "onnx", "LOG_LEVEL": "debug"})
        self.assertEqual(cfg.port, 9000)
        self.assertEqual(cfg.backend, "onnx")
        self.assertEqual(cfg.log_level, "debug")

    def test_rejects_short_internal_key(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"INTERNAL_API_KEY": "short"})

    def test_rejects_unknown_backend(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"INFERENCE_BACKEND": "tensorrt"})

    def test_blank_required_value_rejected(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"INTERNAL_API_KEY": ""})


if __name__ == "__main__":
    unittest.main()
