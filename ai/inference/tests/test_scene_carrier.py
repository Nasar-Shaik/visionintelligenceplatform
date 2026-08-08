"""The `SceneObservation` carrier (P-11 slice 2.3, ADR-0054).

Slice 2.2's Finding 1: `FrameLabel` could *express* a statement about a scene and had nowhere to go —
`DetectionResult` carries `detections[]`, and its only open map is per subject. Occupancy and handover
left through a bounded in-memory debugging read, lost on restart.

⭐ **The carrier turned out to already exist.** `FrameContext` is built once per `/infer` request and
threaded through every stage *and* the translator, so a stage appends and the translator drains. No
new pipeline stage, no widened `Tracker` protocol, no side channel — the same shape of answer that
`StageChain` gave the "no new stage" guardrail one slice earlier.

Deterministic and stdlib-only.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from behaviour_modules import ZONE_ATTRIBUTE  # noqa: E402
from behaviour_stage import BehaviourStage  # noqa: E402
from contracts import (  # noqa: E402
    MAX_SCENE_OBSERVATIONS,
    Detection,
    DetectionResult,
    FrameContext,
    ModelBinding,
)
from perception import FrameLabel  # noqa: E402
from pipeline import DefaultResultTranslator, StageChain  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from track_history import InMemoryTrackHistoryStore, TrackHistoryRecorder  # noqa: E402

MODEL = ModelBinding(name="yolox-nano", version="1.0.0", task="object-detection")


def ctx(**kwargs):
    base = dict(tenant_id="tnt_a", camera_id="cam_1", image=b"", frame_number=1, timestamp="0s")
    base.update(kwargs)
    return FrameContext(**base)


def detection(bbox, *, label="person", zones=None):
    attributes = {} if zones is None else {ZONE_ATTRIBUTE: list(zones)}
    return Detection(label=label, confidence=0.9, bbox=bbox, attributes=attributes)


class FrameLabelWireTests(unittest.TestCase):
    def test_a_frame_label_becomes_a_scene_observation_with_kind_not_label(self):
        """⚠️ The rename is the point, not a slip. Inside the runtime this labels a frame, alongside
        the labels a model puts on boxes; a document carrying `label` at two nesting depths meaning
        two different things would force every consumer to learn which is which."""
        wire = FrameLabel("occupancy", attributes={"count": 6}).to_scene_observation()
        self.assertEqual(wire["kind"], "occupancy")
        self.assertNotIn("label", wire)
        self.assertEqual(wire["attributes"], {"count": 6})

    def test_a_span_is_carried_in_frames_because_seconds_belong_in_attributes(self):
        wire = FrameLabel("stationary", span=(120, 400)).to_scene_observation()
        self.assertEqual(wire["span"], [120, 400])

    def test_no_span_means_this_frame_only_and_is_absent_rather_than_a_pair_of_zeroes(self):
        self.assertNotIn("span", FrameLabel("occupancy").to_scene_observation())


class CollectorTests(unittest.TestCase):
    def test_the_collector_is_per_frame_so_two_frames_cannot_share_one(self):
        """⛔ The property that makes a mutable field on a frozen dataclass safe here. A collector
        shared between frames would accumulate a whole run's statements onto one document."""
        first, second = ctx(), ctx()
        first.observe_scene([{"kind": "occupancy"}])
        self.assertEqual(len(first.scene), 1)
        self.assertEqual(second.scene, [])

    def test_the_per_frame_cap_truncates_rather_than_failing_the_frame(self):
        """⚠️ A stage that produced 200 occupancy statements has a bug, and failing the frame would
        turn that bug into missing perception. The shortfall is a number the caller can report."""
        context = ctx()
        kept = context.observe_scene([{"kind": "occupancy", "attributes": {"n": i}} for i in range(200)])
        self.assertEqual(kept, MAX_SCENE_OBSERVATIONS)
        self.assertEqual(len(context.scene), MAX_SCENE_OBSERVATIONS)
        self.assertEqual(context.observe_scene([{"kind": "more"}]), 0)

    def test_appended_observations_are_copied_so_a_stage_cannot_mutate_them_later(self):
        context = ctx()
        payload = {"kind": "occupancy", "attributes": {"count": 1}}
        context.observe_scene([payload])
        payload["kind"] = "changed"
        self.assertEqual(context.scene[0]["kind"], "occupancy")


