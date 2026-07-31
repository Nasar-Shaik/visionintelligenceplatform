"""Video Analyzer (AI-1) — the modular orchestrator that composes the AI pipeline over a video.

It is NOT a monolith (Architect rec 1): it wires the independently-testable stages —

    Frame Decoder → Frame Sampler → [ Image Preprocess → Inference → Post-process → Track → Translate ]
                                    → DetectionResult → Event Generator

reusing the EXISTING per-frame seams verbatim (`ModelAdapter`, `ConfidencePostprocessor`, `NoopTracker`,
`DefaultResultTranslator`, `detections_to_events`, and the `EventSink`) — nothing is re-implemented. It
records **per-stage timings** (rec 6), preserves **frame metadata** (rec 3), and keeps `DetectionResult`
**AI-neutral** (rec 2 — the contract already carries only label/confidence/bbox/…, no vendor fields).

Deterministic when a fixed `now_iso` + `id_gen` are injected (unit tests); stdlib-only.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence

from contracts import FrameContext, ModelBinding
from counting import CountingEngine
from events import counting_event, deterministic_id_gen, detections_to_events, zone_transition_event
from pipeline import (
    ConfidencePostprocessor,
    DefaultResultTranslator,
    EventSink,
    ModelAdapter,
    NoopTracker,
    NullEventSink,
    Postprocessor,
    ResultTranslator,
    Tracker,
)
from tracker import IouAssociator
from track_manager import TrackManager
from tracking_contracts import Zone
from video_decoder import FrameDecoder
from video_sampler import FrameSampler
from zones import ZoneEngine

_RUNTIME_VERSION = "0.1.0"


@dataclass
class AnalyzeOptions:
    """Configurable playground options (Architect rec 5) — all optional with sensible defaults."""

    tenant_id: str
    camera_id: str = "cam_playground"
    model: str = "person-detector"
    model_version: str = "1.0.0"
    engine: str = "stub"
    accelerator: str = "cpu"
    labels: Sequence[str] = ("person",)
    capability_id: str = "playground.detect"
    min_confidence: float = 0.5
    iou_threshold: float = 0.45  # reserved for NMS in a real post-processor (recorded in metadata)
    target_fps: Optional[float] = None
    source: str = "playground"
    correlation_id: Optional[str] = None
    # --- tracking + zones (AI-2) ---
    session_id: str = "sess_playground"
    enable_tracking: bool = True
    track_min_iou: float = 0.3
    track_min_hits: int = 3
    track_max_age: int = 30
    track_history_max: int = 50
    track_history_window_seconds: Optional[float] = None
    zones: Sequence[dict] = ()  # generic Zone configs (geometry + attributes); business meaning in rules


@dataclass
class StageTimings:
    """Cumulative per-stage wall-clock (ms) across all frames (rec 6 — find bottlenecks)."""

    decode_ms: float = 0.0
    sampling_ms: float = 0.0
    preprocess_ms: float = 0.0
    inference_ms: float = 0.0
    postprocess_ms: float = 0.0
    tracking_ms: float = 0.0
    zone_counting_ms: float = 0.0
    event_generation_ms: float = 0.0

    def as_dict(self) -> dict:
        return {
            "decodeMs": round(self.decode_ms, 3),
            "samplingMs": round(self.sampling_ms, 3),
            "preprocessMs": round(self.preprocess_ms, 3),
            "inferenceMs": round(self.inference_ms, 3),
            "postprocessMs": round(self.postprocess_ms, 3),
            "trackingMs": round(self.tracking_ms, 3),
            "zoneCountingMs": round(self.zone_counting_ms, 3),
            "eventGenerationMs": round(self.event_generation_ms, 3),
        }


@dataclass
class FrameAnalysis:
    frame: dict
    detections: List[dict]
    events: List[dict]
    tracks: List[dict] = field(default_factory=list)


@dataclass
class AnalyzeResult:
    frames: List[FrameAnalysis] = field(default_factory=list)
    detections: List[dict] = field(default_factory=list)
    events: List[dict] = field(default_factory=list)
    tracks: List[dict] = field(default_factory=list)  # final track diagnostics (active + archived)
    zone_transitions: List[dict] = field(default_factory=list)
    counting: List[dict] = field(default_factory=list)
    tracking_stats: dict = field(default_factory=dict)
    timings: StageTimings = field(default_factory=StageTimings)
    summary: dict = field(default_factory=dict)


class VideoAnalyzer:
    """Compose the pipeline over a decoded, sampled video and collect detections + events + timings."""

    def __init__(
        self,
        adapter: ModelAdapter,
        options: AnalyzeOptions,
        *,
        postprocessor: Optional[Postprocessor] = None,
        tracker: Optional[Tracker] = None,
        translator: Optional[ResultTranslator] = None,
        event_sink: Optional[EventSink] = None,
        runtime_version: str = _RUNTIME_VERSION,
        clock: Callable[[], float] = time.perf_counter,
        now_iso: Optional[Callable[[], str]] = None,
        id_gen: Optional[Callable[[], str]] = None,
    ) -> None:
        self._adapter = adapter
        self._options = options
        self._adapter.load({"labels": list(options.labels)})
        self._postprocessor = postprocessor or ConfidencePostprocessor(labels=options.labels)
        self._tracker = tracker or NoopTracker()
        self._translator = translator or DefaultResultTranslator()
        self._event_sink = event_sink or NullEventSink()
        self._runtime_version = runtime_version
        self._clock = clock
        self._now_iso = now_iso or (lambda: _iso(time.time()))
        self._id_gen = id_gen or deterministic_id_gen("evt")
        self._model = ModelBinding(
            name=options.model,
            version=options.model_version,
            task="detection",
            family="*",
            accelerator=options.accelerator,
        )
        # Tracking (AI-2): TrackManager owns lifecycle; the associator is the only swappable part.
        self._manager: Optional[TrackManager] = None
        self._counting: Optional[CountingEngine] = None
        self._zones: List[Zone] = [Zone.from_dict(z) for z in options.zones]
        if options.enable_tracking:
            self._manager = TrackManager(
                IouAssociator(min_iou=options.track_min_iou),
                session_id=options.session_id,
                min_hits=options.track_min_hits,
                max_age=options.track_max_age,
                history_max=options.track_history_max,
                history_window_seconds=options.track_history_window_seconds,
            )
            self._counting = CountingEngine(ZoneEngine())

    def analyze(self, decoder: FrameDecoder, sampler: Optional[FrameSampler] = None) -> AnalyzeResult:
        opts = self._options
        sampler = sampler or FrameSampler(
            source_fps=getattr(decoder, "source_fps", 30.0), target_fps=opts.target_fps
        )
        result = AnalyzeResult()

        # Decode, then sample — timed as distinct stages (rec 6). Materialized for clean per-stage
        # timing; streaming decode is a future optimization for long footage (AI_EXECUTION_ARCH §12).
        t = self._clock()
        decoded = list(decoder.decode())
        result.timings.decode_ms += (self._clock() - t) * 1000.0

        t = self._clock()
        sampled = list(sampler.sample(decoded))
        result.timings.sampling_ms += (self._clock() - t) * 1000.0

        for frame in sampled:
            ctx = FrameContext(
                tenant_id=opts.tenant_id,
                camera_id=opts.camera_id,
                image=frame.image,
                stream_id=None,
                frame_number=frame.index,
                timestamp=frame.timestamp,
                width=frame.processed_width,
                height=frame.processed_height,
                source=frame.source_video,
                correlation_id=opts.correlation_id,
            )

            t = self._clock()
            prepared = self._adapter.preprocess(ctx)
            result.timings.preprocess_ms += (self._clock() - t) * 1000.0

            t = self._clock()
            raw = self._adapter.infer(prepared)
            infer_ms = (self._clock() - t) * 1000.0
            result.timings.inference_ms += infer_ms

            t = self._clock()
            dets = self._postprocessor.run(raw, ctx, opts.min_confidence)
            dets = self._tracker.run(dets, ctx)
            det_result = self._translator.run(
                dets,
                ctx,
                self._model,
                capability_id=opts.capability_id,
                capability_version="1.0.0",
                runtime_version=self._runtime_version,
                execution_provider=getattr(self._adapter, "execution_provider", "unknown"),
                inference_ms=infer_ms,
                at=self._now_iso(),
            )
            result.timings.postprocess_ms += (self._clock() - t) * 1000.0

            result_dict = det_result.to_dict()
            frame_at = result_dict["at"]

            # --- Tracking → [Behavior seam, AI-3] → Zones → Counting (all consume TRACKS, not
            # detections — so a future Behavior Analysis stage inserts here without refactor, rec 3). ---
            frame_tracks: List[dict] = []
            frame_events: List[dict] = []
            if self._manager is not None and self._counting is not None:
                t = self._clock()
                tracks = self._manager.update(
                    dets, tenant_id=opts.tenant_id, camera_id=opts.camera_id, frame_index=frame.index, at=frame.timestamp
                )
                result.timings.tracking_ms += (self._clock() - t) * 1000.0
                # (Behavior Analysis would consume `tracks` here in AI-3 and may enrich them / emit events.)
                t = self._clock()
                transitions, snapshots = self._counting.update(
                    self._zones, tracks, frame_index=frame.index, at=frame.timestamp
                )
                result.timings.zone_counting_ms += (self._clock() - t) * 1000.0
                frame_tracks = [tr.to_dict() for tr in tracks]
                for tr in transitions:
                    d = tr.to_dict()
                    result.zone_transitions.append(d)
                    frame_events.append(zone_transition_event(d, id_gen=self._id_gen))
                for s in snapshots:
                    d = s.to_dict()
                    result.counting.append(d)
                    frame_events.append(counting_event(d, id_gen=self._id_gen))

            t = self._clock()
            events = detections_to_events(result_dict, id_gen=self._id_gen, ingested_at=frame_at)
            result.timings.event_generation_ms += (self._clock() - t) * 1000.0
            events = events + frame_events

            # Publish perception + tracking events to the backbone (reuses the EventSink seam).
            self._event_sink.publish(det_result)

            frame_dets = result_dict["detections"]
            result.frames.append(
                FrameAnalysis(frame=frame.meta(), detections=frame_dets, events=events, tracks=frame_tracks)
            )
            result.detections.extend(frame_dets)
            result.events.extend(events)

        if self._manager is not None:
            result.tracks = self._manager.diagnostics()
            result.tracking_stats = self._manager.stats(
                zone_crossings=len(result.zone_transitions),
                counting_events=len(result.counting),
                frames=max(1, len(sampled)),
            )
        result.summary = self._summary(decoder, sampler, decoded, sampled, result)
        return result

    def _summary(self, decoder, sampler, decoded, sampled, result: AnalyzeResult) -> dict:
        opts = self._options
        return {
            "sourceVideo": getattr(decoder, "source_video", opts.source),
            "tenantId": opts.tenant_id,
            "cameraId": opts.camera_id,
            "model": self._model.to_dict(),
            "engine": opts.engine,
            "executionProvider": getattr(self._adapter, "execution_provider", "unknown"),
            "options": {
                "minConfidence": opts.min_confidence,
                "iouThreshold": opts.iou_threshold,
                "targetFps": opts.target_fps,
                "labels": list(opts.labels),
            },
            "sessionId": opts.session_id,
            "framesDecoded": len(decoded),
            "framesSampled": len(sampled),
            "framesDropped": sampler.dropped,
            "samplingStride": sampler.stride,
            "detections": len(result.detections),
            "events": len(result.events),
            "trackingEnabled": opts.enable_tracking,
            "zones": len(self._zones),
            "zoneTransitions": len(result.zone_transitions),
            "countingEvents": len(result.counting),
            "tracking": result.tracking_stats,
            "stageTimingsMs": result.timings.as_dict(),
        }


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
