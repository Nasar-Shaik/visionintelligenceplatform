"""Capability-manifest tests (stdlib-only): manifests parse, self-describe, and are discovered from
the manifests/ directory (zero-code registration)."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from manifest import CapabilityManifest, load_manifests  # noqa: E402

MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


class ParseTests(unittest.TestCase):
    def test_parses_required_and_optional_fields(self) -> None:
        m = CapabilityManifest.from_dict(
            {
                "capabilityId": "perception.person-detection",
                "version": "0.1.0",
                "requiredModel": {"task": "object-detection", "family": "yolo", "accelerator": "cpu"},
                "minConfidence": 0.4,
                "tracking": True,
                "generatedEvents": ["perception.person.detected"],
            }
        )
        self.assertEqual(m.capability_id, "perception.person-detection")
        self.assertEqual(m.required_model.task, "object-detection")
        self.assertEqual(m.required_model.family, "yolo")
        self.assertTrue(m.tracking)
        self.assertTrue(m.enabled)  # default

    def test_missing_required_field_raises(self) -> None:
        with self.assertRaises(ValueError):
            CapabilityManifest.from_dict({"version": "0.1.0"})

    def test_descriptor_shape(self) -> None:
        m = CapabilityManifest.from_dict(
            {
                "capabilityId": "perception.person-detection",
                "version": "0.1.0",
                "requiredModel": {"task": "object-detection"},
                "generatedEvents": ["perception.person.detected"],
            }
        )
        d = m.descriptor()
        self.assertEqual(d["id"], "perception.person-detection")
        self.assertEqual(d["kind"], "perception")
        self.assertEqual(d["outputs"], [{"type": "perception.detection"}])
        self.assertEqual(d["models"]["selector"]["task"], "object-detection")


class DiscoveryTests(unittest.TestCase):
    def test_loads_manifests_from_directory(self) -> None:
        manifests = load_manifests(MANIFESTS_DIR)
        ids = {m.capability_id for m in manifests}
        self.assertIn("perception.person-detection", ids)
        for m in manifests:
            self.assertTrue(m.version)
            self.assertTrue(m.required_model.task)


if __name__ == "__main__":
    unittest.main()
