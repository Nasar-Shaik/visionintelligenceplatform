"""Model Registry tests (P2-2 G-3) — deterministic, stdlib-only, no camera/model. Covers
registration, append-only versions, active selection, enable/disable rules, capability profile,
tenant isolation, and conflict handling."""

import itertools
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from errors import Conflict, NotFound, ValidationError  # noqa: E402
from model_registry import ModelRegistry  # noqa: E402


def _fixed_clock():
    seq = itertools.count(1_800_000_000)
    return lambda: float(next(seq))


def _ids(prefix="mdl"):
    seq = itertools.count(1)
    return lambda: f"{prefix}_{next(seq)}"


class ModelRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.reg = ModelRegistry(clock=_fixed_clock(), id_gen=_ids())

    def test_register_starts_disabled_with_no_active_version(self) -> None:
        m = self.reg.register(
            "tnt_a",
            name="YOLOv12",
            engine="onnx",
            task="object-detection",
            capabilities=["perception.person-detection"],
            capability_profile={
                "supportedEventTypes": ["perception.person.detected", "perception.vehicle.detected"],
                "supportedCategories": ["perception"],
                "inputSize": [640, 640],
                "expectedFps": 30,
                "acceleration": ["gpu", "cpu"],
                "confidenceThreshold": {"min": 0.25, "max": 0.9},
            },
        )
        self.assertEqual(m.status, "disabled")
        self.assertIsNone(m.active_version)
        d = m.to_dict()
        self.assertEqual(d["capabilityProfile"]["supportedEventTypes"][0], "perception.person.detected")
        self.assertEqual(d["capabilityProfile"]["inputSize"], [640, 640])

    def test_add_version_is_append_only_and_rejects_duplicates(self) -> None:
        m = self.reg.register("tnt_a", name="Fire", engine="tensorrt", task="fire-smoke")
        self.reg.add_version(
            "tnt_a", m.id, version="1.0.0", format="engine", artifact_uri="s3://m/fire/1"
        )
        with self.assertRaises(Conflict):
            self.reg.add_version(
                "tnt_a", m.id, version="1.0.0", format="engine", artifact_uri="s3://m/fire/1b"
            )
        self.assertEqual(len(self.reg.require("tnt_a", m.id).versions), 1)

    def test_activate_and_enable_rules(self) -> None:
        m = self.reg.register("tnt_a", name="PPE", engine="openvino", task="ppe")
        # Cannot enable without an active version.
        with self.assertRaises(Conflict):
            self.reg.enable("tnt_a", m.id)
        self.reg.add_version(
            "tnt_a", m.id, version="1.2.0", format="openvino-ir", artifact_uri="s3://m/ppe/1"
        )
        with self.assertRaises(NotFound):
            self.reg.activate("tnt_a", m.id, "9.9.9")
        self.reg.activate("tnt_a", m.id, "1.2.0")
        enabled = self.reg.enable("tnt_a", m.id)
        self.assertEqual(enabled.status, "enabled")
        self.assertEqual(enabled.active_version, "1.2.0")

    def test_active_for_capability_resolution(self) -> None:
        m = self.reg.register(
            "tnt_a", name="Person", engine="onnx", task="det", capabilities=["perception.person-detection"]
        )
        self.reg.add_version(
            "tnt_a", m.id, version="1.0.0", format="onnx", artifact_uri="s3://m/p/1", activate=True
        )
        self.assertIsNone(self.reg.active_for_capability("tnt_a", "perception.person-detection"))
        self.reg.enable("tnt_a", m.id)
        resolved = self.reg.active_for_capability("tnt_a", "perception.person-detection")
        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.id, m.id)

    def test_tenant_isolation(self) -> None:
        m = self.reg.register("tnt_a", name="X", engine="onnx", task="det")
        self.assertIsNone(self.reg.get("tnt_b", m.id))
        with self.assertRaises(NotFound):
            self.reg.require("tnt_b", m.id)
        self.assertEqual(self.reg.list("tnt_b"), [])

    def test_register_validates_engine_and_tenant(self) -> None:
        with self.assertRaises(ValidationError):
            self.reg.register("tnt_a", name="X", engine="magic", task="det")
        with self.assertRaises(ValidationError):
            self.reg.register("", name="X", engine="onnx", task="det")

    def test_list_filters_by_capability_and_status(self) -> None:
        a = self.reg.register("tnt_a", name="A", engine="onnx", task="det", capabilities=["perception.person-detection"])
        self.reg.add_version("tnt_a", a.id, version="1.0.0", format="onnx", artifact_uri="s3://a", activate=True)
        self.reg.enable("tnt_a", a.id)
        self.reg.register("tnt_a", name="B", engine="onnx", task="det")
        self.assertEqual(len(self.reg.list("tnt_a")), 2)
        self.assertEqual(len(self.reg.list("tnt_a", status="enabled")), 1)
        self.assertEqual(len(self.reg.list("tnt_a", capability="perception.person-detection")), 1)


if __name__ == "__main__":
    unittest.main()