class TranslatorTests(unittest.TestCase):
    def translate(self, context):
        return DefaultResultTranslator().run(
            [],
            context,
            MODEL,
            capability_id="perception.person-detection",
            capability_version="1.0.0",
            runtime_version="1.0.0",
            execution_provider="stub",
            inference_ms=1.0,
            at="2026-08-09T00:00:00.000Z",
        )

    def test_scene_observations_reach_the_result(self):
        context = ctx()
        context.observe_scene([{"kind": "occupancy", "confidence": 1.0, "attributes": {"count": 3}}])
        self.assertEqual(self.translate(context).to_dict()["scene"][0]["attributes"], {"count": 3})

    def test_a_frame_with_nothing_to_say_carries_no_key_at_all(self):
        """⛔ Absent, not `[]`. An empty array and a missing key would be a third state meaning the
        same thing, which is how two consumers come to disagree about what "nothing" looks like —
        the same rule `zoneIds` follows in the resolver."""
        self.assertNotIn("scene", self.translate(ctx()).to_dict())

    def test_the_document_never_exceeds_the_cap_even_if_a_caller_builds_one_that_does(self):
        """⚠️ Bounded at serialisation too, not only at append. This rides a frozen contract onto a
        broker, and the broker must not be where an unbounded array is discovered."""
        result = DetectionResult(
            tenant_id="tnt_a",
            camera_id="cam_1",
            capability_id="perception.person-detection",
            capability_version="1.0.0",
            runtime_version="1.0.0",
            execution_provider="stub",
            model=MODEL,
            frame_seq=1,
            frame_captured_at="0s",
            inference_ms=1.0,
            at="2026-08-09T00:00:00.000Z",
            scene=[{"kind": "occupancy"} for _ in range(500)],
        )
        self.assertEqual(len(result.to_dict()["scene"]), MAX_SCENE_OBSERVATIONS)


class StageToResultTests(unittest.TestCase):
    """The whole path, through the real chain — a stage appends and the result carries it."""

    def setUp(self):
        self.recorder = TrackHistoryRecorder(store=InMemoryTrackHistoryStore())
        self.tracker = RuntimeTracker(TrackingOptions(min_hits=1), history=self.recorder)
        self.stage = BehaviourStage(recorder=self.recorder)
        self.chain = StageChain(self.tracker, self.stage)

    def run_frame(self, detections, *, at, seq, zones=None):
        context = ctx(frame_number=seq, timestamp=at)
        out = self.chain.run(list(detections), context)
        return context, out

    def test_occupancy_rides_the_frame_out_of_the_runtime(self):
        """⭐ Finding 1 of slice 2.2, closed. The statement is about the scene, and it leaves on the
        frame rather than through a debugging read that a restart erases."""
        for index in range(3):
            context, _ = self.run_frame(
                [detection((0.4, 0.4, 0.08, 0.2)), detection((0.6, 0.4, 0.08, 0.2))],
                at=f"{index}s",
                seq=index,
            )
        kinds = [o["kind"] for o in context.scene]
        self.assertIn("occupancy", kinds)
        self.assertEqual(next(o for o in context.scene if o["kind"] == "occupancy")["attributes"]["count"], 2)

    def test_a_frame_with_nothing_to_report_appends_nothing(self):
        """The negative control: an empty frame must produce an empty carrier, not a zero."""
        context, _ = self.run_frame([], at="0s", seq=0)
        self.assertEqual(context.scene, [])

    def test_the_stage_counts_what_it_put_on_the_frame(self):
        for index in range(2):
            self.run_frame([detection((0.4, 0.4, 0.08, 0.2))], at=f"{index}s", seq=index)
        stats = self.stage.stats()
        self.assertGreater(stats["sceneObservations"], 0)
        self.assertEqual(stats["sceneObservationsDropped"], 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
