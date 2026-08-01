"""HTTP transport tests (stdlib-only): spins the real stdlib server on an ephemeral port and drives
it over urllib. Covers discovery, readiness, metrics, the internal-key gate, fail-closed context,
and a full /infer round-trip against the registry (fake backend)."""

import base64
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from manifest import CapabilityManifest  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import build_server  # noqa: E402

KEY = "internal-key-at-least-16-chars"
IMG = base64.b64encode(b"a-fake-jpeg-frame").decode("ascii")
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 - localhost test
        return resp.status, resp.read().decode("utf-8")


def _post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(
            MANIFESTS_DIR,
            lambda _m: FakeModelResolver(),
            lambda _m: FakeModelAdapter(),
        )
        cls.registry = registry
        cls.httpd = build_server("127.0.0.1", 0, registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def base(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def infer(self, body, headers=None):
        h = {"content-type": "application/json"}
        if headers:
            h.update(headers)
        return _post(self.base("/infer"), body, h)

    def frame(self, context=None, image=IMG):
        body = {"frame": {"cameraId": "cam_1", "seq": 1, "capturedAt": "2026-07-28T00:00:00.000Z"}, "imageBase64": image}
        if context is not None:
            body["context"] = context
        return body

    def test_health_ready_and_discovery(self) -> None:
        self.assertEqual(_get(self.base("/health"))[0], 200)
        status, _ = _get(self.base("/ready"))
        self.assertEqual(status, 200)  # default capability is READY
        _, caps = _get(self.base("/capabilities"))
        self.assertIn("perception.person-detection", caps)

    def test_status_shows_lifecycle_state(self) -> None:
        _, body = _get(self.base("/status"))
        self.assertIn('"state": "READY"', body)

    def test_metrics_is_prometheus_text(self) -> None:
        _, body = _get(self.base("/metrics"))
        self.assertIn("inference_frames_processed_total", body)

    def test_infer_requires_internal_key(self) -> None:
        status, body = self.infer(self.frame({"tenantId": "tnt_a", "principalId": "u"}))
        self.assertEqual(status, 401)
        self.assertFalse(body["success"])

    def test_infer_round_trip(self) -> None:
        status, body = self.infer(
            self.frame({"tenantId": "tnt_a", "principalId": "u"}), {"x-internal-key": KEY}
        )
        self.assertEqual(status, 200)
        data = body["data"]
        self.assertEqual(data["tenantId"], "tnt_a")
        self.assertEqual(data["executionProvider"], "stub")
        self.assertGreaterEqual(len(data["detections"]), 1)

    def test_infer_without_context_is_400_and_counted(self) -> None:
        status, body = self.infer(self.frame(context=None), {"x-internal-key": KEY})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "context_required")

    def test_infer_unknown_capability_is_404(self) -> None:
        body = self.frame({"tenantId": "tnt_a", "principalId": "u"})
        body["capabilityId"] = "perception.nonexistent"
        status, payload = self.infer(body, {"x-internal-key": KEY})
        self.assertEqual(status, 404)

    def test_certification_matrix_is_served_and_claims_nothing(self) -> None:
        """AI-5e. The matrix is a product property, not tenant data, so it needs no tenant header —
        and every row must still read `pending-validation` from a repository with no hardware."""
        status, raw = _get(self.base("/certification/matrix"))
        self.assertEqual(status, 200)
        data = json.loads(raw)["data"]
        self.assertGreater(data["devices"], 0)
        self.assertEqual(data["byStatus"]["certified"], 0)
        for row in data["matrix"]:
            self.assertEqual(row["status"], "pending-validation")
        self.assertIn("physically validated", data["note"])

    def test_dataset_coverage_is_served(self) -> None:
        status, raw = _get(self.base("/certification/coverage"))
        self.assertEqual(status, 200)
        data = json.loads(raw)["data"]
        self.assertIn("coverage", data)
        self.assertEqual(len(data["coverage"]), 18)


if __name__ == "__main__":
    unittest.main()
