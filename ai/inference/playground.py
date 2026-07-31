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
        "metrics": result.summary["stageTimingsMs"],
    }
    if include_frames:
        out["frames"] = [{"frame": fa.frame, "detections": fa.detections, "events": fa.events} for fa in result.frames]
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
        "stageTimingsMs": result.summary.get("stageTimingsMs"),
    }
    return {"detections": detections_doc, "events": events_doc, "metrics": metrics_doc, "summary": _summary_text(result)}


def write_artifacts(out_dir: str, result: AnalyzeResult) -> dict:
    """Write detections.json, events.json, metrics.json, summary.txt into `out_dir`. Returns paths.
    The CLI adds original.mp4 + annotated.mp4 on the real path."""
    os.makedirs(out_dir, exist_ok=True)
    docs = result_to_documents(result)
    paths = {
        "detections": os.path.join(out_dir, "detections.json"),
        "events": os.path.join(out_dir, "events.json"),
        "metrics": os.path.join(out_dir, "metrics.json"),
        "summary": os.path.join(out_dir, "summary.txt"),
    }
    for key in ("detections", "events", "metrics"):
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
        "stage timings (ms, total):",
        f"  decode={t.get('decodeMs')}  sampling={t.get('samplingMs')}  preprocess={t.get('preprocessMs')}",
        f"  inference={t.get('inferenceMs')}  postprocess={t.get('postprocessMs')}  eventGen={t.get('eventGenerationMs')}",
        "",
    ]
    return "\n".join(lines)
