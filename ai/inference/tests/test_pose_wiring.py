"""The wiring seam — P3.3b.

⛔ **Why this file exists.** Pose was correctly implemented, correctly catalogued, correctly loaded,
and correctly called — and a whole diagnosis cycle went into "pose never runs", because the only
number pose published was `stats()` printed at LOAD, which is a constant zero by construction.
Reading it after a run and concluding nothing had executed was the only inference the evidence
allowed. So the tests here assert the two things that were unassertable: that the capability
`/infer` actually resolves carries the pose stage, and that its counters MOVE.
"""

import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from capability import Capability  # noqa: E402
from contracts import Detection, FrameContext  # noqa: E402
from manifest import CapabilityManifest  # noqa: E402
from perception import ATTR_POSE  # noqa: E402
from registry import CapabilityRegistry  # noqa: E402
from resolver import FakeModelResolver  # noqa: E402

IMG = base64.b64encode(b"a-fake-jpeg-frame").decode("ascii")


class _PoseDouble:
    """Shaped from the real `PoseEstimator`: same two methods, same counter names."""

    def __init__(self, *, explode: bool = False) -> None:
        self.calls = 0
        self.inferences = 0
        self.seen: list = []
        self._explode = explode

    def estimate(self, image, detections):
        self.calls += 1
        self.seen.append(list(detections))
        if self._explode:
            raise RuntimeError("onnxruntime said no")
        out = []
        for det in detections:
            if det.label != "person":
                out.append(det)
                continue
            self.inferences += 1
            attrs = dict(det.attributes)
            attrs[ATTR_POSE] = {"skeleton": "coco-17", "keypoints": []}
            out.append(Detection(label=det.label, confidence=det.confidence, bbox=det.bbox,
                                 class_id=det.class_id, attributes=attrs))
        return out

    def stats(self):
        return {"model": "rtmpose-tiny", "poseInferences": self.inferences}


class _RecordingTracker:
    """Records exactly what the tracking stage was handed."""

    def __init__(self) -> None:
        self.received: list = []

    def run(self, detections, ctx):
        self.received.append(list(detections))
        return list(detections)


def manifest(capability_id="perception.person-detection"):
    return CapabilityManifest.from_dict({
        "capabilityId": capability_id,
        "version": "0.1.0",
        "requiredModel": {"task": "object-detection", "family": "*", "accelerator": "cpu"},
        "minConfidence": 0.4,
        "generatedEvents": ["perception.person.detected"],
        "enabled": True,
    })


def ctx(cam="cam_1", seq=3):
    return FrameContext.from_request({
        "context": {"tenantId": "tnt_a"},
        "frame": {"cameraId": cam, "seq": seq, "capturedAt": "2026-08-12T00:00:00.000Z"},
        "imageBase64": IMG,
    })


def ready_cap(pose=None, tracker=None):
    cap = Capability(manifest(), FakeModelResolver(), FakeModelAdapter(), "0.1.0",
                     pose_estimator=pose, tracker=tracker, clock=lambda: 1000.0)
    cap.init()
    return cap


class RegistrySeamTests(unittest.TestCase):
    """⛔ **Hypothesis A, tested rather than inferred from a startup log.**"""

    def test_the_capability_infer_resolves_carries_the_pose_stage(self) -> None:
        """`registry.get(...)` is the EXACT lookup `/infer` performs (server.py `_infer`). Asserting
        on the object `register()` returned would prove nothing about what is served."""
        pose = _PoseDouble()
        registry = CapabilityRegistry("0.1.0", pose_estimator=pose)
        registry.register(manifest(), FakeModelResolver(), FakeModelAdapter())

        served = registry.get("perception.person-detection")
        self.assertIs(served._pose, pose)

    def test_the_default_capability_carries_it_too(self) -> None:
        """⚠️ `/infer` with no capabilityId resolves the default — a second lookup path."""
        pose = _PoseDouble()
        registry = CapabilityRegistry("0.1.0", pose_estimator=pose)
        registry.register(manifest(), FakeModelResolver(), FakeModelAdapter())
        self.assertIs(registry.get(None)._pose, pose)

    def test_every_capability_shares_one_pose_model(self) -> None:
        """⭐ One 13 MB session, not one per capability."""
        pose = _PoseDouble()
        registry = CapabilityRegistry("0.1.0", pose_estimator=pose)
        registry.register(manifest("perception.person-detection"), FakeModelResolver(), FakeModelAdapter())
        registry.register(manifest("perception.vehicle-detection"), FakeModelResolver(), FakeModelAdapter())
        first = registry.get("perception.person-detection")._pose
        second = registry.get("perception.vehicle-detection")._pose
        self.assertIs(first, second)

    def test_a_runtime_without_pose_still_serves_detection(self) -> None:
        """⭐ Pose is additive. No estimator, no behaviour change."""
        registry = CapabilityRegistry("0.1.0")
        registry.register(manifest(), FakeModelResolver(), FakeModelAdapter())
        served = registry.get(None)
        served.init()
        self.assertIsNone(served._pose)
        self.assertEqual(len(served.process(ctx())["detections"]), 1)


