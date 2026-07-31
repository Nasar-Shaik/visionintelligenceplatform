"""AI Playground core (AI-1) — the engineering workbench (Architect rec 2 & 8).

Two entry points share one analyzer:
  - `analyze_request(body)` — used by `POST /playground/analyze`. Accepts already-decoded frames as
    base64 (deterministic, no OpenCV) so the HTTP path + CI need no heavy deps.
  - `write_artifacts(out_dir, result)` — writes the `playground-output/` artifact set
    (`detections.json`, `events.json`, `metrics.json`, `summary.txt`); the CLI adds `original.mp4` +
    `annotated.mp4` on the real path.

Every new detector/behaviour module should be validated here before entering customer workflows.
Stdlib-only.
"""

from __future__ import annotations

import base64
import json
import os
from typing import List, Mapping, Optional

from pipeline import EventSink, ModelAdapter
from video_analyzer import AnalyzeOptions, AnalyzeResult, VideoAnalyzer
from video_decoder import FrameDecoder, StubFrameDecoder
from video_sampler import FrameSampler


def build_adapter(engine: str) -> ModelAdapter:
    """Pick the inference backend. `stub` is dependency-free + deterministic (default). Real engines
    (onnx/…) import their runtime lazily and are integration-only — the pipeline stays unaware (rec 7)."""
    if engine in ("onnx",):
        from adapters.onnx_adapter import OnnxModelAdapter  # noqa: WPS433 - HEAVY, integration-only

        return OnnxModelAdapter()
    from adapters.fake_adapter import FakeModelAdapter  # noqa: WPS433

    return FakeModelAdapter()


def options_from_body(body: Mapping[str, object], tenant_id: str) -> AnalyzeOptions:
    """Map an /playground/analyze request body to AnalyzeOptions (all optional, sensible defaults)."""

    def _f(key: str, default):
        v = body.get(key)
        return v if isinstance(v, (int, float)) else default

    labels = body.get("labels")
    zones = body.get("zones")
    tracking = body.get("tracking") if isinstance(body.get("tracking"), dict) else {}
    behaviors = body.get("behaviors") if isinstance(body.get("behaviors"), dict) else {}
    profile = body.get("profile") if isinstance(body.get("profile"), dict) else None
    return AnalyzeOptions(
        tenant_id=tenant_id,
        camera_id=str(body.get("cameraId", "cam_playground")),
        model=str(body.get("model", "person-detector")),
        engine=str(body.get("engine", "stub")),
        labels=tuple(labels) if isinstance(labels, list) and labels else ("person",),
        min_confidence=float(_f("minConfidence", _f("confidence", 0.5))),
        iou_threshold=float(_f("iouThreshold", 0.45)),
        target_fps=(float(body["targetFps"]) if isinstance(body.get("targetFps"), (int, float)) else None),
        correlation_id=(str(body["correlationId"]) if isinstance(body.get("correlationId"), str) else None),
        session_id=str(body.get("sessionId", "sess_playground")),
        enable_tracking=bool(body.get("enableTracking", True)),
        zones=tuple(zones) if isinstance(zones, list) else (),
        track_min_iou=float(tracking.get("minIou", 0.3)),
        track_min_hits=int(tracking.get("minHits", 3)),
        track_max_age=int(tracking.get("maxAge", 30)),
        track_history_max=int(tracking.get("historyMax", 50)),
        enable_behaviors=bool(body.get("enableBehaviors", True)),
        behavior_options=dict(behaviors) if isinstance(behaviors, dict) else {},
        enable_composites=bool(body.get("enableComposites", True)),
        profile=profile,
    )


def analyze_request(body: Mapping[str, object], tenant_id: str, *, event_sink: Optional[EventSink] = None) -> dict:
    """Run the pipeline over base64 frames in the request; return summary + detections + events."""
    raw_frames = body.get("frames")
    images: List[bytes] = []
    if isinstance(raw_frames, list):
        for f in raw_frames:
            if isinstance(f, str) and f:
                images.append(base64.b64decode(f, validate=True))
    if not images:
        # Deterministic default so the endpoint is demonstrable without an upload.
        count = int(body["syntheticFrames"]) if isinstance(body.get("syntheticFrames"), (int, float)) else 5
        decoder: FrameDecoder = StubFrameDecoder.synthetic(count)
    else:
        decoder = StubFrameDecoder(images)

    options = options_from_body(body, tenant_id)
    analyzer = VideoAnalyzer(build_adapter(options.engine), options, event_sink=event_sink)
    result = analyzer.analyze(decoder)
    include_frames = bool(body.get("includeFrames", False))
    out: dict = {
        "summary": result.summary,
        "detections": result.detections,
        "events": result.events,
        "tracks": result.tracks,
        "zoneTransitions": result.zone_transitions,
        "counting": result.counting,
        "behaviors": result.behaviors,
        "composites": result.composites,
        "trackingStats": result.tracking_stats,
        "behaviorStats": result.behavior_stats,
        "compositeStats": result.composite_stats,
        "metrics": result.summary["stageTimingsMs"],
    }
    if include_frames:
        out["frames"] = [
            {"frame": fa.frame, "detections": fa.detections, "events": fa.events, "tracks": fa.tracks, "behaviors": fa.behaviors, "composites": fa.composites}
            for fa in result.frames
        ]
    return out


