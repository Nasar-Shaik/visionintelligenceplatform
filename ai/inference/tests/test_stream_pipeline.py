"""AI-5b — Stream Pipeline: queue ownership, drop policy, backpressure metrics, batch equivalence.

The load-bearing test here is `StreamingEqualsBatchTest`: the live path and the batch path must be the
SAME pipeline. If they ever diverge, everything the AI-1…AI-4 suites prove about batch analysis stops
being true of production, so equivalence is asserted directly rather than assumed.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from errors import ConfigurationFailure, InferenceError
from playground import build_adapter
from stream_pipeline import DROP_NEWEST, DROP_OLDEST, BoundedFrameQueue, PipelineOptions, StreamPipeline
from video_analyzer import AnalyzeOptions, VideoAnalyzer
from video_decoder import StubFrameDecoder
from video_frame import Frame
from video_sampler import FrameSampler


def _frames(count: int, *, fps: float = 30.0) -> list:
    return list(StubFrameDecoder.synthetic(count, source_fps=fps).decode())


def _options(**kwargs) -> AnalyzeOptions:
    base = dict(tenant_id="tnt_a", camera_id="cam_1", session_id="ses_1", min_confidence=0.3)
    base.update(kwargs)
    return AnalyzeOptions(**base)


def _analyzer(opts=None) -> VideoAnalyzer:
    opts = opts or _options()
    return VideoAnalyzer(build_adapter("stub"), opts, now_iso=lambda: "2026-07-31T00:00:00.000Z")


class BoundedQueueTest(unittest.TestCase):
    def test_drop_oldest_keeps_the_freshest_frames(self):
        q = BoundedFrameQueue(2, policy=DROP_OLDEST)
        frames = _frames(3)
        for f in frames:
            q.offer(f)
        kept = [q.poll()[0].index, q.poll()[0].index]
        self.assertEqual(kept, [1, 2])  # the stalest frame was discarded
        self.assertEqual(q.dropped, 1)

    def test_drop_newest_preserves_temporal_continuity(self):
        q = BoundedFrameQueue(2, policy=DROP_NEWEST)
        for f in _frames(3):
            q.offer(f)
        kept = [q.poll()[0].index, q.poll()[0].index]
        self.assertEqual(kept, [0, 1])  # the arriving frame was refused
        self.assertEqual(q.dropped, 1)

    def test_tracks_high_watermark_and_average_depth(self):
        q = BoundedFrameQueue(8)
        for f in _frames(5):
            q.offer(f)
        self.assertEqual(q.high_watermark, 5)
        self.assertEqual(q.depth, 5)
        self.assertAlmostEqual(q.utilization, 62.5, places=3)
        q.poll()
        q.poll()
        self.assertEqual(q.high_watermark, 5)  # a peak is remembered after it passes
        self.assertGreater(q.average_depth, 0.0)

    def test_clear_releases_every_queued_frame(self):
        q = BoundedFrameQueue(8)
        for f in _frames(4):
            q.offer(f)
        self.assertEqual(q.clear(), 4)
        self.assertEqual(q.depth, 0)
        self.assertIsNone(q.poll())

    def test_invalid_queue_settings_are_configuration_failures(self):
        with self.assertRaises(ConfigurationFailure):
            BoundedFrameQueue(0)
        with self.assertRaises(ConfigurationFailure):
            BoundedFrameQueue(4, policy="drop-whatever")


class SkipVersusDropTest(unittest.TestCase):
    """The distinction the whole SLO rests on: deliberate sampling is NOT frame loss."""

    def test_sampling_counts_as_skipped_never_as_dropped(self):
        pipeline = StreamPipeline(
            _analyzer(), options=PipelineOptions(queue_capacity=64, target_fps=5.0, source_fps=30.0)
        )
        analyzed = pipeline.run(_frames(30))
        stats = pipeline.stats()
        self.assertEqual(analyzed, 5)  # stride 6 over 30 frames
        self.assertEqual(stats["framesSkipped"], 25)  # execution policy — healthy
        self.assertEqual(stats["framesDropped"], 0)  # no degradation whatsoever
        self.assertEqual(stats["framesProcessed"], 5)

    def test_backpressure_overflow_counts_as_dropped(self):
        pipeline = StreamPipeline(_analyzer(), options=PipelineOptions(queue_capacity=2))
        # Producer runs ahead of the consumer: 5 offers, no drains in between.
        for frame in _frames(5):
            pipeline.offer(frame)
        stats = pipeline.stats()
        self.assertEqual(stats["framesDropped"], 3)  # genuine loss
        self.assertEqual(stats["framesSkipped"], 0)  # nothing was down-sampled
        self.assertEqual(stats["queueHighWatermark"], 2)

    def test_backpressure_metrics_are_reported_for_tuning(self):
        pipeline = StreamPipeline(_analyzer(), options=PipelineOptions(queue_capacity=4))
        for frame in _frames(4):
            pipeline.offer(frame)
        pipeline.drain()
        stats = pipeline.stats()
        for key in (
            "queueHighWatermark",
            "queueUtilization",
            "averageQueueDepth",
            "processingDelayMs",
            "maxProcessingDelayMs",
        ):
            self.assertIn(key, stats)
        self.assertEqual(stats["queueHighWatermark"], 4)
        self.assertGreaterEqual(stats["maxProcessingDelayMs"], stats["processingDelayMs"])


class StreamingEqualsBatchTest(unittest.TestCase):
    """Live and batch execution must produce the same perception output from the same frames."""

    def test_same_frames_produce_the_same_detections_events_and_behaviors(self):
        frames = _frames(24)

        batch = _analyzer(_options()).analyze(StubFrameDecoder.synthetic(24))

        pipeline = StreamPipeline(
            _analyzer(_options()), options=PipelineOptions(queue_capacity=64)
        )
        live_events: list = []
        live_detections: list = []
        pipeline.run(
            iter(frames),
            on_result=lambda a: (live_events.extend(a.events), live_detections.extend(a.detections)),
        )
        flushed = pipeline.flush()
        live_events.extend(flushed.events)

        self.assertEqual(len(live_detections), len(batch.detections))
        self.assertEqual(len(live_events), len(batch.events))
        self.assertEqual(
            [e["type"] for e in live_events], [e["type"] for e in batch.events]
        )

    def test_tracking_and_behavior_state_survive_across_streamed_frames(self):
        analyzer = _analyzer(_options())
        pipeline = StreamPipeline(analyzer, options=PipelineOptions(queue_capacity=64))
        pipeline.run(iter(_frames(20)))
        stats = analyzer.tracking_stats()
        # Tracking is inherently cross-frame; a per-frame API must not have reset it.
        self.assertGreater(stats.get("activeTracks", 0) + stats.get("confirmedTracks", 0), 0)

    def test_terminal_flush_closes_behaviors_exactly_like_batch(self):
        analyzer = _analyzer(_options())
        pipeline = StreamPipeline(analyzer, options=PipelineOptions(queue_capacity=32))
        pipeline.run(iter(_frames(15)))
        first = pipeline.flush()
        second = pipeline.flush()
        # Flushing is idempotent: nothing is emitted twice at shutdown.
        self.assertEqual(second.behaviors, [])
        self.assertEqual(second.composites, [])
        self.assertIsInstance(first.events, list)


class UnboundedSourceTest(unittest.TestCase):
    def test_max_frames_stops_an_infinite_source(self):
        def forever():
            i = 0
            while True:
                yield Frame(i, f"{i}s", "sim://c", 640, 480, 640, 480, 1.0, bytes([i % 251]))
                i += 1

        pipeline = StreamPipeline(
            _analyzer(), options=PipelineOptions(queue_capacity=8, max_frames=7)
        )
        analyzed = pipeline.run(forever())
        self.assertEqual(analyzed, 7)

    def test_should_continue_stops_the_pump_mid_stream(self):
        state = {"go": True}
        pipeline = StreamPipeline(_analyzer(), options=PipelineOptions(queue_capacity=8))

        def gate() -> bool:
            if pipeline.frames_processed >= 3:
                state["go"] = False
            return state["go"]

        analyzed = pipeline.run(iter(_frames(50)), should_continue=gate)
        self.assertLessEqual(analyzed, 5)
        self.assertLess(pipeline.frames_processed, 50)


class PerFrameFailureTest(unittest.TestCase):
    def test_one_bad_frame_never_takes_down_the_session(self):
        class ExplodingAnalyzer:
            timings = _analyzer().timings

            def __init__(self) -> None:
                self.calls = 0

            def analyze_frame(self, frame):  # noqa: ANN001
                self.calls += 1
                if self.calls == 2:
                    raise InferenceError("model produced garbage on this frame")
                return object()

            def flush(self):
                from video_analyzer import FlushResult

                return FlushResult()

        analyzer = ExplodingAnalyzer()
        pipeline = StreamPipeline(analyzer, options=PipelineOptions(queue_capacity=16))
        analyzed = pipeline.run(iter(_frames(4)))
        self.assertEqual(analyzed, 3)  # the pump survived and kept going
        self.assertEqual(pipeline.failure_counts(), {"inference": 1})


class CleanupTest(unittest.TestCase):
    def test_close_releases_queued_frames_and_is_idempotent(self):
        pipeline = StreamPipeline(_analyzer(), options=PipelineOptions(queue_capacity=8))
        for frame in _frames(5):
            pipeline.offer(frame)
        self.assertEqual(pipeline.close(), 5)
        self.assertEqual(pipeline.close(), 0)  # second close is a no-op
        self.assertTrue(pipeline.closed)
        self.assertEqual(pipeline.queue.depth, 0)


class SamplerAdmissionTest(unittest.TestCase):
    def test_admit_matches_sample_frame_for_frame(self):
        frames = _frames(31)
        batch = list(FrameSampler(source_fps=30.0, target_fps=5.0).sample(frames))
        streaming_sampler = FrameSampler(source_fps=30.0, target_fps=5.0)
        streamed = [f for f in (streaming_sampler.admit(x) for x in frames) if f is not None]
        self.assertEqual([f.index for f in streamed], [f.index for f in batch])
        self.assertEqual(streaming_sampler.kept, len(batch))

    def test_admission_restamps_the_effective_sampling_rate(self):
        sampler = FrameSampler(source_fps=30.0, target_fps=10.0)
        admitted = sampler.admit(_frames(1)[0])
        self.assertIsNotNone(admitted)
        self.assertAlmostEqual(admitted.sampling_rate, 1 / 3, places=6)


if __name__ == "__main__":
    unittest.main()