class PipelineOrderTests(unittest.TestCase):
    """⛔ **Hypothesis B.** Pose must land between postprocessing and tracking — the tracker copies
    a detection's attributes onto the track, and the console overlay reads TRACKS."""

    def test_the_tracker_is_handed_detections_that_already_carry_pose(self) -> None:
        tracker = _RecordingTracker()
        cap = ready_cap(pose=_PoseDouble(), tracker=tracker)
        cap.process(ctx())
        self.assertEqual(len(tracker.received), 1)
        self.assertIn(ATTR_POSE, tracker.received[0][0].attributes)

    def test_pose_sees_postprocessed_detections_not_raw_model_output(self) -> None:
        pose = _PoseDouble()
        ready_cap(pose=pose).process(ctx())
        self.assertEqual(len(pose.seen), 1)
        self.assertIsInstance(pose.seen[0][0], Detection)
        self.assertEqual(pose.seen[0][0].label, "person")

    def test_pose_reaches_the_result_payload(self) -> None:
        result = ready_cap(pose=_PoseDouble()).process(ctx())
        self.assertIn(ATTR_POSE, result["detections"][0]["attributes"])


class ObservabilityTests(unittest.TestCase):
    """⛔ **The defect this investigation actually exposed.** These fail against the implementation
    that shipped: `health()` reported no pose at all, so the only readable counter was the constant
    zero logged at load. A counter that cannot move is not evidence."""

    def test_health_reports_pose_activity(self) -> None:
        cap = ready_cap(pose=_PoseDouble())
        self.assertEqual(cap.health()["pose"]["poseInferences"], 0)
        cap.process(ctx())
        cap.process(ctx(seq=4))
        self.assertEqual(cap.health()["pose"]["poseInferences"], 2,
                         "the pose counter must move where an operator can read it")

    def test_health_omits_pose_entirely_when_the_runtime_has_none(self) -> None:
        """⚠️ Absent, not zero. `poseInferences: 0` on a runtime with no pose model reads as a
        model that ran and found nothing — the same overloaded empty value twice over."""
        self.assertNotIn("pose", ready_cap().health())

    def test_health_reports_the_per_frame_cost(self) -> None:
        cap = ready_cap(pose=_PoseDouble())
        cap.process(ctx())
        self.assertIsInstance(cap.health()["pose"]["lastFrameMs"], float)


class PoseFailureTests(unittest.TestCase):
    """⛔ An enrichment must never delete a detection — and must never fail quietly either."""

    def test_a_pose_crash_leaves_detection_intact(self) -> None:
        cap = ready_cap(pose=_PoseDouble(explode=True))
        result = cap.process(ctx())
        self.assertEqual(len(result["detections"]), 1)
        self.assertNotIn(ATTR_POSE, result["detections"][0]["attributes"])

    def test_a_pose_crash_is_counted_where_it_can_be_read(self) -> None:
        cap = ready_cap(pose=_PoseDouble(explode=True))
        cap.process(ctx())
        cap.process(ctx(seq=4))
        self.assertEqual(cap.health()["pose"]["frameFailures"], 2)


if __name__ == "__main__":
    unittest.main()
