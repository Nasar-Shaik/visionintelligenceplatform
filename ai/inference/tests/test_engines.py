"""Engine-abstraction tests (P2-2 G-3) — the runtime is engine-agnostic (YOLO is not special). The
registry maps every canonical engine name to a factory; an unregistered engine is unavailable."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engines import CANONICAL_ENGINES, EngineRegistry, EngineUnavailable, default_registry  # noqa: E402


class _StubAdapter:
    execution_provider = "stub"

    def load(self, ref):  # noqa: ANN001
        return None

    def preprocess(self, ctx):  # noqa: ANN001
        return ctx

    def infer(self, prepared):  # noqa: ANN001
        return []

    def unload(self):
        return None


class EngineRegistryTests(unittest.TestCase):
    def test_canonical_set_includes_all_engines(self) -> None:
        self.assertEqual(
            CANONICAL_ENGINES,
            ("yolo", "onnx", "tensorrt", "openvino", "torchscript", "python-custom"),
        )

    def test_default_registry_supports_every_engine(self) -> None:
        reg = default_registry(lambda: _StubAdapter())
        self.assertEqual(reg.available(), sorted(CANONICAL_ENGINES))
        for engine in CANONICAL_ENGINES:
            self.assertTrue(reg.supports(engine))
            self.assertEqual(reg.create(engine).execution_provider, "stub")

    def test_unregistered_engine_is_unavailable(self) -> None:
        reg = EngineRegistry()
        reg.register("onnx", lambda: _StubAdapter())
        self.assertTrue(reg.supports("onnx"))
        with self.assertRaises(EngineUnavailable):
            reg.create("tensorrt")

    def test_register_rejects_unknown_engine_name(self) -> None:
        reg = EngineRegistry()
        with self.assertRaises(ValueError):
            reg.register("caffe", lambda: _StubAdapter())


if __name__ == "__main__":
    unittest.main()
