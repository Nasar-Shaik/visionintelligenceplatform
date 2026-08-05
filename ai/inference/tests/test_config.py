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

    # --- model resolution + engine tuning (P-8 Phase 3) -----------------------------

    def test_models_resolve_locally_by_default(self) -> None:
        """⚠️ The production default is `local`, and it is asserted rather than assumed: a
        deployment that silently resolved through MLflow would put a dev-stack service on the
        critical path of every container start."""
        cfg = load_config({})
        self.assertEqual(cfg.model_source, "local")
        self.assertTrue(cfg.model_catalogue.endswith(os.path.join("models", "registry.json")))
        self.assertEqual(cfg.model_dir, "/opt/vip/models")
        self.assertEqual(cfg.active_model, "")

    def test_rejects_an_unknown_model_source(self) -> None:
        with self.assertRaises(ValueError):
            load_config({"INFERENCE_MODEL_SOURCE": "s3"})

    def test_thread_pools_default_to_deriving_from_the_cgroup_quota(self) -> None:
        cfg = load_config({})
        self.assertEqual(cfg.onnx_intra_threads, 0, "0 means: read the cgroup limit (TD-61)")
        self.assertEqual(cfg.onnx_inter_threads, 1)
        self.assertEqual(cfg.onnx_providers, "CPUExecutionProvider")

    def test_warmup_is_on_by_default(self) -> None:
        self.assertTrue(load_config({}).onnx_warmup)

    def test_warmup_accepts_the_spellings_an_operator_will_actually_type(self) -> None:
        for raw in ("1", "true", "TRUE", "yes", "on"):
            with self.subTest(raw=raw):
                self.assertTrue(load_config({"INFERENCE_ONNX_WARMUP": raw}).onnx_warmup)
        for raw in ("0", "false", "no", "off"):
            with self.subTest(raw=raw):
                self.assertFalse(load_config({"INFERENCE_ONNX_WARMUP": raw}).onnx_warmup)

    def test_an_unrecognised_boolean_is_a_misconfiguration_not_a_false(self) -> None:
        """⚠️ The failure mode this prevents: `INFERENCE_ONNX_WARMUP=enabled` quietly meaning "off",
        and a first-frame latency regression shipping without anyone touching the code."""
        with self.assertRaises(ValueError):
            load_config({"INFERENCE_ONNX_WARMUP": "enabled"})

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
