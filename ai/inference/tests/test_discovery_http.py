"""P-1: the ONVIF discovery endpoint the camera service calls.

Discovery lives in the AI runtime only because the ONVIF implementation does (AI-5e built it for the
certification harness). It is a **read-only capability**, not a runtime concern: no session is
created, no frame is decoded, no tenant data is touched — the camera service owns the onboarding
workflow and calls this.

The real transports are swapped for the deterministic simulated ones, so these tests open no socket
and probe no network. The one property worth guarding hardest is that a device's credentialed stream
URI never reaches the response.
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import onvif  # noqa: E402
from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import build_server  # noqa: E402
from tests.test_onvif import (  # noqa: E402
    CAPABILITIES,
    DEVICE_INFO,
    PROBE_MATCH,
    PROFILES,
    STREAM_URI,
)

KEY = "internal-key-at-least-16-chars"
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


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


class _StubDiscovery:
    """Stands in for `UdpDiscoveryTransport` — same shape, no socket."""

    payloads = [PROBE_MATCH]

    def __init__(self, *_args, **_kwargs) -> None:
        return None

    def probe(self, *, timeout_seconds: float = 3.0):
        return list(self.payloads)


class _StubSoap(onvif.SimulatedSoapTransport):
    def __init__(self, *_args, **_kwargs) -> None:
        super().__init__(
            {
                "GetDeviceInformation": DEVICE_INFO,
                "GetCapabilities": CAPABILITIES,
                "GetProfiles": PROFILES,
                "GetStreamUri": STREAM_URI,
            }
        )


class _FailingDiscovery(_StubDiscovery):
    def probe(self, *, timeout_seconds: float = 3.0):
        raise OSError("multicast is not permitted in this network namespace")


class DiscoveryEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(
            MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter()
        )
        cls.httpd = build_server("127.0.0.1", 0, registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def setUp(self) -> None:
        # The endpoint imports the transports lazily, so patching the module attributes is enough —
        # and it means the production code path is exercised verbatim, not a test-only branch.
        self._real = (onvif.UdpDiscoveryTransport, onvif.HttpSoapTransport)
        onvif.UdpDiscoveryTransport = _StubDiscovery
        onvif.HttpSoapTransport = _StubSoap

    def tearDown(self) -> None:
        onvif.UdpDiscoveryTransport, onvif.HttpSoapTransport = self._real

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/discovery/onvif"

    def test_it_requires_the_internal_key(self) -> None:
        status, body = _post(self.url(), {}, headers={"content-type": "application/json"})
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthenticated")

    def test_an_empty_body_is_valid_here(self) -> None:
        # Discovery takes no required input. Every other route still rejects an empty body.
        status, body = _post(self.url(), None)
        self.assertEqual(status, 200, body)

    def test_it_returns_the_discovered_device_with_capabilities(self) -> None:
        status, body = _post(self.url(), {"timeoutSeconds": 1})
        self.assertEqual(status, 200, body)
        data = body["data"]
        self.assertEqual(len(data["devices"]), 1)
        device = data["devices"][0]
        self.assertEqual(device["metadata"]["manufacturer"], "Hikvision")
        self.assertEqual(device["metadata"]["firmware"], "V5.7.3")
        self.assertEqual(device["registryId"], "hikvision-ds-2cd2143g2")
        self.assertTrue(device["capabilities"]["onvif"])
        self.assertTrue(device["capabilities"]["ptz"])
        self.assertEqual(device["capabilities"]["fpsRange"], {"min": 10, "max": 25})
        self.assertIn("probedSeconds", data)

    def test_the_suggested_url_uses_the_sub_stream_and_carries_no_credentials(self) -> None:
        """The device's own `GetStreamUri` reply embeds `admin:hunter2@`. That must never reach a
        camera record — the URL is rebuilt from the host plus the discovered path instead."""
        _, body = _post(self.url(), {"timeoutSeconds": 1})
        device = body["data"]["devices"][0]
        url = device["suggestedStreamUrl"]
        self.assertNotIn("hunter2", url)
        self.assertNotIn("@", url)
        self.assertTrue(url.startswith("rtsp://192.168.1.64:554/"))
        self.assertIn("/Streaming/Channels/102", url)  # the sub-stream, not the 2560x1440 main

    def test_no_secret_appears_anywhere_in_the_response(self) -> None:
        _, body = _post(self.url(), {"timeoutSeconds": 1})
        self.assertNotIn("hunter2", json.dumps(body))

    def test_a_blocked_multicast_is_reported_as_unavailable_not_as_an_empty_network(self) -> None:
        """An installer told "no cameras found" goes and checks the cameras. Told "multicast could
        not run here", they check the network — which is where the problem actually is."""
        onvif.UdpDiscoveryTransport = _FailingDiscovery
        status, body = _post(self.url(), {"timeoutSeconds": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["devices"], [])
        self.assertIn("could not run", body["data"]["unavailable"])

    def test_a_device_that_refuses_negotiation_is_returned_with_a_warning(self) -> None:
        # Bad credentials or ONVIF partially disabled. The device still exists and is still worth
        # showing — dropping it would tell an installer their camera is not on the network.
        class _RefusingSoap(onvif.SimulatedSoapTransport):
            def __init__(self, *_a, **_k) -> None:
                super().__init__({})

        onvif.HttpSoapTransport = _RefusingSoap
        _, body = _post(self.url(), {"timeoutSeconds": 1})
        device = body["data"]["devices"][0]
        self.assertIn("negotiation failed", device["warning"])
        self.assertEqual(device["metadata"]["model"], "DS-2CD2143G2")  # from the probe scopes

    def test_an_out_of_range_timeout_is_clamped_not_rejected(self) -> None:
        status, body = _post(self.url(), {"timeoutSeconds": 900})
        self.assertEqual(status, 200, body)

    def test_a_non_numeric_timeout_is_a_bad_request(self) -> None:
        status, body = _post(self.url(), {"timeoutSeconds": "soon"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")


if __name__ == "__main__":
    unittest.main()
