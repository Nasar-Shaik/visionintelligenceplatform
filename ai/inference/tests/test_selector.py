"""Model-selector unit tests (stdlib-only). Prove the model-agnostic binding: a selector resolves
to a registry model, and swapping the model is a selector/registry change, not code."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from selector import ModelSelector, SelectorUnresolved, matches, select, version_matches  # noqa: E402

CATALOG = [
    {"name": "person-det", "version": "1", "task": "object-detection", "family": "yolo", "accelerators": ["cpu"]},
    {"name": "person-det", "version": "2", "task": "object-detection", "family": "yolo", "accelerators": ["cpu", "gpu"]},
    {"name": "plate", "version": "1", "task": "ocr", "family": "crnn", "accelerators": ["cpu"]},
]


class VersionMatchTests(unittest.TestCase):
    def test_wildcards_match_anything(self) -> None:
        self.assertTrue(version_matches("", "9.9.9"))
        self.assertTrue(version_matches("*", "1"))

    def test_exact_and_range(self) -> None:
        self.assertTrue(version_matches("2", "2"))
        self.assertFalse(version_matches("2", "1"))
        self.assertTrue(version_matches(">=2", "3"))
        self.assertFalse(version_matches(">=2", "1"))
        self.assertTrue(version_matches("1.x", "1.4.0"))
        self.assertFalse(version_matches("1.x", "2.0.0"))


class MatchesTests(unittest.TestCase):
    def test_task_and_family(self) -> None:
        sel = ModelSelector(task="object-detection", family="yolo")
        self.assertTrue(matches(sel, CATALOG[0]))
        self.assertFalse(matches(sel, CATALOG[2]))  # wrong task

    def test_family_wildcard(self) -> None:
        sel = ModelSelector(task="object-detection", family="*")
        self.assertTrue(matches(sel, CATALOG[0]))

    def test_accelerator_intersection(self) -> None:
        sel = ModelSelector(task="object-detection", family="yolo", accelerators=("gpu",))
        self.assertFalse(matches(sel, CATALOG[0]))  # cpu-only
        self.assertTrue(matches(sel, CATALOG[1]))  # cpu+gpu


class SelectTests(unittest.TestCase):
    def test_selects_highest_version_match(self) -> None:
        sel = ModelSelector(task="object-detection", family="yolo")
        chosen = select(sel, CATALOG)
        self.assertEqual(chosen["version"], "2")

    def test_unresolved_raises(self) -> None:
        with self.assertRaises(SelectorUnresolved):
            select(ModelSelector(task="segmentation"), CATALOG)


if __name__ == "__main__":
    unittest.main()
