"""How the runtime is packaged (P-8 Phase 3).

⚠️ `requirements-runtime.txt` is a deliberate subset of `requirements.txt` — the deployed container
installs only what a serving process imports. Two files listing the same packages is a duplicate
source of truth, and the platform's rule is that duplicates are not allowed to exist *unchecked*.
So the duplication is converted into an invariant: **where the two files overlap, the pins must be
identical**. A runtime built from a different onnxruntime than the one the suite tested is not the
runtime that was tested.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
_FULL = os.path.join(_ROOT, "requirements.txt")
_RUNTIME = os.path.join(_ROOT, "requirements-runtime.txt")


def _pins(path):
    pins = {}
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "==" not in line:
                continue
            name, version = line.split("==", 1)
            pins[name.strip().lower()] = version.strip()
    return pins


class RequirementPinTests(unittest.TestCase):
    def setUp(self):
        self.full = _pins(_FULL)
        self.runtime = _pins(_RUNTIME)

    def test_the_runtime_set_is_not_empty(self):
        self.assertTrue(self.runtime, "requirements-runtime.txt declares no pinned packages")

    def test_every_runtime_package_is_pinned_to_the_same_version_as_the_full_set(self):
        for name, version in self.runtime.items():
            with self.subTest(package=name):
                self.assertIn(name, self.full, f"{name} is not in requirements.txt")
                self.assertEqual(
                    version,
                    self.full[name],
                    f"{name} is pinned to {version} for the deployed runtime but "
                    f"{self.full[name]} for the tested one",
                )

    def test_the_serving_container_does_not_install_the_authoring_dependencies(self):
        # ⚠️ Asserted, not assumed. MLflow + boto3 are ~700 MB the serving path never imports, and
        # the reason the local catalogue exists is that a production start must not depend on a
        # tracking server. If one of them reappears here, that decision was quietly reversed.
        for authoring in ("mlflow", "boto3", "nats-py"):
            self.assertNotIn(authoring, self.runtime)

    def test_the_inference_backend_is_still_covered_by_the_full_set(self):
        self.assertIn("onnxruntime", self.full)


if __name__ == "__main__":
    unittest.main()
