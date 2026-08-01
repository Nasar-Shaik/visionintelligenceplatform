"""P-2: the stream validation endpoint the camera service calls.

Like `/discovery/onvif`, this lives in the runtime because the runtime owns the decode path — and
like discovery, it creates no session, decodes into no pipeline and persists nothing (ADR-0024).

`stream_source.build_source` is swapped for a deterministic simulated builder, so these tests open no
socket to a camera and probe no network. Two properties are guarded hardest: credentials supplied in
the request never appear in the response, and the evidence class always reflects the source that was
actually probed.
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import stream_probe  # noqa: E402
from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from errors import ConnectionFailure  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import _apply_credentials, build_server  # noqa: E402
from stream_source import SimulatedStreamSource  # noqa: E402

KEY = "internal-key-at-least-16-chars"
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")

# Set by each test to control what the swapped-in builder returns.
BUILT_CONFIGS = []
BUILD_BEHAVIOUR = {"mode": "ok"}


def _post(url, body, headers=None):
    payload = json.dumps(body).encode() if body is not None else b"{}"
    h = {"content-type": "application/json", "x-internal-key": KEY}
    if headers is not None:
        h = headers
    req = urllib.request.Request(url, data=payload, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class _Refusing:
    source_type = "rtsp"

    def open(self):
        raise ConnectionFailure("cannot open source: 401 Unauthorized")

    def frames(self):  # pragma: no cover - never reached
        yield None

    def close(self):
        pass


def _fake_build(config):
    """Stands in for `build_source` — records the config the endpoint assembled, no network."""
    BUILT_CONFIGS.append(config)
    if BUILD_BEHAVIOUR["mode"] == "unauthorized":
        return _Refusing()
    return SimulatedStreamSource(uri="sim://camera", total_frames=10)


class StreamValidateEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(
            MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter()
        )
        cls.httpd = build_server("127.0.0.1", 0, registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        # The probe resolves its builder from the module at call time, so patching the attribute is
        # enough — the production code path runs verbatim, with no test-only branch inside it.
        self._real = stream_probe.build_source
        stream_probe.build_source = _fake_build
        BUILT_CONFIGS.clear()
        BUILD_BEHAVIOUR["mode"] = "ok"

    def tearDown(self):
        stream_probe.build_source = self._real

    def url(self):
        return f"http://127.0.0.1:{self.port}/streams/validate"

    def test_requires_the_internal_key(self):
        status, body = _post(
            self.url(),
            {"streamUrl": "rtsp://cam.local/sub"},
            headers={"content-type": "application/json"},
        )
        self.assertEqual(status, 401)
        self.assertFalse(body["success"])

    def test_requires_a_stream_url(self):
        status, body = _post(self.url(), {"protocol": "rtsp"})
        self.assertEqual(status, 400)
        self.assertIn("streamUrl", body["error"]["message"])

    def test_returns_an_ordered_check_report(self):
        status, body = _post(
            self.url(), {"protocol": "rtsp", "streamUrl": "rtsp://cam.local:554/sub", "frames": 3}
        )
        self.assertEqual(status, 200)
        data = body["data"]
        self.assertTrue(data["reachable"])
        self.assertEqual(data["framesRead"], 3)
        self.assertEqual(
            [c["name"] for c in data["checks"]], list(stream_probe.CHECK_ORDER)
        )

    def test_credentials_are_applied_to_the_uri_but_never_returned(self):
        status, body = _post(
            self.url(),
            {
                "protocol": "rtsp",
                "streamUrl": "rtsp://cam.local:554/sub",
                "credentials": {"username": "admin", "password": "hunter2"},
            },
        )
        self.assertEqual(status, 200)
        # The probe really was given a credentialed URI...
        self.assertIn("admin:hunter2@", BUILT_CONFIGS[0]["uri"])
        # ...and none of it comes back out.
        serialized = json.dumps(body)
        self.assertNotIn("hunter2", serialized)
        self.assertNotIn("admin", serialized)

    def test_a_rejected_credential_is_diagnosed_as_authentication(self):
        BUILD_BEHAVIOUR["mode"] = "unauthorized"
        status, body = _post(
            self.url(),
            {
                "protocol": "rtsp",
                "streamUrl": "rtsp://cam.local:554/sub",
                "credentials": {"username": "admin", "password": "wrong"},
            },
        )
        self.assertEqual(status, 200)
        data = body["data"]
        checks = {c["name"]: c["status"] for c in data["checks"]}
        self.assertTrue(data["reachable"])
        self.assertEqual(data["authentication"], "failed")
        self.assertEqual(checks["authentication"], "fail")
        self.assertEqual(checks["stream-open"], "not-executed")

    def test_the_declared_protocol_selects_the_source_and_the_uri_is_never_sniffed(self):
        _post(self.url(), {"protocol": "onvif", "streamUrl": "rtsp://cam.local/sub"})
        self.assertEqual(BUILT_CONFIGS[0]["type"], "rtsp")

    def test_a_real_transport_yields_hardware_evidence(self):
        _, body = _post(self.url(), {"protocol": "rtsp", "streamUrl": "rtsp://cam.local/sub"})
        self.assertEqual(body["data"]["evidenceClass"], "hardware")

    def test_bounds_are_clamped_rather_than_rejected(self):
        # An installer typo must not 400 a diagnostic tool they are already struggling with.
        status, body = _post(
            self.url(),
            {"streamUrl": "rtsp://cam.local/sub", "timeoutSeconds": 9999, "frames": 9999},
        )
        self.assertEqual(status, 200)
        self.assertLessEqual(body["data"]["framesRead"], 30)

    def test_non_numeric_bounds_are_a_bad_request(self):
        status, _ = _post(self.url(), {"streamUrl": "rtsp://cam.local/sub", "frames": "lots"})
        self.assertEqual(status, 400)


class ApplyCredentialsTests(unittest.TestCase):
    """The one place in the platform that assembles a credentialed URI."""

    def test_reports_that_no_credentials_were_applied(self):
        uri, credentialed = _apply_credentials("rtsp://cam.local/sub", None)
        self.assertEqual(uri, "rtsp://cam.local/sub")
        self.assertFalse(credentialed)

    def test_escapes_characters_that_would_otherwise_break_the_uri(self):
        uri, credentialed = _apply_credentials(
            "rtsp://cam.local/sub", {"username": "ad min", "password": "p@ss/word"}
        )
        self.assertTrue(credentialed)
        # An unescaped `@` or `/` in a password silently truncates the host — a real and maddening
        # field failure, since the camera then looks unreachable rather than misconfigured.
        self.assertEqual(uri, "rtsp://ad%20min:p%40ss%2Fword@cam.local/sub")

    def test_an_empty_username_is_not_credentials(self):
        uri, credentialed = _apply_credentials(
            "rtsp://cam.local/sub", {"username": "", "password": "x"}
        )
        self.assertEqual(uri, "rtsp://cam.local/sub")
        self.assertFalse(credentialed)


if __name__ == "__main__":
    unittest.main()
