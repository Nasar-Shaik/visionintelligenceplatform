"""Detection identity and frame latency (P-8 Phase 3).

⚠️ Both were added because the Architect's canonical Detection object asks for them, and both have
a property that is easy to get subtly wrong and impossible to fix later: an id that is not stable
cannot be cited, and a latency that reports zero when it means "unknown" is a lie in a graph.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from contracts import (  # noqa: E402
    DETECTION_RESULT_SCHEMA_VERSION,
    Detection,
    FrameContext,
    ModelBinding,
    detection_id,
)
from pipeline import DefaultResultTranslator, frame_latency_ms  # noqa: E402

_TS_CONTRACT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "..", "packages", "contracts", "src", "perception", "perception.ts",
)


def _ctx(**over):
    base = dict(
        tenant_id="tnt_a",
        camera_id="cam_1",
        image=b"x",
        frame_number=7,
        timestamp="2026-08-05T10:00:00.000Z",
    )
    base.update(over)
    return FrameContext(**base)


def _translate(detections, ctx=None, model=None, at="2026-08-05T10:00:00.250Z"):
    return DefaultResultTranslator().run(
        detections,
        ctx or _ctx(),
        model or ModelBinding(id="yolox-nano", name="yolox-nano", version="1.0.0", task="object-detection"),
        capability_id="perception.person-detection",
        capability_version="0.1.0",
        runtime_version="0.1.0",
        execution_provider="CPUExecutionProvider",
        inference_ms=12.5,
        at=at,
    )


def _det(label="person", confidence=0.9):
    return Detection(label=label, confidence=confidence, bbox=(0.1, 0.1, 0.2, 0.2))


class DetectionIdentityTests(unittest.TestCase):
    def test_the_same_frame_and_model_always_produce_the_same_ids(self):
        first = _translate([_det(), _det("car", 0.8)]).to_dict()
        second = _translate([_det(), _det("car", 0.8)]).to_dict()
        self.assertEqual(
            [d["detectionId"] for d in first["detections"]],
            [d["detectionId"] for d in second["detections"]],
        )

    def test_a_different_model_over_the_same_frame_produces_different_ids(self):
        """⚠️ The bug this test exists for, found by running two models over one probe frame.

        Seeded only on frame identity, `det_2be1f37f…` was "the person on the left" under one model
        and "the car on the right" under the other. An id that survives a model change invites
        exactly the comparison it cannot support.
        """
        yolox = _translate([_det()]).to_dict()["detections"][0]["detectionId"]
        ssd = _translate(
            [_det()],
            model=ModelBinding(id="ssd-mobilenet-v1", name="ssd", version="1.0.0", task="object-detection"),
        ).to_dict()["detections"][0]["detectionId"]
        self.assertNotEqual(yolox, ssd)

    def test_every_axis_of_the_frame_changes_the_id(self):
        base = detection_id("t", "c", "2026-08-05T10:00:00.000Z", 1, "m", 0)
        variants = {
            "tenant": detection_id("t2", "c", "2026-08-05T10:00:00.000Z", 1, "m", 0),
            "camera": detection_id("t", "c2", "2026-08-05T10:00:00.000Z", 1, "m", 0),
            "capturedAt": detection_id("t", "c", "2026-08-05T10:00:01.000Z", 1, "m", 0),
            "seq": detection_id("t", "c", "2026-08-05T10:00:00.000Z", 2, "m", 0),
            "model": detection_id("t", "c", "2026-08-05T10:00:00.000Z", 1, "m2", 0),
            "index": detection_id("t", "c", "2026-08-05T10:00:00.000Z", 1, "m", 1),
        }
        for axis, value in variants.items():
            with self.subTest(axis=axis):
                self.assertNotEqual(base, value, f"{axis} must change the id")

    def test_two_detections_in_one_frame_never_share_an_id(self):
        result = _translate([_det(), _det(), _det()]).to_dict()
        ids = [d["detectionId"] for d in result["detections"]]
        self.assertEqual(len(set(ids)), 3)

    def test_an_id_that_was_already_assigned_is_never_overwritten(self):
        # A later stage (tracking, re-ID) may carry an identity forward; the translator must not
        # silently replace it and break the chain a consumer is following.
        preset = Detection(label="person", confidence=0.9, bbox=(0, 0, 1, 1), detection_id="det_preset")
        result = _translate([preset]).to_dict()
        self.assertEqual(result["detections"][0]["detectionId"], "det_preset")

    def test_the_id_is_short_enough_to_read_and_prefixed(self):
        value = detection_id("t", "c", "2026-08-05T10:00:00.000Z", 1, "m", 0)
        self.assertTrue(value.startswith("det_"))
        self.assertEqual(len(value), 24)


class ReproducibilityTests(unittest.TestCase):
    """⚠️ A result that cannot be reproduced is not evidence. Every field below answers one question
    a consumer holding an archived document must be able to answer without asking anybody."""

    def test_a_result_carries_everything_needed_to_reproduce_the_inference(self):
        result = _translate([_det()]).to_dict()
        self.assertEqual(result["schemaVersion"], DETECTION_RESULT_SCHEMA_VERSION)
        self.assertEqual(result["model"]["id"], "yolox-nano")
        self.assertEqual(result["model"]["version"], "1.0.0")
        self.assertEqual(result["executionProvider"], "CPUExecutionProvider")
        self.assertEqual(result["runtimeVersion"], "0.1.0")
        self.assertEqual(result["capabilityVersion"], "0.1.0")
        self.assertEqual(result["frame"]["capturedAt"], "2026-08-05T10:00:00.000Z")
        self.assertGreaterEqual(result["inferenceMs"], 0)

    def test_the_pixel_path_and_the_confidence_floor_are_recorded(self):
        """⚠️ Neither is derivable from the model id. Identical weights, identical provider and an
        identical frame give different detections if the resize policy or the floor changed."""
        translated = DefaultResultTranslator().run(
            [_det()],
            _ctx(),
            ModelBinding(id="yolox-nano", name="yolox-nano", version="1.0.0", task="object-detection"),
            capability_id="perception.person-detection",
            capability_version="0.1.0",
            runtime_version="0.1.0",
            execution_provider="CPUExecutionProvider",
            inference_ms=1.0,
            at="2026-08-05T10:00:00.100Z",
            preprocessing_version="1.0/letterbox-416x416-NCHW-float32-BGR-pad114",
            confidence_threshold=0.5,
        ).to_dict()
        self.assertEqual(
            translated["preprocessingVersion"], "1.0/letterbox-416x416-NCHW-float32-BGR-pad114"
        )
        self.assertEqual(translated["confidenceThreshold"], 0.5)

    def test_the_python_and_typescript_schema_versions_cannot_drift(self):
        """⚠️ Two constants naming one version is a duplicate source of truth. It is allowed to
        exist only because this test makes disagreement a build failure — a schema version that
        drifts is worse than no schema version at all."""
        with open(_TS_CONTRACT, "r", encoding="utf-8") as handle:
            source = handle.read()
        needle = f"DETECTION_RESULT_SCHEMA_VERSION = '{DETECTION_RESULT_SCHEMA_VERSION}'"
        self.assertIn(needle, source, f"perception.ts does not declare {needle}")


class FrameLatencyTests(unittest.TestCase):
    def test_it_measures_capture_to_result(self):
        result = _translate([_det()]).to_dict()
        self.assertAlmostEqual(result["frameLatencyMs"], 250.0, places=3)

    def test_an_unparseable_timestamp_omits_the_field_rather_than_reporting_zero(self):
        self.assertIsNone(frame_latency_ms("not a timestamp", "2026-08-05T10:00:00.000Z"))
        result = _translate([_det()], ctx=_ctx(timestamp="whenever")).to_dict()
        self.assertNotIn("frameLatencyMs", result)

    def test_clock_skew_omits_the_field_rather_than_reporting_zero(self):
        """⚠️ A negative interval means the two clocks disagree. Reporting it as "0 ms, instant"
        turns a clock-skew problem into a performance claim."""
        self.assertIsNone(
            frame_latency_ms("2026-08-05T10:00:05.000Z", "2026-08-05T10:00:00.000Z")
        )

    def test_offsets_other_than_z_are_understood(self):
        self.assertAlmostEqual(
            frame_latency_ms("2026-08-05T10:00:00.000+00:00", "2026-08-05T10:00:00.100Z"),
            100.0,
            places=3,
        )


if __name__ == "__main__":
    unittest.main()
