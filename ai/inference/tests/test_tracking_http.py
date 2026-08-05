"""Tracking over real HTTP (P-8 Phase 4) — the routes the operator pages read.

Spins the real stdlib server on an ephemeral port and drives it over urllib, exactly like
`test_server.py`. The point is the **transport contract**: tenant scoping, fail-closed behaviour, the
shape the console parses, and that `/infer` is what produces a track in the first place.

⚠️ Frames go in through `POST /infer` — the same endpoint media uses — rather than by calling the
tracker directly. A tracking API that works when driven by a test but not by the frame path is the
defect this file exists to catch.
"""

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
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from server import build_server, runtime_view  # noqa: E402

KEY = "internal-key-at-least-16-chars"
IMG = base64.b64encode(b"a-fake-jpeg-frame").decode("ascii")
MANIFESTS_DIR = os.path.join(os.path.dirname(__file__), "..", "manifests")


def _get(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _get_text(url, headers=None):
    """`/metrics` is Prometheus text, not JSON."""
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310 - localhost test
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


def _post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:  # noqa: S310
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


class TrackingHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tracker = RuntimeTracker(TrackingOptions(min_hits=1, max_age=4))
        registry = CapabilityRegistry("0.1.0", tracker=cls.tracker)
        registry.load_from_dir(
            MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter()
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

    def feed(self, tenant="tnt_a", camera="cam_1", frames=4, second=0):
        """Push frames through the REAL /infer route, which is how media produces tracks."""
        for i in range(frames):
            status, _ = _post(
                self.base("/infer"),
                {
                    "context": {"tenantId": tenant},
                    "frame": {
                        "cameraId": camera,
                        "seq": i,
                        "capturedAt": f"2026-08-05T09:00:{second + i:02d}.000Z",
                    },
                    "imageBase64": IMG,
                },
                {"content-type": "application/json", "x-internal-key": KEY},
            )
            self.assertEqual(status, 200)

    # --- the routes ------------------------------------------------------------

    def test_inference_produces_tracks_and_the_detections_carry_ids(self):
        self.feed(tenant="tnt_http", camera="cam_a")
        status, body = _post(
            self.base("/infer"),
            {
                "context": {"tenantId": "tnt_http"},
                "frame": {"cameraId": "cam_a", "seq": 9, "capturedAt": "2026-08-05T09:00:09.000Z"},
                "imageBase64": IMG,
            },
            {"content-type": "application/json", "x-internal-key": KEY},
        )
        self.assertEqual(status, 200)
        detections = body["data"]["detections"]
        self.assertTrue(detections, "the fake backend produced no detections to track")
        self.assertTrue(
            all(d.get("trackingId") for d in detections),
            "a detection came back from /infer with no trackingId",
        )

    def test_tracking_stats_route(self):
        self.feed(tenant="tnt_stats", camera="cam_s")
        status, body = _get(self.base("/tracking"), {"x-tenant-id": "tnt_stats"})
        self.assertEqual(status, 200)
        self.assertTrue(body["data"]["enabled"])
        self.assertEqual(body["data"]["engine"]["associator"], "predictive-iou")
        self.assertGreaterEqual(body["data"]["stats"]["activeTracks"], 1)

    def test_live_tracks_route_returns_contract_shaped_tracks(self):
        self.feed(tenant="tnt_live", camera="cam_l")
        status, body = _get(self.base("/tracking/tracks"), {"x-tenant-id": "tnt_live"})
        self.assertEqual(status, 200)
        tracks = body["data"]["tracks"]
        self.assertTrue(tracks)
        first = tracks[0]
        for field in ("trackId", "tenantId", "cameraId", "label", "state", "bbox", "identityId"):
            self.assertIn(field, first, f"the Track payload is missing {field}")
        self.assertEqual(first["schemaVersion"], "1.1")
        self.assertEqual(first["tenantId"], "tnt_live")

    def test_track_detail_route_carries_the_timeline(self):
        self.feed(tenant="tnt_detail", camera="cam_d")
        _, listing = _get(self.base("/tracking/tracks"), {"x-tenant-id": "tnt_detail"})
        track_id = listing["data"]["tracks"][0]["trackId"]
        status, body = _get(self.base(f"/tracking/tracks/{track_id}"), {"x-tenant-id": "tnt_detail"})
        self.assertEqual(status, 200)
        self.assertEqual(body["data"]["track"]["trackId"], track_id)
        self.assertTrue(body["data"]["timeline"], "a track came back with an empty lifecycle")
        self.assertIn("to", body["data"]["timeline"][0])

    def test_camera_filter(self):
        self.feed(tenant="tnt_filter", camera="cam_one")
        self.feed(tenant="tnt_filter", camera="cam_two")
        _, all_tracks = _get(self.base("/tracking/tracks"), {"x-tenant-id": "tnt_filter"})
        _, filtered = _get(
            self.base("/tracking/tracks?cameraId=cam_one"), {"x-tenant-id": "tnt_filter"}
        )
        self.assertGreater(len(all_tracks["data"]["tracks"]), len(filtered["data"]["tracks"]))
        self.assertTrue(all(t["cameraId"] == "cam_one" for t in filtered["data"]["tracks"]))

    # --- fail-closed -----------------------------------------------------------

    def test_per_camera_route_reports_each_camera(self):
        self.feed(tenant="tnt_cams", camera="cam_one")
        self.feed(tenant="tnt_cams", camera="cam_two")
        status, body = _get(self.base("/tracking/cameras"), {"x-tenant-id": "tnt_cams"})
        self.assertEqual(status, 200)
        rows = {c["cameraId"]: c for c in body["data"]["cameras"]}
        self.assertEqual(sorted(rows), ["cam_one", "cam_two"])
        self.assertGreaterEqual(rows["cam_one"]["framesTracked"], 1)
        self.assertIn("trackingFps", rows["cam_one"])
        self.assertIn("averageTrackingMs", rows["cam_one"])

    def test_per_camera_route_never_shows_another_tenants_cameras(self):
        self.feed(tenant="tnt_theirs", camera="cam_private")
        _, body = _get(self.base("/tracking/cameras"), {"x-tenant-id": "tnt_ours"})
        self.assertEqual(body["data"]["cameras"], [])
        self.assertNotIn("cam_private", json.dumps(body))

    def test_every_tracking_route_requires_a_tenant(self):
        """⚠️ A read path that works without a tenant is one API change away from leaking movements."""
        for path in ("/tracking", "/tracking/cameras", "/tracking/tracks", "/tracking/tracks/anything"):
            status, body = _get(self.base(path))
            self.assertEqual(status, 400, f"{path} answered without a tenant")
            self.assertIn("x-tenant-id", body["error"]["message"])

    def test_a_tenant_cannot_read_another_tenants_track(self):
        self.feed(tenant="tnt_owner", camera="cam_o")
        _, listing = _get(self.base("/tracking/tracks"), {"x-tenant-id": "tnt_owner"})
        track_id = listing["data"]["tracks"][0]["trackId"]
        status, _ = _get(self.base(f"/tracking/tracks/{track_id}"), {"x-tenant-id": "tnt_intruder"})
        self.assertEqual(status, 404, "a track was readable across a tenant boundary")

    def test_a_tenant_with_no_tracks_gets_an_empty_list_not_everyone_elses(self):
        self.feed(tenant="tnt_busy", camera="cam_b")
        _, body = _get(self.base("/tracking/tracks"), {"x-tenant-id": "tnt_empty"})
        self.assertEqual(body["data"]["tracks"], [])

    def test_an_unknown_track_is_404(self):
        status, _ = _get(self.base("/tracking/tracks/trk_nope"), {"x-tenant-id": "tnt_a"})
        self.assertEqual(status, 404)

    # --- the runtime's self-description ----------------------------------------

    def test_runtime_reports_tracking_without_naming_a_tenant(self):
        self.feed(tenant="tnt_runtime", camera="cam_r")
        status, body = _get(self.base("/runtime"))
        self.assertEqual(status, 200)
        tracking = body["data"]["tracking"]
        self.assertTrue(tracking["enabled"])
        self.assertGreaterEqual(tracking["stats"]["camerasTracked"], 1)
        # ⚠️ The whole payload must carry no tenant identifiers — this endpoint is not tenant-scoped.
        self.assertNotIn("tnt_runtime", json.dumps(body))

    def test_prometheus_carries_tracking_and_omits_what_it_cannot_measure(self):
        """⚠️ ADR-0039 in the one place it is hardest to honour: Prometheus has no null, so an
        unmeasurable metric must be ABSENT. A zero here would be a verified-looking claim that the
        deployment had never mistaken one person for another, which nothing checked."""
        self.feed(tenant="tnt_prom", camera="cam_p")
        status, text = _get_text(self.base("/metrics"))
        self.assertEqual(status, 200)
        for series in (
            "inference_tracking_enabled",
            "inference_tracking_active",
            "inference_tracking_created_total",
            "inference_tracking_terminated_total",
            "inference_tracking_recovered_total",
            "inference_tracking_occlusions_total",
            "inference_tracking_crossings_total",
            "inference_tracking_frames_total",
            "inference_tracking_ground_truth_available",
        ):
            self.assertIn(f"\n{series} ", f"\n{text}", f"{series} is missing from /metrics")
        for absent in ("identity_switch", "reidentification_success", "false_recover"):
            self.assertNotIn(absent, text, f"a ground-truth metric was published as a number: {absent}")
        self.assertIn("inference_tracking_ground_truth_available 0", text)
        # No tenant or camera labels: this scrape is not tenant-scoped.
        self.assertNotIn("tnt_prom", text)
        self.assertNotIn("cam_p", text)


class TrackingDisabledTests(unittest.TestCase):
    """A runtime with tracking switched off must SAY so, not look like an idle one."""

    @classmethod
    def setUpClass(cls) -> None:
        from pipeline import NoopTracker

        registry = CapabilityRegistry("0.1.0", tracker=NoopTracker())
        registry.load_from_dir(
            MANIFESTS_DIR, lambda _m: FakeModelResolver(), lambda _m: FakeModelAdapter()
        )
        cls.registry = registry
        cls.httpd = build_server("127.0.0.1", 0, registry, KEY, "inference", "0.1.0")
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()

    def test_tracking_route_says_not_enabled(self):
        status, body = _get(
            f"http://127.0.0.1:{self.port}/tracking", {"x-tenant-id": "tnt_a"}
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["data"]["enabled"])
        self.assertIn("not enabled", body["data"]["detail"])

    def test_runtime_view_reports_tracking_disabled(self):
        self.assertFalse(
            runtime_view(self.registry, None, "inference", "0.1.0")["tracking"]["enabled"]
        )

    def test_detections_carry_no_tracking_id(self):
        status, body = _post(
            f"http://127.0.0.1:{self.port}/infer",
            {
                "context": {"tenantId": "tnt_a"},
                "frame": {"cameraId": "cam_1", "seq": 1, "capturedAt": "2026-08-05T09:00:00.000Z"},
                "imageBase64": IMG,
            },
            {"content-type": "application/json", "x-internal-key": KEY},
        )
        self.assertEqual(status, 200)
        self.assertTrue(
            all("trackingId" not in d for d in body["data"]["detections"]),
            "tracking is off but detections still carry track ids",
        )


if __name__ == "__main__":
    unittest.main()
