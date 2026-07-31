"""AI-2 tracking tests — association, TrackManager lifecycle + id policy + bounded history, pure-
geometry zones, business-neutral counting (confirmed tracks only), tracking events, and analyzer
integration with multi-camera isolation. Deterministic, stdlib-only. The point is tracker-
independence: nothing here mentions a specific algorithm beyond the default IoU associator."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts import Detection  # noqa: E402
from counting import CountingEngine  # noqa: E402
from events import counting_event, zone_transition_event  # noqa: E402
from tracker import Association, IouAssociator, iou  # noqa: E402
from track_manager import TrackManager  # noqa: E402
from tracking_contracts import Track, TrackQuality, TrackState, Zone  # noqa: E402
from zones import ZoneEngine, point_in_polygon, segments_intersect  # noqa: E402


def det(label="person", conf=0.9, bbox=(0.4, 0.4, 0.1, 0.1), class_id=0):
    return Detection(label=label, confidence=conf, bbox=bbox, class_id=class_id)


def confirmed_track(track_id, centroid, camera="cam_1", tenant="tnt_a"):
    x, y = centroid
    return Track(
        track_id=track_id, tenant_id=tenant, camera_id=camera, label="person",
        state=TrackState.CONFIRMED, confidence=0.9, bbox=(x - 0.01, y - 0.01, 0.02, 0.02),
        first_seen_frame=0, first_seen_at="0s", last_seen_frame=5, last_seen_at="5s",
        age=5, hits=6, centroid=(x, y), quality=TrackQuality(tracking_confidence=0.9),
    )


class AssociatorTests(unittest.TestCase):
    def test_iou_and_greedy_association(self):
        self.assertAlmostEqual(iou((0, 0, 1, 1), (0, 0, 1, 1)), 1.0)
        self.assertEqual(iou((0, 0, 0.1, 0.1), (0.9, 0.9, 0.1, 0.1)), 0.0)
        tracks = [confirmed_track("t1", (0.45, 0.45))]
        assoc = IouAssociator(min_iou=0.1).associate([det(bbox=(0.44, 0.44, 0.02, 0.02))], tracks)
        self.assertEqual(len(assoc.matches), 1)
        self.assertEqual(assoc.matches[0][0], "t1")
        self.assertEqual(assoc.unmatched_detections, [])

    def test_label_mismatch_and_low_iou_leave_unmatched(self):
        tracks = [confirmed_track("t1", (0.1, 0.1))]
        assoc = IouAssociator(min_iou=0.3).associate([det(label="car", bbox=(0.8, 0.8, 0.1, 0.1))], tracks)
        self.assertEqual(assoc.matches, [])
        self.assertEqual(assoc.unmatched_detections, [0])
        self.assertEqual(assoc.unmatched_tracks, ["t1"])


class TrackManagerTests(unittest.TestCase):
    def _mgr(self, **kw):
        return TrackManager(IouAssociator(min_iou=0.1), session_id="sess_1", **kw)

    def test_lifecycle_created_tentative_confirmed(self):
        mgr = self._mgr(min_hits=3)
        d = det(bbox=(0.4, 0.4, 0.1, 0.1))
        s0 = mgr.update([d], tenant_id="tnt_a", camera_id="cam_1", frame_index=0, at="0s")
        self.assertEqual(s0[0].state, TrackState.CREATED)
        mgr.update([d], tenant_id="tnt_a", camera_id="cam_1", frame_index=1, at="1s")
        s2 = mgr.update([d], tenant_id="tnt_a", camera_id="cam_1", frame_index=2, at="2s")
        self.assertEqual(s2[0].state, TrackState.CONFIRMED)
        self.assertEqual(s2[0].hits, 3)

    def test_lost_then_removed(self):
        mgr = self._mgr(min_hits=1, max_age=2)
        d = det()
        mgr.update([d], tenant_id="tnt_a", camera_id="cam_1", frame_index=0, at="0s")
        s1 = mgr.update([], tenant_id="tnt_a", camera_id="cam_1", frame_index=1, at="1s")
        self.assertEqual(s1[0].state, TrackState.LOST)
        mgr.update([], tenant_id="tnt_a", camera_id="cam_1", frame_index=2, at="2s")
        s3 = mgr.update([], tenant_id="tnt_a", camera_id="cam_1", frame_index=3, at="3s")
        self.assertEqual(s3, [])  # removed + archived
        self.assertEqual(mgr.stats()["removedTracks"], 1)

    def test_id_policy_unique_session_scoped_never_reused(self):
        mgr = self._mgr(min_hits=1, max_age=0)
        mgr.update([det(bbox=(0.1, 0.1, 0.05, 0.05))], tenant_id="tnt_a", camera_id="cam_1", frame_index=0, at="0s")
        # drop it, then a new detection elsewhere → a NEW id (never reuses trk_..._1).
        mgr.update([], tenant_id="tnt_a", camera_id="cam_1", frame_index=1, at="1s")
        s = mgr.update([det(bbox=(0.8, 0.8, 0.05, 0.05))], tenant_id="tnt_a", camera_id="cam_1", frame_index=2, at="2s")
        self.assertEqual(s[0].track_id, "trk_cam_1_sess_1_2")
        self.assertEqual(s[0].session_id, "sess_1")

    def test_bounded_history(self):
        mgr = self._mgr(min_hits=1, history_max=3)
        d = det(bbox=(0.4, 0.4, 0.2, 0.2))
        track = None
        for i in range(6):
            track = mgr.update([d], tenant_id="tnt_a", camera_id="cam_1", frame_index=i, at=f"{i}s")[0]
        self.assertLessEqual(len(track.history), 3)


class ZoneEngineTests(unittest.TestCase):
    def test_point_in_polygon(self):
        square = [(0.0, 0.0), (0.5, 0.0), (0.5, 0.5), (0.0, 0.5)]
        self.assertTrue(point_in_polygon((0.25, 0.25), square))
        self.assertFalse(point_in_polygon((0.75, 0.75), square))

    def test_segments_intersect(self):
        self.assertTrue(segments_intersect((0, 0), (1, 1), (0, 1), (1, 0)))
        self.assertFalse(segments_intersect((0, 0), (0.1, 0.1), (0.9, 0.9), (1, 1)))

    def test_areas_containing_is_camera_scoped(self):
        z = Zone.from_dict({"id": "z1", "cameraId": "cam_1", "name": "a", "kind": "area",
                            "geometry": {"points": [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]}})
        eng = ZoneEngine()
        self.assertEqual(eng.areas_containing((0.25, 0.25), [z], "cam_1"), ["z1"])
        self.assertEqual(eng.areas_containing((0.25, 0.25), [z], "cam_2"), [])  # different camera


class CountingEngineTests(unittest.TestCase):
    def _zone(self):
        return Zone.from_dict({"id": "z1", "cameraId": "cam_1", "name": "entrance", "kind": "area",
                               "geometry": {"points": [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]}})

    def test_enter_exit_occupancy_on_confirmed_only(self):
        eng = CountingEngine()
        outside = confirmed_track("t1", (0.1, 0.1))
        tr, snaps = eng.update([self._zone()], [outside], frame_index=0, at="0s")
        self.assertEqual(tr, [])
        inside = confirmed_track("t1", (0.5, 0.5))
        tr, snaps = eng.update([self._zone()], [inside], frame_index=1, at="1s")
        self.assertEqual(len(tr), 1)
        self.assertEqual(tr[0].transition, "entered")
        self.assertEqual(snaps[0].occupancy, 1)
        # move out → exit
        tr, snaps = eng.update([self._zone()], [confirmed_track("t1", (0.1, 0.1))], frame_index=2, at="2s")
        self.assertEqual(tr[0].transition, "exited")
        self.assertEqual(snaps[0].occupancy, 0)

    def test_tentative_tracks_are_not_counted(self):
        eng = CountingEngine()
        t = confirmed_track("t1", (0.5, 0.5))
        t.state = TrackState.TENTATIVE
        tr, snaps = eng.update([self._zone()], [t], frame_index=0, at="0s")
        self.assertEqual(tr, [])


class TrackingEventTests(unittest.TestCase):
    def test_zone_transition_event_shape(self):
        ev = zone_transition_event(
            {"tenantId": "tnt_a", "cameraId": "cam_1", "zoneId": "z1", "trackId": "t1",
             "transition": "entered", "frameIndex": 3, "at": "3s", "confidence": 0.9, "sessionId": "sess_1"},
            id_gen=lambda: "evt_1",
        )
        self.assertEqual(ev["type"], "spatial.zone.entered")
        self.assertEqual(ev["category"], "perception")
        self.assertEqual(ev["confidence"], 0.9)
        self.assertEqual(ev["cameraId"], "cam_1")
        self.assertEqual(ev["payload"]["sessionId"], "sess_1")
        self.assertFalse(ev["type"].startswith("incident."))

    def test_counting_event_shape(self):
        ev = counting_event(
            {"tenantId": "tnt_a", "cameraId": "cam_1", "zoneId": "z1", "entered": 2, "exited": 1, "occupancy": 1, "at": "5s"},
            id_gen=lambda: "evt_2",
        )
        self.assertEqual(ev["type"], "analytics.occupancy.changed")
        self.assertEqual(ev["category"], "analytics")
        self.assertEqual(ev["payload"]["occupancy"], 1)


class AnalyzerIntegrationTests(unittest.TestCase):
    def _run(self, camera_id="cam_1", zones=None):
        from adapters.fake_adapter import FakeModelAdapter
        from video_analyzer import AnalyzeOptions, VideoAnalyzer
        from video_decoder import StubFrameDecoder

        opts = AnalyzeOptions(
            tenant_id="tnt_a", camera_id=camera_id, labels=("person",),
            session_id="sess_1", track_min_hits=3, zones=tuple(zones or ()),
        )
        analyzer = VideoAnalyzer(FakeModelAdapter(), opts)
        return analyzer.analyze(StubFrameDecoder.synthetic(5))

    def test_tracks_and_zone_counting_flow_end_to_end(self):
        # The stub detection sits at centroid (0.5, 0.5); a central zone captures the confirmed track.
        zone = {"id": "z_center", "cameraId": "cam_1", "name": "center", "kind": "area",
                "geometry": {"points": [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]}}
        result = self._run(zones=[zone])
        # a single continuous track (not 5 detections worth of identities)
        self.assertTrue(result.tracking_stats["activeTracks"] >= 1)
        self.assertTrue(any(t["state"] == "confirmed" for t in result.tracks))
        # entered the zone once confirmed → an entry transition + occupancy event
        self.assertTrue(len(result.zone_transitions) >= 1)
        self.assertEqual(result.zone_transitions[0]["transition"], "entered")
        self.assertTrue(any(e["type"] == "spatial.zone.entered" for e in result.events))
        self.assertTrue(any(e["type"] == "analytics.occupancy.changed" for e in result.events))
        # tracking stage timings recorded
        self.assertIn("trackingMs", result.summary["stageTimingsMs"])
        self.assertEqual(result.summary["sessionId"], "sess_1")

    def test_track_ids_carry_camera_identity(self):
        r1 = self._run(camera_id="cam_1")
        r2 = self._run(camera_id="cam_2")
        self.assertTrue(all(t["trackId"].startswith("trk_cam_1_") for t in r1.tracks))
        self.assertTrue(all(t["trackId"].startswith("trk_cam_2_") for t in r2.tracks))
        self.assertTrue(all(t["cameraId"] == "cam_2" for t in r2.tracks))

    def test_tracking_can_be_disabled(self):
        from adapters.fake_adapter import FakeModelAdapter
        from video_analyzer import AnalyzeOptions, VideoAnalyzer
        from video_decoder import StubFrameDecoder

        opts = AnalyzeOptions(tenant_id="tnt_a", labels=("person",), enable_tracking=False)
        result = VideoAnalyzer(FakeModelAdapter(), opts).analyze(StubFrameDecoder.synthetic(3))
        self.assertEqual(result.tracks, [])
        self.assertEqual(result.tracking_stats, {})
        # detection events still flow
        self.assertEqual(len([e for e in result.events if e["type"] == "perception.person.detected"]), 3)


if __name__ == "__main__":
    unittest.main()
