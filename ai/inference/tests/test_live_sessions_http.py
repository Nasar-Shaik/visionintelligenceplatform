"""AI-5b — the live-session HTTP surface over the real stdlib server.

Proves the transport additions are genuinely ADDITIVE: a `POST /sessions` without `source` behaves
exactly as it did at G-3, while one WITH a source starts a live pipeline and exposes its metrics and
stream diagnostics. Deterministic: the source is `simulated`, so no camera or network is involved.
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from server import build_server  # noqa: E402
from session_runner import SessionSupervisor  # noqa: E402
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


class LiveSessionHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter())
        cls.sessions = SessionManager()
        cls.supervisor = SessionSupervisor(cls.sessions, max_sessions=2)
        cls.httpd = build_server(
            "127.0.0.1", 0, registry, KEY, "inference", "0.1.0",
            sessions=cls.sessions, supervisor=cls.supervisor,
            # Silence operational logging in tests; production keeps the stderr sink.
            live_defaults={"queue_size": 8, "target_fps": 5.0, "backend": "stub", "log_sink": lambda _r: None},
        )
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.supervisor.shutdown()
        cls.httpd.shutdown()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def hdr(self, tenant="tnt_a"):
        return {"x-internal-key": KEY, "x-tenant-id": tenant, "content-type": "application/json"}

    def _start_live(self, *, tenant="tnt_a", camera="cam_1", frames=10):
        return _req(
            self.url("/sessions"), "POST", self.hdr(tenant),
            {
                "cameraId": camera,
                "capabilityId": "perception.person-detection",
                "correlationId": "corr_http",
                "source": {"type": "simulated", "uri": "sim://cam", "options": {"totalFrames": frames}},
            },
        )

    def test_a_session_without_a_source_is_unchanged_from_g3(self) -> None:
        status, body = _req(
            self.url("/sessions"), "POST", self.hdr(),
            {"cameraId": "cam_batch", "capabilityId": "perception.person-detection"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(body["data"]["state"], "running")
        self.assertNotIn("ingestion", body["data"])  # no live tier attached

    def test_a_session_with_a_source_starts_a_live_pipeline(self) -> None:
        status, body = self._start_live(camera="cam_live")
        self.assertEqual(status, 201)
        data = body["data"]
        self.assertEqual(data["identity"]["cameraId"], "cam_live")
        self.assertEqual(data["identity"]["correlationId"], "corr_http")
        self.assertIn("ingestion", data)
        self.assertIn("backpressure", data)

    def test_metrics_and_stream_diagnostics_are_exposed(self) -> None:
        _, body = self._start_live(camera="cam_metrics")
        session_id = body["data"]["identity"]["sessionId"]

        status, metrics = _req(self.url(f"/sessions/{session_id}/metrics"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertIn("framesProcessed", metrics["data"])
        self.assertIn("streamAvailability", metrics["data"])
        self.assertIn("queueHighWatermark", metrics["data"])

        status, diag = _req(self.url(f"/sessions/{session_id}/stream"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertIn("ingestion", diag["data"])
        self.assertEqual(diag["data"]["ingestion"]["sourceType"], "simulated")

    def test_live_diagnostics_are_tenant_scoped(self) -> None:
        _, body = self._start_live(camera="cam_iso")
        session_id = body["data"]["identity"]["sessionId"]
        status, _ = _req(self.url(f"/sessions/{session_id}/stream"), "GET", self.hdr("tnt_other"))
        self.assertEqual(status, 404)  # invisible, never "forbidden"

    def test_a_bad_source_config_is_a_400_not_a_retry_loop(self) -> None:
        status, body = _req(
            self.url("/sessions"), "POST", self.hdr(),
            {
                "cameraId": "cam_bad",
                "capabilityId": "perception.person-detection",
                "source": {"type": "carrier-pigeon", "uri": "pigeon://roof"},
            },
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")

    def test_capacity_is_enforced_with_409(self) -> None:
        self.supervisor.shutdown()  # start from a known-empty fleet (max_sessions=2)
        self.assertEqual(self._start_live(camera="cap_1")[0], 201)
        self.assertEqual(self._start_live(camera="cap_2")[0], 201)
        status, body = self._start_live(camera="cap_3")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "conflict")
        self.supervisor.shutdown()

    def test_supervisor_capacity_view(self) -> None:
        status, body = _req(self.url("/supervisor"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertIn("activeSessions", body["data"])
        self.assertEqual(body["data"]["maxSessions"], 2)

    def test_live_requires_the_internal_key(self) -> None:
        status, _ = _req(
            self.url("/sessions"), "POST", {"content-type": "application/json"},
            {"cameraId": "c", "capabilityId": "perception.person-detection"},
        )
        self.assertEqual(status, 401)



class SchedulerHttpTests(unittest.TestCase):
    """AI-5c: the additive scheduler/SLA/resource views over the real server."""

    @classmethod
    def setUpClass(cls) -> None:
        from compute import ComputeRegistry, ComputeResource
        from resources import ResourceAccountant
        from scheduler import InferenceScheduler, SchedulerPolicy

        registry = CapabilityRegistry("0.1.0")
        registry.load_from_dir(MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter())
        cls.sessions = SessionManager()
        compute = ComputeRegistry([ComputeResource(id="cpu:0", kind="cpu", capacity_units=16.0)])
        cls.scheduler = InferenceScheduler(
            compute,
            ResourceAccountant(),
            policy=SchedulerPolicy(reserved_capacity_percent=0.0),
            max_sessions=4,
        )
        cls.supervisor = SessionSupervisor(
            cls.sessions, max_sessions=4, scheduler=cls.scheduler
        )
        cls.httpd = build_server(
            "127.0.0.1", 0, registry, KEY, "inference", "0.1.0",
            sessions=cls.sessions, supervisor=cls.supervisor,
            live_defaults={"queue_size": 8, "target_fps": 5.0, "backend": "stub", "log_sink": lambda _r: None},
        )
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.supervisor.shutdown()
        cls.httpd.shutdown()

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def hdr(self, tenant="tnt_a"):
        return {"x-internal-key": KEY, "x-tenant-id": tenant, "content-type": "application/json"}

    def _start(self, camera="cam_s1"):
        return _req(
            self.url("/sessions"), "POST", self.hdr(),
            {"cameraId": camera, "capabilityId": "perception.person-detection",
             "source": {"type": "simulated", "uri": "sim://cam", "options": {"totalFrames": 8}}},
        )

    def test_scheduler_view_reports_strategy_and_placement(self):
        self._start()
        status, body = _req(self.url("/scheduler"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["strategy"], "weighted-fair")
        self.assertTrue(body["data"]["computeResources"])

    def test_sla_and_resource_views_are_tenant_scoped(self):
        self._start(camera="cam_s2")
        status, sla = _req(self.url("/sla"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertTrue(all(row["identity"]["tenantId"] == "tnt_a" for row in sla["data"]))

        status, usage = _req(self.url("/resources"), "GET", self.hdr())
        self.assertEqual(status, 200)
        self.assertTrue(usage["data"])
        self.assertIn("inferenceLatencyMs", usage["data"][0])

        # Another tenant sees none of it.
        _, other = _req(self.url("/sla"), "GET", self.hdr("tnt_zzz"))
        self.assertEqual(other["data"], [])

    def test_sla_requires_a_tenant(self):
        status, _ = _req(self.url("/sla"), "GET", {"x-internal-key": KEY})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
