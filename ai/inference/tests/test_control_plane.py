"""Control-plane HTTP tests (P2-2 G-3): the /models + /sessions routes over the real stdlib server.
Covers the internal-key gate, x-tenant-id scoping, model register→version→activate→enable, session
start→pause→resume→stop, and cross-tenant 404. No camera/model."""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from model_registry import ModelRegistry  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import build_server  # noqa: E402
from sessions import SessionManager  # noqa: E402

KEY = "internal-key-at-least-16-chars"
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


def _req(url, method, headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class ControlPlaneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter())
        cls.httpd = build_server(
            "127.0.0.1", 0, registry, KEY, "inference", "0.1.0",
            model_registry=ModelRegistry(), sessions=SessionManager(),
        )
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def hdr(self, tenant="tnt_a"):
        return {"x-internal-key": KEY, "x-tenant-id": tenant, "content-type": "application/json"}

    def test_models_require_internal_key(self) -> None:
        status, _ = _req(self.url("/models"), "POST", {"content-type": "application/json"}, {"name": "x"})
        self.assertEqual(status, 401)

    def test_model_register_version_activate_enable(self) -> None:
        status, reg = _req(
            self.url("/models"), "POST", self.hdr(),
            {"name": "YOLOv12", "task": "object-detection", "engine": "onnx",
             "capabilities": ["perception.person-detection"],
             "capabilityProfile": {"supportedEventTypes": ["perception.person.detected"]}},
        )
        self.assertEqual(status, 201)
        mid = reg["data"]["id"]
        self.assertEqual(reg["data"]["status"], "disabled")

        status, _ = _req(self.url(f"/models/{mid}/versions"), "POST", self.hdr(),
                         {"version": "1.0.0", "format": "onnx", "artifactUri": "s3://m/1", "activate": True})
        self.assertEqual(status, 200)

        status, en = _req(self.url(f"/models/{mid}/enable"), "POST", self.hdr(), {})
        self.assertEqual(status, 200)
        self.assertEqual(en["data"]["status"], "enabled")
        self.assertEqual(en["data"]["activeVersion"], "1.0.0")

        # listed for this tenant, absent for another
        _, mine = _req(self.url("/models"), "GET", self.hdr())
        self.assertTrue(any(m["id"] == mid for m in mine["data"]))
        status, other = _req(self.url(f"/models/{mid}"), "GET", self.hdr("tnt_b"))
        self.assertEqual(status, 404)

    def test_enable_without_active_version_conflicts(self) -> None:
        _, reg = _req(self.url("/models"), "POST", self.hdr(), {"name": "F", "task": "fire", "engine": "tensorrt"})
        mid = reg["data"]["id"]
        status, _ = _req(self.url(f"/models/{mid}/enable"), "POST", self.hdr(), {})
        self.assertEqual(status, 409)

    def test_session_lifecycle_over_http(self) -> None:
        status, s = _req(self.url("/sessions"), "POST", self.hdr(),
                         {"cameraId": "cam_1", "capabilityId": "perception.person-detection", "engine": "onnx"})
        self.assertEqual(status, 201)
        sid = s["data"]["sessionId"]
        self.assertEqual(s["data"]["state"], "running")

        for action, expected in (("pause", "paused"), ("resume", "running"), ("stop", "stopped")):
            status, r = _req(self.url(f"/sessions/{sid}/{action}"), "POST", self.hdr(), {})
            self.assertEqual(status, 200)
            self.assertEqual(r["data"]["state"], expected)

        # illegal transition → 409
        status, _ = _req(self.url(f"/sessions/{sid}/pause"), "POST", self.hdr(), {})
        self.assertEqual(status, 409)
        # cross-tenant → 404
        status, _ = _req(self.url(f"/sessions/{sid}"), "GET", self.hdr("tnt_b"))
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