def result_to_documents(result: AnalyzeResult) -> dict:
    """The four playground documents as JSON-ready dicts / text (source of the artifact files)."""
    detections_doc = {
        "source": result.summary.get("sourceVideo"),
        "frames": [{"frame": fa.frame, "detections": fa.detections} for fa in result.frames],
        "detections": result.detections,
    }
    events_doc = {"events": result.events}
    metrics_doc = {
        "framesDecoded": result.summary.get("framesDecoded"),
        "framesSampled": result.summary.get("framesSampled"),
        "framesDropped": result.summary.get("framesDropped"),
        "detections": result.summary.get("detections"),
        "events": result.summary.get("events"),
        "zoneTransitions": result.summary.get("zoneTransitions"),
        "countingEvents": result.summary.get("countingEvents"),
        "tracking": result.summary.get("tracking"),
        "behaviors": result.summary.get("behaviors"),
        "behavior": result.summary.get("behavior"),
        "composites": result.summary.get("composites"),
        "composite": result.summary.get("composite"),
        "profile": result.summary.get("profile"),
        "stageTimingsMs": result.summary.get("stageTimingsMs"),
    }
    # Track Replay artifact (Architect rec 7/8): lifecycle + trajectory + zone transitions + counting.
    tracks_doc = {
        "sessionId": result.summary.get("sessionId"),
        "tracks": result.tracks,  # per-track identity + quality + history + lifecycle transitions
        "zoneTransitions": result.zone_transitions,  # entry/exit with timestamps
        "counting": result.counting,
        "stats": result.tracking_stats,
    }
    return {
        "detections": detections_doc,
        "events": events_doc,
        "metrics": metrics_doc,
        "tracks": tracks_doc,
        "behaviors": _behaviors_doc(result),
        "summary": _summary_text(result),
    }


def _behaviors_doc(result: AnalyzeResult) -> dict:
    """Behavior Replay artifact (Architect AI-3 rec 7) — `behaviors_timeline.json`: every BehaviorResult
    with its lifecycle transitions, confidence evolution, associated tracks/zones, and per-analyzer
    stats. An engineering-only debugging/regression surface (deterministic, replayable)."""
    # Group lifecycle transitions per behaviorId (started → updated → ended/expired) into a timeline.
    timeline: dict = {}
    order: list = []
    for b in result.behaviors:
        bid = b.get("behaviorId")
        if bid not in timeline:
            timeline[bid] = {
                "behaviorId": bid,
                "behaviorType": b.get("behaviorType"),
                "category": b.get("category"),
                "zoneId": b.get("zoneId"),
                "subjects": b.get("subjects"),
                "correlationId": b.get("correlationId"),
                "transitions": [],
            }
            order.append(bid)
        timeline[bid]["transitions"].append(
            {
                "state": b.get("state"),
                "frameIndex": b.get("frameIndex"),
                "at": b.get("lastObserved"),
                "confidence": b.get("confidence"),
                "metrics": b.get("metrics"),
            }
        )
    # Composite graph (Architect AI-4 rec 1/9): composite behaviorId → its contributing behaviorIds,
    # plus a behavior dependency graph (behaviorType edges) and the deterministic execution order (rec 6).
    composite_graph = [
        {
            "behaviorId": c.get("behaviorId"),
            "behaviorType": c.get("behaviorType"),
            "state": c.get("state"),
            "contributors": c.get("relatedBehaviorIds", []),
            "composite": c.get("composite"),
            "trace": (c.get("attributes", {}) or {}).get("compositeTrace", []),
        }
        for c in result.composites
    ]
    edges = set()
    for c in result.composites:
        for e in (c.get("attributes", {}) or {}).get("compositeTrace", []):
            edges.add((e.get("behaviorType"), c.get("behaviorType")))
    dependency_graph = sorted(edges)
    execution_order = {
        "primitive": [m["analyzer"] for m in result.behavior_stats.get("analyzers", [])],
        "composite": [m["analyzer"] for m in result.composite_stats.get("analyzers", [])],
        "flow": "primitive behaviors → composite behaviors → translator → EventEnvelope",
    }
    return {
        "sessionId": result.summary.get("sessionId"),
        "profile": result.summary.get("profile"),
        "behaviors": [timeline[bid] for bid in order],
        "results": result.behaviors,  # the raw BehaviorResult stream (contract-shaped)
        "composites": result.composites,  # the composite BehaviorResult stream
        "compositeGraph": composite_graph,
        "dependencyGraph": [{"from": a, "to": b} for a, b in dependency_graph],
        "executionOrder": execution_order,
        "stats": result.behavior_stats,
        "compositeStats": result.composite_stats,
        "analyzers": result.behavior_stats.get("analyzers", []),
    }


