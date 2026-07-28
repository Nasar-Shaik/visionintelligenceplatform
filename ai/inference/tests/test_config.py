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
