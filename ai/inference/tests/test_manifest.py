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


class PerLabelFloorTests(unittest.TestCase):
    """`minConfidenceByLabel` — P-11 slice 2.10.

    ⛔ The defect this field exists for: one floor chosen for `person` (scored 0.73–0.94 by the
    deployed detector) applied to `handbag` (scored 0.47), so every carried object was discarded and
    the platform reported, perfectly consistently, that it had never seen one.
    """

    @staticmethod
    def _manifest(**extra: object) -> CapabilityManifest:
        return CapabilityManifest.from_dict(
            {
                "capabilityId": "perception.person-detection",
                "version": "0.1.0",
                "requiredModel": {"task": "object-detection"},
                "minConfidence": 0.5,
                **extra,
            }
        )

    def test_absent_map_keeps_every_label_on_the_capability_floor(self) -> None:
        """⭐ The backward-compatibility guarantee, asserted rather than assumed."""
        m = self._manifest()
        self.assertEqual(m.min_confidence_by_label, {})
        for label in ("person", "handbag", "anything-at-all"):
            self.assertEqual(m.floor_for(label), 0.5)

    def test_declared_label_uses_its_own_floor_and_others_do_not(self) -> None:
        m = self._manifest(minConfidenceByLabel={"handbag": 0.25})
        self.assertEqual(m.floor_for("handbag"), 0.25)
        # ⛔ The exception must not spread. A floor measured for one class is evidence about that
        # class; applying it to `person` would turn one measurement into eighty claims.
        self.assertEqual(m.floor_for("person"), 0.5)
        self.assertEqual(m.floor_for("toilet"), 0.5)

    def test_unlabelled_detection_falls_back_to_the_capability_floor(self) -> None:
        self.assertEqual(self._manifest(minConfidenceByLabel={"handbag": 0.25}).floor_for(None), 0.5)

    def test_descriptor_omits_the_map_when_none_is_declared(self) -> None:
        self.assertNotIn("minConfidenceByLabel", self._manifest().descriptor()["parameters"])

    def test_descriptor_publishes_the_map_when_one_is(self) -> None:
        params = self._manifest(minConfidenceByLabel={"handbag": 0.25, "backpack": 0.25}).descriptor()["parameters"]
        self.assertEqual(params["minConfidenceByLabel"], {"backpack": 0.25, "handbag": 0.25})

    def test_malformed_entries_raise_rather_than_being_skipped(self) -> None:
        """⛔ A dropped entry leaves the class on the default and reproduces the original defect."""
        for bad in (
            {"handbag": "0.25"},
            {"handbag": True},
            {"handbag": 1.5},
            {"handbag": -0.1},
            {"": 0.25},
            [("handbag", 0.25)],
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self._manifest(minConfidenceByLabel=bad)

    def test_the_deployed_manifest_declares_the_five_carriable_classes(self) -> None:
        """⚠️ Guards the deployment, not the parser: this is the file the runtime actually loads."""
        deployed = next(m for m in load_manifests(MANIFESTS_DIR) if m.capability_id == "perception.person-detection")
        for label in ("backpack", "handbag", "suitcase", "bottle", "cup"):
            with self.subTest(label=label):
                self.assertLess(deployed.floor_for(label), deployed.min_confidence)
        # ⭐ `person` is untouched, so no existing person-based capability changes behaviour.
        self.assertEqual(deployed.floor_for("person"), deployed.min_confidence)


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
