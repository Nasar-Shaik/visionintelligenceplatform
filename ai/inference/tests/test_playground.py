"""AI-1 AI Playground tests — the analyze_request core, the playground-output artifact set, and a
full HTTP round-trip against POST /playground/analyze (internal-key + x-tenant-id). Deterministic,
stdlib-only (stub backend, base64 frames — no OpenCV)."""

import base64
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from playground import analyze_request, write_artifacts  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import build_server  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402

KEY = "internal-key-at-least-16-chars"
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


def _b64(payload: bytes) -> str:
    return base64.b64encode(payload).decode("ascii")


class AnalyzeRequestTests(unittest.TestCase):
    def test_analyzes_base64_frames_into_detections_and_events(self):
        body = {"frames": [_b64(b"\x01\x02\x03frame-a"), _b64(b"\x04\x05\x06frame-b")], "labels": ["person"]}
        out = analyze_request(body, "tnt_a")
        self.assertEqual(out["summary"]["framesSampled"], 2)
        self.assertEqual(out["summary"]["detections"], 2)
        self.assertEqual(len(out["events"]), 2)
        self.assertTrue(all(e["type"] == "perception.person.detected" for e in out["events"]))
        self.assertTrue(all(e["tenantId"] == "tnt_a" for e in out["events"]))
        self.assertIn("stageTimingsMs", out["summary"])

    def test_falls_back_to_synthetic_frames_when_none_supplied(self):
        out = analyze_request({"syntheticFrames": 4}, "tnt_a")
        self.assertEqual(out["summary"]["framesSampled"], 4)

    def test_confidence_option_is_honoured(self):
        out = analyze_request({"syntheticFrames": 3, "confidence": 1.0}, "tnt_a")
        self.assertEqual(out["summary"]["detections"], 0)


class ArtifactTests(unittest.TestCase):
    def test_writes_the_four_documents(self):
        options = AnalyzeOptions(tenant_id="tnt_a", labels=("person",))
        result = VideoAnalyzer(FakeModelAdapter(), options).analyze(StubFrameDecoder.synthetic(3))
        with tempfile.TemporaryDirectory() as d:
            paths = write_artifacts(d, result)
            for key in ("detections", "events", "metrics", "summary"):
                self.assertTrue(os.path.isfile(paths[key]), f"missing {key}")
            with open(paths["detections"], encoding="utf-8") as fh:
                detections = json.load(fh)
            with open(paths["events"], encoding="utf-8") as fh:
                events = json.load(fh)
            with open(paths["metrics"], encoding="utf-8") as fh:
                metrics = json.load(fh)
            with open(paths["summary"], encoding="utf-8") as fh:
                summary_text = fh.read()
            self.assertEqual(len(detections["detections"]), 3)
            self.assertEqual(len(events["events"]), 3)
            self.assertIn("stageTimingsMs", metrics)
            self.assertIn("AI Playground", summary_text)


def _post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class PlaygroundHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter())
        cls.httpd = build_server("127.0.0.1", 0, registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def _url(self):
        return f"http://127.0.0.1:{self.port}/playground/analyze"

    def test_requires_internal_key(self):
        status, _ = _post(self._url(), {"syntheticFrames": 2}, {"content-type": "application/json", "x-tenant-id": "tnt_a"})
        self.assertEqual(status, 401)

    def test_requires_tenant_header(self):
        status, _ = _post(self._url(), {"syntheticFrames": 2}, {"content-type": "application/json", "x-internal-key": KEY})
        self.assertEqual(status, 400)

    def test_analyzes_and_returns_events(self):
        status, res = _post(
            self._url(),
            {"syntheticFrames": 3, "labels": ["person"]},
            {"content-type": "application/json", "x-internal-key": KEY, "x-tenant-id": "tnt_a"},
        )
        self.assertEqual(status, 200)
        data = res["data"]
        self.assertEqual(data["summary"]["framesSampled"], 3)
        self.assertEqual(len(data["events"]), 3)
        self.assertEqual(data["events"][0]["type"], "perception.person.detected")


if __name__ == "__main__":
    unittest.main()
