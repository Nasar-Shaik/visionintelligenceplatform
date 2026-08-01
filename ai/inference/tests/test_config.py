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

    # --- AI-5b live ingestion ----------------------------------------------------

    def test_live_ingestion_defaults_are_production_safe(self) -> None:
        cfg = load_config({})
        self.assertEqual(cfg.max_sessions, 8)
        self.assertEqual(cfg.stream_queue_size, 32)
        self.assertEqual(cfg.stream_drop_policy, "drop-oldest")
        self.assertEqual(cfg.stream_target_fps, 5.0)
        self.assertEqual(cfg.reconnect_max_attempts, 10)
        self.assertEqual(cfg.reconnect_base_ms, 500.0)
        self.assertEqual(cfg.reconnect_max_ms, 30000.0)

    def test_live_ingestion_overrides(self) -> None:
        cfg = load_config(
            {
                "INFERENCE_MAX_SESSIONS": "16",
                "INFERENCE_STREAM_QUEUE_SIZE": "64",
                "INFERENCE_STREAM_DROP_POLICY": "drop-newest",
                "INFERENCE_RECONNECT_MAX_ATTEMPTS": "0",
            }
        )
        self.assertEqual(cfg.max_sessions, 16)
        self.assertEqual(cfg.stream_queue_size, 64)
        self.assertEqual(cfg.stream_drop_policy, "drop-newest")
        self.assertEqual(cfg.reconnect_max_attempts, 0)  # 0 = never reconnect (valid policy)

    def test_rejects_nonsense_limits_at_startup_not_in_production(self) -> None:
        for env in (
            {"INFERENCE_MAX_SESSIONS": "0"},
            {"INFERENCE_STREAM_QUEUE_SIZE": "-1"},
            {"INFERENCE_STREAM_QUEUE_SIZE": "lots"},
            {"INFERENCE_STREAM_DROP_POLICY": "drop-everything"},
            {"INFERENCE_RECONNECT_MAX_ATTEMPTS": "-2"},
            {"INFERENCE_STREAM_TARGET_FPS": "0"},
            # A max backoff below the base would make the schedule nonsense.
            {"INFERENCE_RECONNECT_BASE_MS": "5000", "INFERENCE_RECONNECT_MAX_MS": "100"},
        ):
            with self.assertRaises(ValueError, msg=f"expected rejection for {env}"):
                load_config(env)


if __name__ == "__main__":
    unittest.main()