def write_artifacts(out_dir: str, result: AnalyzeResult) -> dict:
    """Write detections.json, events.json, metrics.json, summary.txt into `out_dir`. Returns paths.
    The CLI adds original.mp4 + annotated.mp4 on the real path."""
    os.makedirs(out_dir, exist_ok=True)
    docs = result_to_documents(result)
    paths = {
        "detections": os.path.join(out_dir, "detections.json"),
        "events": os.path.join(out_dir, "events.json"),
        "metrics": os.path.join(out_dir, "metrics.json"),
        "tracks": os.path.join(out_dir, "tracks.json"),
        "behaviors": os.path.join(out_dir, "behaviors_timeline.json"),
        "summary": os.path.join(out_dir, "summary.txt"),
    }
    for key in ("detections", "events", "metrics", "tracks", "behaviors"):
        with open(paths[key], "w", encoding="utf-8") as fh:
            json.dump(docs[key], fh, indent=2, sort_keys=True)
            fh.write("\n")
    with open(paths["summary"], "w", encoding="utf-8") as fh:
        fh.write(docs["summary"])
    return paths


def _summary_text(result: AnalyzeResult) -> str:
    s = result.summary
    t = s.get("stageTimingsMs", {})
    lines = [
        "AI Playground — analysis summary",
        "=================================",
        f"source        : {s.get('sourceVideo')}",
        f"tenant/camera : {s.get('tenantId')} / {s.get('cameraId')}",
        f"model/engine  : {s.get('model', {}).get('name')} v{s.get('model', {}).get('version')} ({s.get('engine')}, {s.get('executionProvider')})",
        f"frames        : decoded={s.get('framesDecoded')} sampled={s.get('framesSampled')} dropped={s.get('framesDropped')} (stride {s.get('samplingStride')})",
        f"detections    : {s.get('detections')}",
        f"events        : {s.get('events')}",
        f"tracking      : {_tracking_line(s)}",
        f"zones         : {s.get('zones')} · transitions={s.get('zoneTransitions')} · counting={s.get('countingEvents')}",
        f"behaviors     : {_behavior_line(s)}",
        f"composites    : {_composite_line(s)}",
        f"profile       : {s.get('profile') or 'none'}",
        "stage timings (ms, total):",
        f"  decode={t.get('decodeMs')}  sampling={t.get('samplingMs')}  preprocess={t.get('preprocessMs')}",
        f"  inference={t.get('inferenceMs')}  postprocess={t.get('postprocessMs')}",
        f"  tracking={t.get('trackingMs')}  zoneCounting={t.get('zoneCountingMs')}  behavior={t.get('behaviorMs')}  composite={t.get('compositeMs')}  eventGen={t.get('eventGenerationMs')}",
        "",
    ]
    return "\n".join(lines)


def _composite_line(summary: dict) -> str:
    if not summary.get("compositesEnabled"):
        return "disabled"
    c = summary.get("composite", {})
    return (
        f"results={summary.get('composites', 0)} evaluations={c.get('compositeEvaluations', 0)} "
        f"matches={c.get('compositeMatches', 0)} misses={c.get('compositeMisses', 0)}"
    )


def _behavior_line(summary: dict) -> str:
    if not summary.get("behaviorsEnabled"):
        return "disabled"
    b = summary.get("behavior", {})
    by_type: dict = {}
    for m in b.get("analyzers", []):
        if m.get("behaviorsProduced"):
            by_type[m["analyzer"]] = m["behaviorsProduced"]
    detail = " ".join(f"{k}={v}" for k, v in by_type.items()) or "none"
    return (
        f"results={summary.get('behaviors', 0)} started={b.get('startedBehaviors', 0)} "
        f"completed={b.get('completedBehaviors', 0)} [{detail}]"
    )


def _tracking_line(summary: dict) -> str:
    if not summary.get("trackingEnabled"):
        return "disabled"
    tr = summary.get("tracking", {})
    return (
        f"active={tr.get('activeTracks', 0)} confirmed={tr.get('confirmedTracks', 0)} "
        f"lost={tr.get('lostTracks', 0)} removed={tr.get('removedTracks', 0)} "
        f"avgAge={tr.get('averageTrackAgeFrames', 0)} avgVel={tr.get('averageTrackVelocity', 0)}"
    )
