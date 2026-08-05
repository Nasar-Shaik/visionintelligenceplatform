"""AI-1 video pipeline tests — decoder → sampler → analyzer. Deterministic, stdlib-only (stub
backend). Proves: immutable frame metadata (rec 3), FPS/stride sampling + dropped-frame counting,
the modular analyzer producing AI-neutral DetectionResults (rec 2) + person EventEnvelopes, and
per-stage timings (rec 6). The runtime boundary holds: only EventEnvelopes, never incidents."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from adapters.fake_adapter import FakeModelAdapter  # noqa: E402
from events import deterministic_id_gen  # noqa: E402
from video_analyzer import AnalyzeOptions, VideoAnalyzer  # noqa: E402
from video_decoder import StubFrameDecoder  # noqa: E402
from video_sampler import FrameSampler  # noqa: E402

# The allow-list of fields a detection may carry. ⚠️ Every entry is generic; the test exists to make
# a vendor field ("yoloClass", "onnxOutputIndex") a build failure rather than a review comment.
# `detectionId` joined it in P-8 Phase 3 — model-independent identity, derived from the frame.
_DET_KEYS = {
    "detectionId",
    "label",
    "confidence",
    "bbox",
    "attributes",
    "metadata",
    "classId",
    "embedding",
    "trackingId",
}


def _analyzer(**opts):
    base = dict(tenant_id="tnt_a", labels=("person",), min_confidence=0.5)
    base.update(opts)
    options = AnalyzeOptions(**base)
    return VideoAnalyzer(
        FakeModelAdapter(),
        options,
        now_iso=lambda: "2026-07-31T09:00:00.000Z",
        id_gen=deterministic_id_gen("evt"),
    )


class FrameMetadataTests(unittest.TestCase):
    def test_decoder_preserves_immutable_metadata(self):
        frames = list(StubFrameDecoder.synthetic(2, width=1280, height=720, source_fps=25.0).decode())
        self.assertEqual(len(frames), 2)
        m = frames[0].meta()
        self.assertEqual(m["frameIndex"], 0)
        self.assertEqual((m["originalWidth"], m["originalHeight"]), (1280, 720))
        self.assertEqual((m["processedWidth"], m["processedHeight"]), (1280, 720))
        self.assertIn("timestamp", m)
        self.assertIn("sourceVideo", m)
        self.assertTrue(frames[0].image)  # non-empty payload


class SamplerTests(unittest.TestCase):
    def test_target_fps_derives_stride_and_counts_drops(self):
        frames = list(StubFrameDecoder.synthetic(10, source_fps=30.0).decode())
        sampler = FrameSampler(source_fps=30.0, target_fps=10.0)  # stride 3
        kept = list(sampler.sample(frames))
        self.assertEqual(sampler.stride, 3)
        self.assertEqual([f.index for f in kept], [0, 3, 6, 9])
        self.assertEqual(sampler.kept, 4)
        self.assertEqual(sampler.dropped, 6)

    def test_no_target_keeps_all(self):
        frames = list(StubFrameDecoder.synthetic(4).decode())
        sampler = FrameSampler(source_fps=30.0)
        self.assertEqual(len(list(sampler.sample(frames))), 4)
        self.assertEqual(sampler.dropped, 0)


class AnalyzerTests(unittest.TestCase):
    def test_produces_person_detections_and_events(self):
        result = _analyzer().analyze(StubFrameDecoder.synthetic(3))
        self.assertEqual(len(result.frames), 3)
        self.assertEqual(result.summary["framesDecoded"], 3)
        self.assertEqual(result.summary["framesSampled"], 3)
        self.assertEqual(result.summary["detections"], 3)
        self.assertEqual(result.summary["events"], 3)
        for det in result.detections:
            self.assertEqual(det["label"], "person")
        for ev in result.events:
            self.assertEqual(ev["type"], "perception.person.detected")
            self.assertEqual(ev["tenantId"], "tnt_a")
            self.assertFalse(ev["type"].startswith("incident."))  # runtime never authors incidents

    def test_detection_result_stays_ai_neutral(self):
        result = _analyzer().analyze(StubFrameDecoder.synthetic(1))
        det = result.detections[0]
        self.assertTrue(set(det).issubset(_DET_KEYS), f"unexpected vendor fields: {set(det) - _DET_KEYS}")

    def test_records_per_stage_timings(self):
        result = _analyzer().analyze(StubFrameDecoder.synthetic(2))
        t = result.timings.as_dict()
        for key in ("decodeMs", "samplingMs", "preprocessMs", "inferenceMs", "postprocessMs", "eventGenerationMs"):
            self.assertIn(key, t)
            self.assertGreaterEqual(t[key], 0.0)

    def test_sampling_reduces_processed_frames(self):
        result = _analyzer(target_fps=10.0).analyze(StubFrameDecoder.synthetic(9, source_fps=30.0))
        # stride 3 over 9 frames → 3 processed.
        self.assertEqual(result.summary["framesSampled"], 3)
        self.assertEqual(result.summary["framesDropped"], 6)
        self.assertEqual(len(result.events), 3)

    def test_sub_threshold_confidence_drops_detections(self):
        # A confidence ceiling above the stub's max (0.99) yields zero detections/events.
        result = _analyzer(min_confidence=1.0).analyze(StubFrameDecoder.synthetic(2))
        self.assertEqual(result.summary["detections"], 0)
        self.assertEqual(result.summary["events"], 0)


if __name__ == "__main__":
    unittest.main()
