"""Deterministic tracking replay (P-8 Phase 4 freeze).

⚠️ Every test here proves something about TRACKING and nothing about perception. The detections are
authored, so a green run means the association and lifecycle logic reproduces exactly — it says
nothing about whether a model would find that person on real video. That is the deployment
verification's job and it runs against real RTSP.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from contracts import Detection, FrameContext  # noqa: E402
from runtime_tracking import RuntimeTracker, TrackingOptions  # noqa: E402
from track_replay import (  # noqa: E402
    REPLAY_FORMAT_VERSION,
    TrackingRecorder,
    compare,
    read_recording,
    replay,
)


def det(bbox, label="person"):
    return Detection(label=label, confidence=0.9, bbox=bbox, class_id=0)


def ctx(camera="cam_1", tenant="tnt_a", seq=0, at="2026-08-05T09:00:00.000Z"):
    return FrameContext(tenant_id=tenant, camera_id=camera, image=b"", frame_number=seq, timestamp=at)


def iso(second: float) -> str:
    whole = int(second)
    ms = int(round((second - whole) * 1000))
    return f"2026-08-05T09:{whole // 60:02d}:{whole % 60:02d}.{ms:03d}Z"


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="vip-replay-")
        self.path = os.path.join(self.dir, "run.jsonl")

    def record_walk(self, xs, *, camera="cam_1", options=None):
        """Record a single object walking along `xs`. Returns the recorder."""
        tracker = RuntimeTracker(options or TrackingOptions())
        recorder = TrackingRecorder(self.path, engine=tracker.describe())
        tracker.start_recording(recorder)
        for i, x in enumerate(xs):
            frame = [det((x - 0.05, 0.45, 0.1, 0.1))] if x is not None else []
            tracker.run(frame, ctx(camera=camera, seq=i, at=iso(i * 0.5)))
        return recorder

    def test_a_recording_replays_to_identical_identities(self):
        self.record_walk([0.10, 0.14, 0.18, 0.22, 0.26])
        _header, rows = read_recording(self.path)
        result = replay(rows, RuntimeTracker(TrackingOptions()))
        verdict = compare(rows, result)
        self.assertTrue(verdict["identical"], f"replay diverged: {verdict['differences']}")
        self.assertEqual(verdict["frames"], 5)

    def test_replay_needs_no_video_model_or_camera(self):
        """The whole point: the recording IS the tracker's input, so nothing else is required."""
        self.record_walk([0.10, 0.14, 0.18])
        _header, rows = read_recording(self.path)
        for row in rows:
            self.assertNotIn("image", row, "a recording carried pixels it does not need")
        self.assertTrue(replay(rows, RuntimeTracker(TrackingOptions())))

    def test_an_occlusion_replays_identically(self):
        self.record_walk([0.10, 0.14, 0.18, None, None, 0.30, 0.34])
        _header, rows = read_recording(self.path)
        verdict = compare(rows, replay(rows, RuntimeTracker(TrackingOptions())))
        self.assertTrue(verdict["identical"], f"the occlusion did not reproduce: {verdict}")

    def test_comparison_ignores_the_literal_id_and_compares_the_identity_shape(self):
        """⚠️ Track ids embed a session id, so two runs of the same input give different strings for
        the same identity. Comparing raw ids would fail every time and prove nothing."""
        self.record_walk([0.10, 0.14, 0.18])
        _header, rows = read_recording(self.path)
        result = replay(rows, RuntimeTracker(TrackingOptions(), session_id="a-different-session"))
        recorded_ids = {i for r in rows for i in r["trackIds"] if i}
        replayed_ids = {i for r in result for i in r["trackIds"] if i}
        self.assertTrue(recorded_ids.isdisjoint(replayed_ids), "the ids were the same by accident")
        self.assertTrue(compare(rows, result)["identical"], "the identity shape did not match")

    def test_a_tuning_change_that_breaks_identity_shows_as_a_difference(self):
        """The regression case. An engine that can no longer coast splits the identity, and the
        comparison must SAY so rather than reporting a clean replay."""
        self.record_walk([0.10, 0.14, 0.18, None, None, 0.30, 0.34])
        _header, rows = read_recording(self.path)
        crippled = RuntimeTracker(TrackingOptions(max_age=0, min_hits=1))
        verdict = compare(rows, replay(rows, crippled))
        self.assertFalse(verdict["identical"], "an engine that lost the identity replayed as clean")
        self.assertGreater(verdict["differenceCount"], 0)

    def test_the_recording_carries_the_engine_it_was_made_with(self):
        """Replaying against different tuning and calling the difference a regression would be an
        experiment with two variables. The header makes the second variable visible."""
        self.record_walk([0.10, 0.14])
        header, _rows = read_recording(self.path)
        self.assertEqual(header["formatVersion"], REPLAY_FORMAT_VERSION)
        self.assertEqual(header["engine"]["associator"], "predictive-iou")
        self.assertIn("maxAgeFrames", header["engine"])

    def test_an_unknown_format_version_is_refused_not_guessed(self):
        path = os.path.join(self.dir, "future.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"kind": "vip.tracking.replay", "formatVersion": 99}) + "\n")
        with self.assertRaises(ValueError):
            read_recording(path)

    def test_a_truncated_recording_still_replays_up_to_the_cut(self):
        """A recording is usually stopped by killing the runtime, so a half-written last line is the
        NORMAL case — and that run is the one you most want to look at."""
        self.record_walk([0.10, 0.14, 0.18, 0.22])
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write('{"frameIndex": 5, "tenantId": "tnt_a", "camer')
        _header, rows = read_recording(self.path)
        self.assertEqual(len(rows), 4, "a truncated tail cost more than the incomplete frame")
        self.assertTrue(compare(rows, replay(rows, RuntimeTracker(TrackingOptions())))["identical"])

    def test_recording_is_bounded_and_says_when_it_stopped(self):
        tracker = RuntimeTracker(TrackingOptions())
        recorder = TrackingRecorder(self.path, max_frames=3)
        tracker.start_recording(recorder)
        for i in range(10):
            tracker.run([det((0.1 + i * 0.01, 0.45, 0.1, 0.1))], ctx(seq=i, at=iso(i * 0.5)))
        self.assertEqual(recorder.frames, 3)
        self.assertTrue(recorder.stopped, "a full recorder did not report that it had stopped")

    def test_nothing_is_recorded_unless_a_recorder_is_attached(self):
        """⚠️ A recording holds bounding boxes, camera ids and a tenant id. It is never on by
        default and no ordinary deployment path switches it on."""
        tracker = RuntimeTracker(TrackingOptions())
        for i in range(4):
            tracker.run([det((0.1 + i * 0.01, 0.45, 0.1, 0.1))], ctx(seq=i, at=iso(i * 0.5)))
        self.assertFalse(os.path.exists(self.path))
        self.assertIsNone(tracker.stop_recording())

    def test_stopping_a_recording_stops_it(self):
        recorder = self.record_walk([0.10, 0.14])
        tracker = RuntimeTracker(TrackingOptions())
        tracker.start_recording(recorder)
        self.assertIs(tracker.stop_recording(), recorder)
        before = recorder.frames
        tracker.run([det((0.4, 0.45, 0.1, 0.1))], ctx(seq=9, at=iso(9)))
        self.assertEqual(recorder.frames, before, "frames were recorded after the recorder detached")

    def test_two_cameras_replay_independently(self):
        tracker = RuntimeTracker(TrackingOptions())
        recorder = TrackingRecorder(self.path)
        tracker.start_recording(recorder)
        for i in range(5):
            tracker.run([det((0.10 + i * 0.02, 0.45, 0.1, 0.1))], ctx(camera="cam_1", seq=i, at=iso(i * 0.5)))
            tracker.run([det((0.70 - i * 0.02, 0.20, 0.1, 0.1))], ctx(camera="cam_2", seq=i, at=iso(i * 0.5)))
        _header, rows = read_recording(self.path)
        self.assertEqual(len({r["cameraId"] for r in rows}), 2)
        self.assertTrue(compare(rows, replay(rows, RuntimeTracker(TrackingOptions())))["identical"])


if __name__ == "__main__":
    unittest.main()
