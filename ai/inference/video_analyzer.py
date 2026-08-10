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
from typing import Callable, List, Mapping, Optional, Sequence

from behavior import BehaviorContext, BehaviorLifecycleStore, frame_seconds, snapshot_track
from behavior_registry import BehaviorRegistry
from behavior_translator import BehaviorResultTranslator
from behaviors import default_registry
from composite import CompositeContext
from composite_registry import CompositeRegistry
from contracts import FrameContext, ModelBinding
from counting import CountingEngine
from events import counting_event, deterministic_id_gen, detections_to_events, zone_transition_event
from profiles import build_from_profile, zone_roles_from_zones
from temporal_window import TemporalWindowStore
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


def _own_slot(adapter: ModelAdapter, binding: ModelBinding):  # noqa: ANN202 - ModelSlot
    """A private, never-swapped slot for an analyzer nobody handed one to.

    Imported lazily so the AI-1…AI-4 analysis path keeps its exact import graph: model lifecycle is an
    AI-5d operational concern and the perception pipeline must not depend on it to run.
    """
    from model_lifecycle import ModelSlot

    return ModelSlot(adapter, binding)


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
    #: Per-label overrides of `min_confidence`. ⚠️ Mirrors `CapabilityManifest.min_confidence_by_label`
    #: so an offline analysis reports what the live path would have reported — a floor that applied
    #: on one path and not the other would make replay disagree with production for reasons no
    #: measurement could explain.
    min_confidence_by_label: Mapping[str, float] = field(default_factory=dict)
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
    # --- behavior analysis (AI-3) ---
    enable_behaviors: bool = True
    behavior_options: dict = field(default_factory=dict)  # per-analyzer knobs for default_registry
    # --- composite behaviors + profiles (AI-4) ---
    enable_composites: bool = True
    profile: Optional[dict] = None  # a BehaviorProfile dict; when set, drives analyzers + composites


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
    behavior_ms: float = 0.0
    composite_ms: float = 0.0
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
            "behaviorMs": round(self.behavior_ms, 3),
            "compositeMs": round(self.composite_ms, 3),
            "eventGenerationMs": round(self.event_generation_ms, 3),
        }


@dataclass
class FrameAnalysis:
    """Everything ONE frame produced. `analyze_frame` returns this and keeps nothing per-frame, so the
    CALLER decides retention (AI-5b: batch keeps every frame; a live session must not, or a
    long-running camera would grow without bound)."""

    frame: dict
    detections: List[dict]
    events: List[dict]
    tracks: List[dict] = field(default_factory=list)
    behaviors: List[dict] = field(default_factory=list)
    composites: List[dict] = field(default_factory=list)
    # AI-5b: also returned per-frame (previously accumulated straight into AnalyzeResult) so a
    # streaming caller can observe them without retaining the whole run.
    zone_transitions: List[dict] = field(default_factory=list)
    counting: List[dict] = field(default_factory=list)


@dataclass
class FlushResult:
    """Terminal-flush output — behaviors/composites that were still active when the stream ended."""

    behaviors: List[dict] = field(default_factory=list)
    composites: List[dict] = field(default_factory=list)
    events: List[dict] = field(default_factory=list)


