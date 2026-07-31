"""AI Playground CLI (AI-1) — analyze a video file and emit the `playground-output/` artifact set:

    playground-output/
    ├── original.mp4      (copy of the input)
    ├── annotated.mp4     (bounding boxes drawn; --annotate)
    ├── detections.json
    ├── events.json
    ├── metrics.json
    └── summary.txt

The 4 JSON/text documents are produced with stdlib only; `original.mp4`/`annotated.mp4` use OpenCV
(the real-video path, integration-only). Configurable options (Architect rec 5) have sensible
defaults. `--publish` routes generated events onto the backbone so they flow through the existing
spine → G-5 dashboard.

Usage:
  python playground_cli.py --input clip.mp4 --output playground-output --annotate
  python playground_cli.py --synthetic 10 --output playground-output      # no OpenCV needed
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from typing import List, Optional

from pipeline import EventSink, NullEventSink
from playground import build_adapter, write_artifacts
from video_analyzer import AnalyzeOptions, VideoAnalyzer
from video_decoder import IterableFrameDecoder, OpenCvFrameDecoder, StubFrameDecoder
from video_frame import Frame
from video_sampler import FrameSampler


def _build_event_sink(publish: bool, nats_url: str) -> EventSink:
    if not publish:
        return NullEventSink()
    from adapters.nats_sink import NatsEventSink  # noqa: WPS433 - integration-only

    return NatsEventSink(nats_url)


def run(args: argparse.Namespace) -> int:
    # 1) Decode + sample once (real video, or synthetic frames without OpenCV).
    if args.synthetic:
        base = StubFrameDecoder.synthetic(args.synthetic)
        all_frames: List[Frame] = list(base.decode())
        source_fps, source_video = base.source_fps, base.source_video
    else:
        if not args.input or not os.path.isfile(args.input):
            print(f"error: --input file not found: {args.input}", file=sys.stderr)
            return 2
        decoder = OpenCvFrameDecoder(args.input, resize_long_side=args.resize)
        all_frames = list(decoder.decode())
        source_fps, source_video = decoder.source_fps, decoder.source_video

    sampler = FrameSampler(source_fps=source_fps, target_fps=args.fps)
    sampled = list(sampler.sample(all_frames))

    zones: List[dict] = []
    if args.zones:
        with open(args.zones, encoding="utf-8") as fh:
            loaded = json.load(fh)
        zones = loaded.get("zones", loaded) if isinstance(loaded, (dict, list)) else []
        if isinstance(zones, dict):
            zones = zones.get("zones", [])

    # 2) Analyze the sampled frames (stride-1 over the already-sampled set → 1:1 with result.frames).
    options = AnalyzeOptions(
        tenant_id=args.tenant,
        camera_id=args.camera,
        model=args.model,
        engine=args.engine,
        labels=tuple(args.labels.split(",")) if args.labels else ("person",),
        min_confidence=args.confidence,
        iou_threshold=args.iou,
        target_fps=args.fps,
        source=source_video,
        session_id=args.session,
        enable_tracking=not args.no_tracking,
        zones=tuple(zones),
        track_min_hits=args.track_min_hits,
        track_max_age=args.track_max_age,
    )
    analyzer = VideoAnalyzer(
        build_adapter(args.engine),
        options,
        event_sink=_build_event_sink(args.publish, args.nats_url),
    )
    # The frames are already sampled — use a stride-1 pass so the analyzer does not re-sample.
    result = analyzer.analyze(
        IterableFrameDecoder(sampled, source_video=source_video, source_fps=source_fps),
        FrameSampler(stride=1),
    )
    # Reflect the REAL sampling numbers (the analyzer saw already-sampled frames).
    result.summary["framesDecoded"] = len(all_frames)
    result.summary["framesSampled"] = len(sampled)
    result.summary["framesDropped"] = sampler.dropped
    result.summary["samplingStride"] = sampler.stride

    # 3) Write artifacts.
    out_dir = args.output
    paths = write_artifacts(out_dir, result)
    if args.input:
        shutil.copyfile(args.input, os.path.join(out_dir, "original.mp4"))
    if args.annotate:
        _write_annotated(
            os.path.join(out_dir, "annotated.mp4"), sampled, result, source_fps, zones=zones, diagnostics=args.diagnostics
        )

    with open(paths["summary"], encoding="utf-8") as fh:
        print(fh.read())
    print(f"artifacts written to: {os.path.abspath(out_dir)}")
    return 0


def _write_annotated(path, sampled, result, fps, *, zones=None, diagnostics=False) -> None:
    """Draw the annotated video (OpenCV, real path). With --diagnostics, overlays track IDs +
    confidence, zone boundaries, and frame#/timestamp/FPS/stage-timings (Architect rec 7/8)."""
    try:
        import cv2  # noqa: WPS433
        import numpy as np  # noqa: WPS433
    except ImportError:
        print("note: OpenCV/numpy not installed — skipping annotated.mp4", file=sys.stderr)
        return
    if not sampled:
        return
    first = cv2.imdecode(np.frombuffer(sampled[0].image, dtype=np.uint8), cv2.IMREAD_COLOR)
    h, w = first.shape[0], first.shape[1]
    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), max(1.0, fps), (w, h))
    stage = result.summary.get("stageTimingsMs", {})
    try:
        for frame, fa in zip(sampled, result.frames):
            img = cv2.imdecode(np.frombuffer(frame.image, dtype=np.uint8), cv2.IMREAD_COLOR)
            if diagnostics:
                for z in zones or []:
                    pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in z["geometry"]["points"]], np.int32)
                    cv2.polylines(img, [pts], z.get("kind") == "area", (0, 180, 255), 2)
                for tr in fa.tracks:  # track boxes + IDs
                    bx = tr.get("bbox") or [0, 0, 0, 0]
                    x1, y1 = int(bx[0] * w), int(bx[1] * h)
                    x2, y2 = int((bx[0] + bx[2]) * w), int((bx[1] + bx[3]) * h)
                    cv2.rectangle(img, (x1, y1), (x2, y2), (0, 220, 0), 2)
                    cv2.putText(img, f"{tr['trackId']} {tr.get('state')} {tr.get('confidence'):.2f}",
                                (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 0), 1)
                cv2.putText(img, f"frame {fa.frame['frameIndex']} t={fa.frame['timestamp']} fps={fps:.1f}",
                            (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
                cv2.putText(img, f"infer={stage.get('inferenceMs')}ms track={stage.get('trackingMs')}ms",
                            (8, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            else:
                for det in fa.detections:
                    bx = det.get("bbox") or [0, 0, 0, 0]
                    x1, y1 = int(bx[0] * w), int(bx[1] * h)
                    x2, y2 = int((bx[0] + bx[2]) * w), int((bx[1] + bx[3]) * h)
                    cv2.rectangle(img, (x1, y1), (x2, y2), (0, 220, 0), 2)
                    cv2.putText(img, f"{det.get('label')} {det.get('confidence'):.2f}",
                                (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 220, 0), 1)
            writer.write(img)
    finally:
        writer.release()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ai-playground", description="Analyze a video through the AI-1 pipeline.")
    p.add_argument("--input", help="path to an MP4 (omit with --synthetic)")
    p.add_argument("--synthetic", type=int, default=0, help="analyze N synthetic frames (no OpenCV)")
    p.add_argument("--output", default="playground-output", help="output directory")
    p.add_argument("--tenant", default="tnt_dev")
    p.add_argument("--camera", default="cam_playground")
    p.add_argument("--model", default="person-detector")
    p.add_argument("--engine", default="stub", choices=["stub", "onnx"])
    p.add_argument("--labels", default="person", help="comma-separated class labels")
    p.add_argument("--confidence", type=float, default=0.5, help="min confidence threshold")
    p.add_argument("--iou", type=float, default=0.45, help="IoU (NMS) threshold")
    p.add_argument("--fps", type=float, default=None, help="target sampling FPS (default: keep all)")
    p.add_argument("--resize", type=int, default=None, help="resize long side (px) before inference")
    p.add_argument("--zones", help="path to a JSON file of generic zone configs (geometry + attributes)")
    p.add_argument("--session", default="sess_playground", help="inference session id (trackId scope)")
    p.add_argument("--no-tracking", action="store_true", help="disable the tracking/zones/counting stages")
    p.add_argument("--track-min-hits", type=int, default=3, help="detections before a track is confirmed")
    p.add_argument("--track-max-age", type=int, default=30, help="frames a lost track survives before removal")
    p.add_argument("--annotate", action="store_true", help="also write annotated.mp4")
    p.add_argument("--diagnostics", action="store_true", help="richer annotated overlays (track IDs, zones, timings)")
    p.add_argument("--publish", action="store_true", help="publish events to the backbone (NATS)")
    p.add_argument("--nats-url", default=os.environ.get("NATS_URL", "nats://localhost:4222"))
    return p


def main(argv: Optional[List[str]] = None) -> int:
    return run(build_parser().parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
