"""AI-3 behavior-analysis tests — temporal window, immutable TrackSnapshot, registry orchestration +
config, the four analyzers (loitering / queue / intrusion / fire-smoke), the BehaviorResult→Event
translator, analyzer independence, replay determinism, and end-to-end analyzer integration with
multi-camera isolation. Deterministic, stdlib-only. The point is behavior-independence: nothing here
optimizes for a specific behavior algorithm — every analyzer is judged only by the BehaviorResult it
produces through the shared contract."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from behavior import (  # noqa: E402
    BehaviorContext,
    BehaviorLifecycleStore,
    BehaviorObservation,
    frame_seconds,
    snapshot_track,
)
from behavior_contracts import BehaviorCategory, BehaviorConfig, BehaviorState  # noqa: E402
from behavior_registry import BehaviorRegistry  # noqa: E402
from behavior_translator import BehaviorResultTranslator, event_type_for_behavior  # noqa: E402
from behaviors import default_registry  # noqa: E402
from behaviors.fire import FireAnalyzer  # noqa: E402
from behaviors.intrusion import IntrusionAnalyzer  # noqa: E402
from behaviors.loitering import LoiteringAnalyzer  # noqa: E402
from behaviors.queue import QueueAnalyzer  # noqa: E402
from contracts import Detection  # noqa: E402
from playground import build_adapter  # noqa: E402
from temporal_window import TemporalWindow, TemporalWindowStore  # noqa: E402
from tracking_contracts import Track, TrackQuality, TrackState, Zone  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402
from zones import ZoneEngine  # noqa: E402


def snap(track_id="trk_1", label="person", state="confirmed", centroid=(0.5, 0.5), camera="cam_1", conf=0.9, hits=5, frame=1):
    x, y = centroid
    t = Track(
        track_id=track_id, tenant_id="tnt_a", camera_id=camera, label=label,
        state=TrackState(state), confidence=conf, bbox=(x - 0.02, y - 0.02, 0.04, 0.04),
        first_seen_frame=0, first_seen_at="0s", last_seen_frame=frame, last_seen_at=f"{frame}s",
        age=frame, hits=hits, centroid=(x, y), quality=TrackQuality(tracking_confidence=conf),
    )
    return snapshot_track(t, frame)


def zone(zone_id="z1", camera="cam_1", attrs=None, points=((0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8))):
    return Zone(id=zone_id, camera_id=camera, name=zone_id, kind=__import__("tracking_contracts").ZoneKind.AREA, points=list(points), attributes=attrs or {})


def ctx(snapshots, zones=(), *, frame=1, at=None, windows=None, camera="cam_1"):
    at = at if at is not None else f"{frame}s"
    return BehaviorContext(
        tenant_id="tnt_a", camera_id=camera, frame_index=frame, at=at, t=frame_seconds(at, frame),
        snapshots=tuple(snapshots), zones=tuple(zones), transitions=(), counting=(),
        windows=windows or TemporalWindowStore(), zone_engine=ZoneEngine(), session_id="sess_1",
    )


class TemporalWindowTests(unittest.TestCase):
    def test_span_and_eviction(self):
        w = TemporalWindow(window_seconds=2.0)
        for t in (0.0, 1.0, 2.0, 3.0):
            w.record(t, 1.0)
        # first sample (t=0) evicted since horizon = 3-2 = 1; retains 1,2,3
        self.assertEqual(w.count(), 3)
        self.assertEqual(w.span_seconds(), 2.0)
        self.assertEqual(w.first_t(), 1.0)

    def test_average(self):
        w = TemporalWindow()
        for v in (2.0, 4.0):
            w.record(0.0, v)
        self.assertEqual(w.average(), 3.0)

    def test_store_is_keyed_per_analyzer_and_subject(self):
        store = TemporalWindowStore()
        a = store.window("loitering", "z1:trk_1")
        b = store.window("loitering", "z1:trk_1")
        c = store.window("queue", "z1")
        self.assertIs(a, b)
        self.assertIsNot(a, c)


class TrackSnapshotTests(unittest.TestCase):
    def test_snapshot_is_frozen_and_carries_identity(self):
        s = snap(camera="cam_9")
        self.assertEqual(s.camera_id, "cam_9")
        self.assertEqual(s.point, (0.5, 0.5))
        with self.assertRaises(Exception):
            s.track_id = "mutated"  # frozen dataclass

    def test_to_dict_camel_case(self):
        d = snap().to_dict()
        self.assertEqual(d["trackId"], "trk_1")
        self.assertIn("trackingConfidence", d)
        self.assertEqual(d["state"], "confirmed")


class RegistryTests(unittest.TestCase):
    def test_registration_order_and_enable_disable(self):
        reg = default_registry()
        self.assertEqual(reg.names(), ["loitering", "queue", "intrusion", "fire"])
        reg.disable("queue")
        self.assertEqual([a.name for a in reg.enabled()], ["loitering", "intrusion", "fire"])
        reg.enable("queue")
        self.assertIn("queue", [a.name for a in reg.enabled()])

    def test_configure_replaces_config(self):
        reg = default_registry()
        cfg = BehaviorConfig(enabled=True, confidence_threshold=0.99)
        reg.configure("fire", cfg)
        self.assertEqual([a for a in reg.enabled() if a.name == "fire"][0].config.confidence_threshold, 0.99)

    def test_duplicate_registration_rejected(self):
        reg = BehaviorRegistry()
        reg.register(FireAnalyzer())
        with self.assertRaises(ValueError):
            reg.register(FireAnalyzer())

    def test_per_analyzer_metrics_recorded(self):
        reg = default_registry()
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        reg.run(ctx([snap()], [zone(attrs={"restricted": True})]), store)
        metrics = {m["analyzer"]: m for m in reg.analyzer_metrics()}
        self.assertEqual(metrics["intrusion"]["executionCount"], 1)
        self.assertGreaterEqual(metrics["intrusion"]["behaviorsProduced"], 1)


class LoiteringTests(unittest.TestCase):
    def test_fires_only_after_dwell_threshold(self):
        reg = BehaviorRegistry().register(LoiteringAnalyzer(dwell_seconds=2.0))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        windows = TemporalWindowStore()
        z = zone(attrs={"loitering": True})
        emitted = []
        for f in range(4):  # t = 0,1,2,3 seconds
            emitted += reg.run(ctx([snap(centroid=(0.5, 0.5), frame=f)], [z], frame=f, at=f"{f}s", windows=windows), store)
        starts = [b for b in emitted if b.state == BehaviorState.STARTED]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].behavior_type, "loitering")
        self.assertEqual(starts[0].category, BehaviorCategory.SECURITY)
        self.assertGreaterEqual(starts[0].metrics["dwellSeconds"], 2.0)

    def test_no_zone_opt_in_means_no_loitering(self):
        reg = BehaviorRegistry().register(LoiteringAnalyzer(dwell_seconds=0.0))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap()], [zone(attrs={"restricted": True})]), store)  # zone not flagged loitering
        self.assertEqual(out, [])


class QueueTests(unittest.TestCase):
    def test_queue_length_and_updated_on_change(self):
        reg = BehaviorRegistry().register(QueueAnalyzer(min_queue=2))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        windows = TemporalWindowStore()
        z = zone(attrs={"queue": True})
        two = [snap("t1", centroid=(0.4, 0.4)), snap("t2", centroid=(0.6, 0.6))]
        three = two + [snap("t3", centroid=(0.5, 0.5))]
        e0 = reg.run(ctx(two, [z], frame=0, at="0s", windows=windows), store)
        e1 = reg.run(ctx(three, [z], frame=1, at="1s", windows=windows), store)
        self.assertEqual(e0[0].state, BehaviorState.STARTED)
        self.assertEqual(e0[0].metrics["queueLength"], 2.0)
        self.assertEqual(e1[0].state, BehaviorState.UPDATED)
        self.assertEqual(e1[0].metrics["queueLength"], 3.0)

    def test_below_minimum_does_not_fire(self):
        reg = BehaviorRegistry().register(QueueAnalyzer(min_queue=3))
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap("t1", centroid=(0.4, 0.4))], [zone(attrs={"queue": True})]), store)
        self.assertEqual(out, [])


class IntrusionTests(unittest.TestCase):
    def test_confirmed_track_in_restricted_zone(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap(centroid=(0.5, 0.5))], [zone(attrs={"restricted": True})]), store)
        self.assertEqual(out[0].behavior_type, "intrusion")
        self.assertEqual(out[0].category, BehaviorCategory.SECURITY)
        self.assertEqual(event_type_for_behavior("intrusion"), "security.intrusion.detected")

    def test_tentative_track_ignored(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap(state="tentative", centroid=(0.5, 0.5))], [zone(attrs={"restricted": True})]), store)
        self.assertEqual(out, [])


class FireTests(unittest.TestCase):
    def test_fire_and_smoke_are_detector_independent_labels(self):
        reg = BehaviorRegistry().register(FireAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap("f1", label="fire", state="tentative"), snap("s1", label="smoke")], []), store)
        types = sorted(b.behavior_type for b in out)
        self.assertEqual(types, ["fire", "smoke"])
        self.assertTrue(all(b.category == BehaviorCategory.SAFETY for b in out))

    def test_non_hazard_labels_ignored(self):
        reg = BehaviorRegistry().register(FireAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        self.assertEqual(reg.run(ctx([snap(label="person")], []), store), [])


class LifecycleTests(unittest.TestCase):
    def test_started_then_ended_on_disappearance(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        z = zone(attrs={"restricted": True})
        e0 = reg.run(ctx([snap(centroid=(0.5, 0.5))], [z], frame=0, at="0s"), store)
        e1 = reg.run(ctx([], [z], frame=1, at="1s"), store)  # subject gone
        self.assertEqual(e0[0].state, BehaviorState.STARTED)
        self.assertEqual(e1[0].state, BehaviorState.ENDED)
        self.assertEqual(e0[0].behavior_id, e1[0].behavior_id)  # same instance id across lifecycle

    def test_stable_ids_and_correlation(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        out = reg.run(ctx([snap("trk_7", centroid=(0.5, 0.5))], [zone(attrs={"restricted": True})]), store)
        self.assertTrue(out[0].behavior_id.startswith("bhv_cam_1_sess_1_"))
        self.assertEqual(out[0].correlation_id, "cor_cam_1_sess_1_trk_7")

    def test_sweep_marks_active_as_expired(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        reg.run(ctx([snap(centroid=(0.5, 0.5))], [zone(attrs={"restricted": True})], frame=0, at="0s"), store)
        expired = store.sweep(frame_index=1, at="1s", t=1.0)
        self.assertEqual(expired[0].state, BehaviorState.EXPIRED)


class IndependenceAndDeterminismTests(unittest.TestCase):
    def test_analyzers_are_independent_disabling_one_leaves_others(self):
        reg = default_registry({"loitering": {"dwell_seconds": 0.0}})
        reg.disable("loitering")
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        z = zone(attrs={"restricted": True, "loitering": True})
        out = reg.run(ctx([snap(centroid=(0.5, 0.5))], [z]), store)
        kinds = {b.behavior_type for b in out}
        self.assertIn("intrusion", kinds)
        self.assertNotIn("loitering", kinds)  # disabled analyzer contributes nothing

    def test_replay_is_deterministic(self):
        def run_once():
            reg = default_registry({"loitering": {"dwell_seconds": 0.0}, "queue": {"min_queue": 1}})
            store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
            windows = TemporalWindowStore()
            z = zone(attrs={"restricted": True, "loitering": True, "queue": True})
            got = []
            for f in range(3):
                got += [(b.behavior_type, b.state.value, b.behavior_id) for b in reg.run(ctx([snap(centroid=(0.5, 0.5), frame=f)], [z], frame=f, at=f"{f}s", windows=windows), store)]
            return got
        self.assertEqual(run_once(), run_once())


class TranslatorTests(unittest.TestCase):
    def test_behavior_result_to_event_envelope(self):
        reg = BehaviorRegistry().register(IntrusionAnalyzer())
        store = BehaviorLifecycleStore(camera_id="cam_1", session_id="sess_1", tenant_id="tnt_a")
        result = reg.run(ctx([snap(centroid=(0.5, 0.5))], [zone(attrs={"restricted": True})]), store)[0]
        env = BehaviorResultTranslator(id_gen=lambda: "evt_1").translate(result.to_dict())
        self.assertEqual(env["type"], "security.intrusion.detected")
        self.assertEqual(env["category"], "security")
        self.assertEqual(env["cameraId"], "cam_1")
        self.assertEqual(env["payload"]["behaviorType"], "intrusion")
        self.assertNotIn("incident", env["type"])

    def test_unmapped_behavior_type_is_skipped(self):
        env = BehaviorResultTranslator(id_gen=lambda: "evt_1").translate({"behaviorType": "teleportation", "tenantId": "t"})
        self.assertIsNone(env)


class IntegrationTests(unittest.TestCase):
    def _zone(self, camera):
        return {"id": "z1", "cameraId": camera, "name": "lobby", "kind": "area",
                "geometry": {"points": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]},
                "attributes": {"loitering": True, "restricted": True}}

    def test_end_to_end_behaviors_and_events(self):
        opts = AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_1", session_id="sess_1",
                              labels=("person",), min_confidence=0.3, track_min_hits=2,
                              zones=(self._zone("cam_1"),), behavior_options={"loitering": {"dwell_seconds": 0.05}})
        res = VideoAnalyzer(build_adapter("stub"), opts).analyze(StubFrameDecoder.synthetic(8))
        self.assertTrue(res.behaviors)
        self.assertIn("security.intrusion.detected", {e["type"] for e in res.events})
        # RuntimeMetrics behavior observability is populated additively.
        self.assertIn("analyzerInvocationCount", res.behavior_stats)
        self.assertIn("analyzers", res.behavior_stats)
        # Boundary: the runtime never emits incidents.
        self.assertFalse([e for e in res.events if e["type"].startswith("incident.")])

    def test_multi_camera_identity_preserved_in_behaviors(self):
        for cam in ("cam_A", "cam_B"):
            opts = AnalyzeOptions(tenant_id="tnt_a", camera_id=cam, session_id="sess_1",
                                  labels=("person",), min_confidence=0.3, track_min_hits=2,
                                  zones=(self._zone(cam),))
            res = VideoAnalyzer(build_adapter("stub"), opts).analyze(StubFrameDecoder.synthetic(6))
            self.assertTrue(all(b["cameraId"] == cam for b in res.behaviors))
            self.assertTrue(all(f"_{cam}_" in b["behaviorId"] for b in res.behaviors))

    def test_disable_behaviors(self):
        opts = AnalyzeOptions(tenant_id="tnt_a", camera_id="cam_1", session_id="sess_1",
                              labels=("person",), min_confidence=0.3, enable_behaviors=False,
                              zones=(self._zone("cam_1"),))
        res = VideoAnalyzer(build_adapter("stub"), opts).analyze(StubFrameDecoder.synthetic(6))
        self.assertEqual(res.behaviors, [])
        self.assertEqual(res.behavior_stats, {})


if __name__ == "__main__":
    unittest.main()