@dataclass
class AnalyzeResult:
    frames: List[FrameAnalysis] = field(default_factory=list)
    detections: List[dict] = field(default_factory=list)
    events: List[dict] = field(default_factory=list)
    tracks: List[dict] = field(default_factory=list)  # final track diagnostics (active + archived)
    zone_transitions: List[dict] = field(default_factory=list)
    counting: List[dict] = field(default_factory=list)
    behaviors: List[dict] = field(default_factory=list)  # every BehaviorResult across the video (AI-3)
    composites: List[dict] = field(default_factory=list)  # every CompositeBehavior across the video (AI-4)
    tracking_stats: dict = field(default_factory=dict)
    behavior_stats: dict = field(default_factory=dict)
    composite_stats: dict = field(default_factory=dict)
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
        behavior_registry: Optional[BehaviorRegistry] = None,
        runtime_version: str = _RUNTIME_VERSION,
        clock: Callable[[], float] = time.perf_counter,
        now_iso: Optional[Callable[[], str]] = None,
        id_gen: Optional[Callable[[], str]] = None,
        slot=None,  # noqa: ANN001 - model_lifecycle.ModelSlot (AI-5d; None = a private slot)
    ) -> None:
        self._options = options
        adapter.load({"labels": list(options.labels)})
        self._postprocessor = postprocessor or ConfidencePostprocessor(
            labels=options.labels, floors=options.min_confidence_by_label
        )
        self._tracker = tracker or NoopTracker()
        self._translator = translator or DefaultResultTranslator()
        self._event_sink = event_sink or NullEventSink()
        self._runtime_version = runtime_version
        self._clock = clock
        self._now_iso = now_iso or (lambda: _iso(time.time()))
        self._id_gen = id_gen or deterministic_id_gen("evt")
        binding = ModelBinding(
            name=options.model,
            version=options.model_version,
            task="detection",
            family="*",
            accelerator=options.accelerator,
        )
        # AI-5d: the analyzer holds a SLOT, not an adapter, and reads it per frame. That single
        # indirection is what makes a model version swap zero-downtime — promoting a version changes
        # what the next frame executes and nothing else, so no session stops and no queue drains.
        # When no slot is supplied the analyzer owns a private one, so every existing caller and every
        # existing behavior is unchanged.
        self._slot = slot if slot is not None else _own_slot(adapter, binding)
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
        # Behavior analysis (AI-3): registry-driven analyzers over Tracks; the lifecycle store + window
        # store persist across frames so analyzers stay stateless; one translator bridges to events.
        self._behaviors: Optional[BehaviorRegistry] = None
        self._behavior_store: Optional[BehaviorLifecycleStore] = None
        self._windows: Optional[TemporalWindowStore] = None
        self._behavior_translator: Optional[BehaviorResultTranslator] = None
        self._behavior_zone_engine = ZoneEngine()
        # Composite tier (AI-4): a second pass over active BehaviorResults; its own registry + store.
        self._composites: Optional[CompositeRegistry] = None
        self._composite_store: Optional[BehaviorLifecycleStore] = None
        self._zone_roles = zone_roles_from_zones(self._zones)
        self._profile_loads = 0
        self._profile_failures = 0
        # Running aggregates for `analyze_frame` (AI-5b): bounded scalars only — NO frames, images, or
        # per-frame results are retained, so a session that runs for a week costs the same as one that
        # runs for a minute. Frame retention is the caller's decision (refinement 2).
        self._timings = StageTimings()
        self._frames_analyzed = 0
        self._first_frame_meta: Optional[tuple] = None
        self._last_frame_meta: Optional[tuple] = None
        self._relationship_count = 0
        self._composite_total = 0
        self._zone_transition_total = 0
        self._counting_total = 0
        if options.enable_tracking and options.enable_behaviors:
            composite_registry: Optional[CompositeRegistry] = None
            if options.profile is not None:
                # A profile drives BOTH primitive analyzers and composites (fail-fast validated).
                self._behaviors, composite_registry = build_from_profile(options.profile)
                self._profile_loads = 1
            else:
                self._behaviors = behavior_registry or default_registry(options.behavior_options)
            self._behavior_store = BehaviorLifecycleStore(
                camera_id=options.camera_id, session_id=options.session_id, tenant_id=options.tenant_id
            )
            self._windows = TemporalWindowStore()
            self._behavior_translator = BehaviorResultTranslator(id_gen=self._id_gen)
            if options.enable_composites:
                self._composites = composite_registry or CompositeRegistry()
                self._composites.validate_acyclic()
                self._composite_store = BehaviorLifecycleStore(
                    camera_id=options.camera_id, session_id=options.session_id, tenant_id=options.tenant_id
                )

    # --- the model seam (AI-5d) ---------------------------------------------------
    # Read through the slot on every access rather than cached at construction: a version promoted
    # mid-session must reach the very next frame, and a cached reference is precisely what would
    # leave a long-running session serving the old model forever.

    @property
    def _adapter(self):  # noqa: ANN202 - pipeline.ModelAdapter
        return self._slot.adapter

    @property
    def _model(self) -> ModelBinding:
        return self._slot.binding

    @property
    def slot(self):  # noqa: ANN201 - model_lifecycle.ModelSlot
        """This analyzer's model slot — what a lifecycle transition swaps to switch traffic."""
        return self._slot

    def analyze(self, decoder: FrameDecoder, sampler: Optional[FrameSampler] = None) -> AnalyzeResult:
        """Batch analysis over a FINITE source — unchanged behavior, now expressed as a loop over
        `analyze_frame` plus a terminal `flush` (AI-5b). Keeping one code path for batch and live means
        the live runtime cannot silently diverge from the pipeline the whole suite validates."""
        opts = self._options
        sampler = sampler or FrameSampler(
            source_fps=getattr(decoder, "source_fps", 30.0), target_fps=opts.target_fps
        )
        result = AnalyzeResult()
        self._timings = result.timings  # per-call accumulation (batch semantics unchanged)

        # Decode, then sample — timed as distinct stages (rec 6). Materialized for clean per-stage
        # timing; streaming decode is a future optimization for long footage (AI_EXECUTION_ARCH §12).
        t = self._clock()
        decoded = list(decoder.decode())
        result.timings.decode_ms += (self._clock() - t) * 1000.0

        t = self._clock()
        sampled = list(sampler.sample(decoded))
        result.timings.sampling_ms += (self._clock() - t) * 1000.0

        for frame in sampled:
            analysis = self.analyze_frame(frame)
            result.frames.append(analysis)
            result.detections.extend(analysis.detections)
            result.events.extend(analysis.events)
            result.zone_transitions.extend(analysis.zone_transitions)
            result.counting.extend(analysis.counting)
            result.behaviors.extend(analysis.behaviors)
            result.composites.extend(analysis.composites)

        # Terminal flush (AI-3): behaviors still active at end-of-video close as `expired` (rec 2).
        if sampled:
            flushed = self.flush()
            result.behaviors.extend(flushed.behaviors)
            result.composites.extend(flushed.composites)
            result.events.extend(flushed.events)

        if self._manager is not None:
            result.tracks = self._manager.diagnostics()
            result.tracking_stats = self._manager.stats(
                zone_crossings=len(result.zone_transitions),
                counting_events=len(result.counting),
                frames=max(1, len(sampled)),
            )
        if self._behaviors is not None and self._behavior_store is not None:
            result.behavior_stats = self.behavior_stats(frames=len(sampled))
        if self._composites is not None:
            result.composite_stats = self.composite_stats()
        result.summary = self._summary(decoder, sampler, decoded, sampled, result)
        return result

    def analyze_frame(self, frame) -> FrameAnalysis:
        """Analyze ONE frame — the single per-frame path shared by batch and live execution.

        **Pure with respect to the Frame** (Architect AI-5b refinement 1): the frame is read, never
        mutated, and never retained by the analyzer. `Frame` is a frozen dataclass, so immutability is
        structural rather than a convention; frame OWNERSHIP stays with the caller (`StreamPipeline`
        for live sessions), and this method owns **AI processing only** (refinement 2).

        Cross-frame PIPELINE state (tracks, behavior lifecycle, temporal windows) is legitimately
        retained — that is what makes tracking and behavior analysis possible — but no frame, image
        buffer, or per-frame result is.
        """
        opts = self._options
        timings = self._timings
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
        timings.preprocess_ms += (self._clock() - t) * 1000.0

        t = self._clock()
        raw = self._adapter.infer(prepared)
        infer_ms = (self._clock() - t) * 1000.0
        timings.inference_ms += infer_ms

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
        timings.postprocess_ms += (self._clock() - t) * 1000.0

        result_dict = det_result.to_dict()
        frame_at = result_dict["at"]

        # --- Tracking → Zones → Counting → Behavior Analysis (all consume TRACKS, not detections;
        # Architect rec 9: Behavior runs AFTER zone/counting so analyzers see zone membership + counts,
        # each stage independently replaceable). ---
        frame_tracks: List[dict] = []
        frame_behaviors: List[dict] = []
        frame_composites: List[dict] = []
        frame_events: List[dict] = []
        frame_transitions: List[dict] = []
        frame_counts: List[dict] = []
        if self._manager is not None and self._counting is not None:
            t = self._clock()
            tracks = self._manager.update(
                dets, tenant_id=opts.tenant_id, camera_id=opts.camera_id, frame_index=frame.index, at=frame.timestamp
            )
            timings.tracking_ms += (self._clock() - t) * 1000.0
            t = self._clock()
            transitions, snapshots = self._counting.update(
                self._zones, tracks, frame_index=frame.index, at=frame.timestamp
            )
            timings.zone_counting_ms += (self._clock() - t) * 1000.0
            frame_tracks = [tr.to_dict() for tr in tracks]
            for tr in transitions:
                d = tr.to_dict()
                frame_transitions.append(d)
                frame_events.append(zone_transition_event(d, id_gen=self._id_gen))
            for s in snapshots:
                d = s.to_dict()
                frame_counts.append(d)
                frame_events.append(counting_event(d, id_gen=self._id_gen))

            # Behavior stage — analyzers consume immutable snapshots + zone/counting state; the
            # store assigns lifecycle; the translator bridges each BehaviorResult to an event.
            if self._behaviors is not None and self._behavior_store is not None and self._windows is not None:
                t = self._clock()
                ctx_b = BehaviorContext(
                    tenant_id=opts.tenant_id,
                    camera_id=opts.camera_id,
                    frame_index=frame.index,
                    at=frame.timestamp,
                    t=frame_seconds(frame.timestamp, frame.index),
                    snapshots=tuple(snapshot_track(tr, frame.index) for tr in tracks),
                    zones=tuple(self._zones),
                    transitions=tuple(frame_transitions),
                    counting=tuple(frame_counts),
                    windows=self._windows,
                    zone_engine=self._behavior_zone_engine,
                    session_id=opts.session_id,
                )
                produced = self._behaviors.run(ctx_b, self._behavior_store)
                timings.behavior_ms += (self._clock() - t) * 1000.0
                for br in produced:
                    d = br.to_dict()
                    frame_behaviors.append(d)
                    env = self._behavior_translator.translate(d)
                    if env is not None:
                        frame_events.append(env)

                # Composite pass (AI-4) — consumes the ACTIVE primitive BehaviorResults (never
                # Tracks; rec 5), producing higher-order BehaviorResults with relationships.
                if self._composites is not None and self._composite_store is not None:
                    t = self._clock()
                    active = self._behavior_store.active_results(frame_index=frame.index, at=frame.timestamp)
                    ctx_c = CompositeContext(
                        tenant_id=opts.tenant_id,
                        camera_id=opts.camera_id,
                        frame_index=frame.index,
                        at=frame.timestamp,
                        t=frame_seconds(frame.timestamp, frame.index),
                        behaviors=tuple(active),
                        zone_roles=self._zone_roles,
                        session_id=opts.session_id,
                    )
                    composed = self._composites.run(ctx_c, self._composite_store)
                    timings.composite_ms += (self._clock() - t) * 1000.0
                    for cb in composed:
                        d = cb.to_dict()
                        frame_composites.append(d)
                        env = self._behavior_translator.translate(d)
                        if env is not None:
                            frame_events.append(env)

        t = self._clock()
        events = detections_to_events(result_dict, id_gen=self._id_gen, ingested_at=frame_at)
        timings.event_generation_ms += (self._clock() - t) * 1000.0
        events = events + frame_events

        # Publish perception + tracking events to the backbone (reuses the EventSink seam).
        self._event_sink.publish(det_result)

        # Running aggregates the analyzer legitimately owns (bounded scalars, never frame data) so a
        # live session can report stats without retaining every frame it has ever seen.
        self._frames_analyzed += 1
        self._last_frame_meta = (frame.index, frame.timestamp)
        if self._first_frame_meta is None:
            self._first_frame_meta = (frame.index, frame.timestamp)
        self._relationship_count += _count_relationships(frame_behaviors) + _count_relationships(frame_composites)
        self._composite_total += len(frame_composites)
        self._zone_transition_total += len(frame_transitions)
        self._counting_total += len(frame_counts)

        return FrameAnalysis(
            frame=frame.meta(),
            detections=result_dict["detections"],
            events=events,
            tracks=frame_tracks,
            behaviors=frame_behaviors,
            composites=frame_composites,
            zone_transitions=frame_transitions,
            counting=frame_counts,
        )

    def flush(self) -> FlushResult:
        """Terminal flush (AI-3 rec 2): behaviors/composites still active when the stream ends close as
        `expired`. Called at end-of-video (batch) and at session stop (live) — the same code path, so a
        live session can never leak an unterminated behavior that batch would have closed."""
        out = FlushResult()
        if (
            self._behaviors is None
            or self._behavior_store is None
            or self._behavior_translator is None
            or self._last_frame_meta is None
        ):
            return out
        index, at = self._last_frame_meta
        t_seconds = frame_seconds(at, index)
        for br in self._behavior_store.sweep(frame_index=index, at=at, t=t_seconds):
            d = br.to_dict()
            out.behaviors.append(d)
            self._relationship_count += _count_relationships([d])
            env = self._behavior_translator.translate(d)
            if env is not None:
                out.events.append(env)
        # Composite terminal flush (AI-4).
        if self._composites is not None and self._composite_store is not None:
            for cb in self._composite_store.sweep(frame_index=index, at=at, t=t_seconds):
                d = cb.to_dict()
                out.composites.append(d)
                self._composite_total += 1
                self._relationship_count += _count_relationships([d])
                env = self._behavior_translator.translate(d)
                if env is not None:
                    out.events.append(env)
        return out

    @property
    def timings(self) -> StageTimings:
        """Cumulative per-stage timings for the frames analyzed so far (live sessions read this)."""
        return self._timings

    def tracking_stats(self, *, frames: Optional[int] = None) -> dict:
        """Track-manager observability for the frames analyzed so far (live-session safe)."""
        if self._manager is None:
            return {}
        return self._manager.stats(
            zone_crossings=self._zone_transition_total,
            counting_events=self._counting_total,
            frames=max(1, self._frames_analyzed if frames is None else frames),
        )

    def behavior_stats(self, *, frames: Optional[int] = None) -> dict:
        """Aggregate behavior observability (Architect rec 8 + refinement 7) — additive RuntimeMetrics
        fields + a per-analyzer breakdown. Business-neutral counts/durations/latencies only."""
        assert self._behaviors is not None and self._behavior_store is not None and self._windows is not None
        frames = max(1, self._frames_analyzed if frames is None else frames)
        store = self._behavior_store.stats()
        agg = self._behaviors.aggregate_metrics(frames=frames, behavior_latency_ms=self._timings.behavior_ms)
        started = store.get("startedBehaviors", 0)
        if self._first_frame_meta is not None and self._last_frame_meta is not None:
            first_index, first_at = self._first_frame_meta
            last_index, last_at = self._last_frame_meta
            elapsed = frame_seconds(last_at, last_index) - frame_seconds(first_at, first_index)
        else:
            elapsed = 0.0
        if elapsed <= 0:
            elapsed = float(frames)  # frame-index proxy when timestamps aren't seconds
        # Relationship count (AI-4 rec 8): every related/parent/follows reference across all behaviors,
        # tallied incrementally as frames are analyzed so a live session needs no retained history.
        relationships = self._relationship_count
        stats = {
            **store,
            **agg,
            **self._windows.stats(),
            "behaviorsPerMinute": round(started / (elapsed / 60.0), 6) if elapsed else 0.0,
            "behaviorRelationshipCount": relationships,
            "profileLoads": self._profile_loads,
            "profileValidationFailures": self._profile_failures,
            "activeProfiles": self._profile_loads,
        }
        stats["analyzers"] = self._behaviors.analyzer_metrics()
        return stats

    def composite_stats(self) -> dict:
        """Aggregate composite observability (Architect AI-4 rec 8 + refinement 8) — additive."""
        assert self._composites is not None
        agg = self._composites.aggregate_metrics()
        agg["compositeBehaviorCount"] = self._composite_total
        agg["analyzers"] = self._composites.analyzer_metrics()
        return agg

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
                # ⚠️ Recorded so a stored analysis can say which floors produced it. Two runs of the
                # same footage under different floors are two different measurements, and a summary
                # that named only the default would make them look identical.
                **(
                    {}
                    if not opts.min_confidence_by_label
                    else {"minConfidenceByLabel": dict(sorted(opts.min_confidence_by_label.items()))}
                ),
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
            "behaviorsEnabled": opts.enable_tracking and opts.enable_behaviors,
            "behaviors": len(result.behaviors),
            "behavior": result.behavior_stats,
            "compositesEnabled": opts.enable_tracking and opts.enable_behaviors and opts.enable_composites,
            "composites": len(result.composites),
            "composite": result.composite_stats,
            "profile": (opts.profile or {}).get("profile") if opts.profile else None,
            "stageTimingsMs": result.timings.as_dict(),
        }


def _count_relationships(behaviors: List[dict]) -> int:
    """Every related/parent/follows reference across a batch of behaviors (AI-4 rec 8)."""
    return sum(
        len(b.get("relatedBehaviorIds", []) or [])
        + (1 if b.get("parentBehaviorId") else 0)
        + (1 if b.get("followsBehaviorId") else 0)
        for b in behaviors
    )


def _iso(now: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
