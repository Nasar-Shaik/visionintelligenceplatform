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
        "timeline": timeline_doc(result),
        "incidents": incidents_doc(result),
        "evidence": evidence_doc(result),
        "performance": performance_doc(result),
        "summary": _summary_text(result),
    }


# --- AI-5e: the workbench surfaces (Architect priority 2) --------------------------------------


def timeline_doc(result: AnalyzeResult) -> dict:
    """One chronological timeline across every tier (AI-5e).

    The per-tier documents each answer "what did tracking do?" or "what did behaviour do?". None of
    them answers the question an engineer or a customer actually asks in front of a clip: **"what
    happened, in order?"** Correlating that by hand across four JSON files is the single most tedious
    thing about debugging a video, so the playground does it once, here.

    Entries are ordered by frame index, then by tier, so the reading order matches causality:
    a detection precedes the track it feeds, which precedes the behaviour, which precedes the event.
    """
    _TIER_ORDER = {"detection": 0, "track": 1, "behavior": 2, "composite": 3, "event": 4}
    entries: List[dict] = []
    seen_tracks: set = set()
    seen_states: set = set()
    for fa in result.frames:
        index = fa.frame.get("frameIndex")
        at = fa.frame.get("timestamp")
        if fa.detections:
            labels: dict = {}
            for det in fa.detections:
                labels[det.get("label", "object")] = labels.get(det.get("label", "object"), 0) + 1
            entries.append(
                {
                    "frameIndex": index,
                    "at": at,
                    "tier": "detection",
                    "label": ", ".join(f"{v}× {k}" for k, v in sorted(labels.items())),
                    "detail": {"count": len(fa.detections), "byLabel": labels},
                }
            )
        for track in fa.tracks:
            # Only lifecycle CHANGES belong on a timeline. A confirmed track present for 400 frames
            # is one event, not 400, and printing it 400 times would bury everything else.
            key = (track.get("trackId"), track.get("state"))
            if key in seen_tracks:
                continue
            seen_tracks.add(key)
            entries.append(
                {
                    "frameIndex": index,
                    "at": at,
                    "tier": "track",
                    "label": f"track {track.get('trackId')} → {track.get('state')}",
                    "detail": {
                        "trackId": track.get("trackId"),
                        "state": track.get("state"),
                        "confidence": track.get("confidence"),
                    },
                }
            )
        for item, tier in [(b, "behavior") for b in fa.behaviors] + [
            (c, "composite") for c in fa.composites
        ]:
            key = (item.get("behaviorId"), item.get("state"))
            if key in seen_states:
                continue
            seen_states.add(key)
            entries.append(
                {
                    "frameIndex": index,
                    "at": at,
                    "tier": tier,
                    "label": f"{item.get('behaviorType')} {item.get('state')}",
                    "detail": {
                        "behaviorId": item.get("behaviorId"),
                        "behaviorType": item.get("behaviorType"),
                        "state": item.get("state"),
                        "confidence": item.get("confidence"),
                        "zoneId": item.get("zoneId"),
                        "metrics": item.get("metrics"),
                    },
                }
            )
        for event in fa.events:
            entries.append(
                {
                    "frameIndex": index,
                    "at": at,
                    "tier": "event",
                    "label": str(event.get("type", "event")),
                    "detail": {
                        "type": event.get("type"),
                        "priority": event.get("priority"),
                        "correlationId": event.get("correlationId"),
                    },
                }
            )
    entries.sort(key=lambda e: (e.get("frameIndex") or 0, _TIER_ORDER.get(e["tier"], 9)))
    return {
        "sessionId": result.summary.get("sessionId"),
        "source": result.summary.get("sourceVideo"),
        "entries": entries,
        "counts": {
            tier: sum(1 for e in entries if e["tier"] == tier)
            for tier in ("detection", "track", "behavior", "composite", "event")
        },
    }


def incidents_doc(result: AnalyzeResult) -> dict:
    """Incident **candidates** — deliberately not incidents (AI-5e).

    The AI runtime emits events. Whether a `behavior.loitering.detected` at 02:14 is an incident is a
    business decision owned by the rules service, and the perception tier must never make it (Law 1,
    and the reason `BehaviorResult` carries no business meaning). So this document shows what a rule
    would see — the events grouped by type with their correlation ids and timing — and says plainly
    that nothing here has been adjudicated.

    It exists because a demonstration needs to show the path from pixels to incident, and showing an
    honest candidate list is better than either showing nothing or inventing an incident.
    """
    grouped: dict = {}
    for fa in result.frames:
        for event in fa.events:
            etype = str(event.get("type", "event"))
            bucket = grouped.setdefault(
                etype,
                {
                    "eventType": etype,
                    "occurrences": 0,
                    "firstFrame": fa.frame.get("frameIndex"),
                    "firstAt": fa.frame.get("timestamp"),
                    "lastFrame": fa.frame.get("frameIndex"),
                    "lastAt": fa.frame.get("timestamp"),
                    "priority": event.get("priority"),
                    "correlationIds": [],
                },
            )
            bucket["occurrences"] += 1
            bucket["lastFrame"] = fa.frame.get("frameIndex")
            bucket["lastAt"] = fa.frame.get("timestamp")
            cid = event.get("correlationId")
            if cid and cid not in bucket["correlationIds"]:
                bucket["correlationIds"].append(cid)
    return {
        "sessionId": result.summary.get("sessionId"),
        "note": (
            "These are CANDIDATES, not incidents. The AI runtime emits events; the rules service "
            "decides which of them constitute an incident. Nothing in this document has been "
            "adjudicated by a rule."
        ),
        "candidates": [grouped[k] for k in sorted(grouped)],
    }


def evidence_doc(result: AnalyzeResult) -> dict:
    """The evidence that **would** be captured for each candidate (AI-5e).

    Evidence registration belongs to G-4 and needs object storage, a custody chain and a retention
    policy — none of which the playground has or should have. What it can do is show the *manifest*:
    which clip window, which frames, which correlation id. That is what makes the evidence path
    demonstrable without pretending a clip was stored.
    """
    fps = float(result.summary.get("sourceFps") or 0) or None
    manifests = []
    for candidate in incidents_doc(result)["candidates"]:
        first, last = candidate["firstFrame"], candidate["lastFrame"]
        manifests.append(
            {
                "eventType": candidate["eventType"],
                "correlationIds": candidate["correlationIds"],
                "clipWindow": {
                    "fromFrame": first,
                    "toFrame": last,
                    "fromSeconds": round(first / fps, 3) if fps and first is not None else None,
                    "toSeconds": round(last / fps, 3) if fps and last is not None else None,
                },
                "frames": (last - first + 1) if (first is not None and last is not None) else 0,
                "source": result.summary.get("sourceVideo"),
                "status": "not-registered",
            }
        )
    return {
        "sessionId": result.summary.get("sessionId"),
        "note": (
            "Evidence is registered by the evidence service (G-4) with a custody chain and a "
            "retention policy. The playground records what WOULD be captured; status is always "
            "'not-registered'."
        ),
        "manifests": manifests,
    }


def performance_doc(result: AnalyzeResult) -> dict:
    """Stage timings turned into a cost breakdown (AI-5e).

    Raw milliseconds per stage are hard to act on; the share of total time is not. This is the
    document that tells you the honest answer to "why is this slow", which is almost always decode or
    inference and almost never the stage someone was about to optimise.
    """
    timings = dict(result.summary.get("stageTimingsMs") or {})
    total = sum(float(v or 0) for v in timings.values())
    frames = int(result.summary.get("framesSampled") or len(result.frames) or 0)
    stages = [
        {
            "stage": name.replace("Ms", ""),
            "totalMs": round(float(value or 0), 3),
            "perFrameMs": round(float(value or 0) / frames, 4) if frames else 0.0,
            "sharePercent": round(100.0 * float(value or 0) / total, 2) if total else 0.0,
        }
        for name, value in sorted(timings.items(), key=lambda kv: -float(kv[1] or 0))
    ]
    return {
        "sessionId": result.summary.get("sessionId"),
        "framesSampled": frames,
        "totalMs": round(total, 3),
        "perFrameMs": round(total / frames, 4) if frames else 0.0,
        "effectiveFps": round(1000.0 * frames / total, 3) if total else 0.0,
        "stages": stages,
        "dominantStage": stages[0]["stage"] if stages else None,
        "note": (
            "Wall-clock timings from a single run. For a comparable, budgeted measurement use the "
            "AI-5a benchmark harness — these numbers are for finding the hot stage, not for "
            "governance."
        ),
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


#: Artifact key → filename. JSON documents only; `summary` and `report` are written separately.
_JSON_ARTIFACTS = {
    "detections": "detections.json",
    "events": "events.json",
    "metrics": "metrics.json",
    "tracks": "tracks.json",
    "behaviors": "behaviors_timeline.json",
    # AI-5e workbench surfaces (Architect priority 2).
    "timeline": "timeline.json",
    "incidents": "incidents.json",
    "evidence": "evidence.json",
    "performance": "performance.json",
}


def write_artifacts(out_dir: str, result: AnalyzeResult, *, benchmark: Optional[dict] = None) -> dict:
    """Write the `playground-output/` artifact set into `out_dir`. Returns paths.
    The CLI adds original.mp4 + annotated.mp4 on the real path, and `report.html` ties them together."""
    os.makedirs(out_dir, exist_ok=True)
    docs = result_to_documents(result)
    paths = {key: os.path.join(out_dir, name) for key, name in _JSON_ARTIFACTS.items()}
    paths["summary"] = os.path.join(out_dir, "summary.txt")
    for key in _JSON_ARTIFACTS:
        with open(paths[key], "w", encoding="utf-8") as fh:
            json.dump(docs[key], fh, indent=2, sort_keys=True)
            fh.write("\n")
    with open(paths["summary"], "w", encoding="utf-8") as fh:
        fh.write(docs["summary"])
    if benchmark is not None:
        paths["benchmark"] = os.path.join(out_dir, "benchmark.json")
        with open(paths["benchmark"], "w", encoding="utf-8") as fh:
            json.dump(benchmark, fh, indent=2, sort_keys=True)
            fh.write("\n")
    paths["report"] = os.path.join(out_dir, "report.html")
    with open(paths["report"], "w", encoding="utf-8") as fh:
        fh.write(render_report(result, docs, benchmark=benchmark))
    return paths


def render_report(
    result: AnalyzeResult, docs: Optional[dict] = None, *, benchmark: Optional[dict] = None
) -> str:
    """A single self-contained `report.html` for the run (AI-5e).

    **Why HTML and not another JSON file.** The playground is meant to be the demonstration
    environment, and the artifact set is now eleven files — nobody demonstrates a directory. This page
    puts the annotated video next to the timeline that explains it, which is the one view that makes
    the platform legible to someone who is not going to read `behaviors_timeline.json`.

    No CDN, no framework, no build step: it opens from the filesystem on a laptop with no network,
    which is exactly the situation a customer demonstration tends to be in. The videos are referenced
    by relative path so the directory stays portable as a whole.
    """
    d = docs or result_to_documents(result)
    s = result.summary
    perf = d["performance"]
    timeline = d["timeline"]
    rows = "".join(
        f"<tr class='t-{e['tier']}'><td>{e.get('frameIndex')}</td><td>{_esc(str(e.get('at') or ''))}</td>"
        f"<td>{e['tier']}</td><td>{_esc(str(e.get('label') or ''))}</td></tr>"
        for e in timeline["entries"][:2000]
    )
    stages = "".join(
        f"<tr><td>{_esc(st['stage'])}</td><td>{st['totalMs']:.1f}</td>"
        f"<td>{st['perFrameMs']:.3f}</td><td>{st['sharePercent']:.1f}%</td></tr>"
        for st in perf["stages"]
    )
    candidates = "".join(
        f"<tr><td>{_esc(c['eventType'])}</td><td>{c['occurrences']}</td>"
        f"<td>{c['firstFrame']}–{c['lastFrame']}</td></tr>"
        for c in d["incidents"]["candidates"]
    ) or "<tr><td colspan='3'>none</td></tr>"
    bench = ""
    if benchmark:
        kpis = benchmark.get("kpis") or {}
        bench = (
            "<h2>Benchmark</h2><div class='kv'>"
            + "".join(f"<div><b>{_esc(k)}</b><span>{_esc(str(v))}</span></div>" for k, v in kpis.items())
            + "</div>"
        )
    return _REPORT_HTML.format(
        title=_esc(str(s.get("sourceVideo") or "AI Playground")),
        source=_esc(str(s.get("sourceVideo") or "synthetic")),
        session=_esc(str(s.get("sessionId") or "")),
        model=_esc(str((s.get("model") or {}).get("name") or "")),
        engine=_esc(str(s.get("engine") or "")),
        frames=s.get("framesSampled") or 0,
        detections=s.get("detections") or 0,
        events=s.get("events") or 0,
        behaviors=s.get("behaviors") or 0,
        composites=s.get("composites") or 0,
        fps=perf["effectiveFps"],
        counts=" · ".join(f"{k} {v}" for k, v in timeline["counts"].items()),
        rows=rows,
        stages=stages,
        candidates=candidates,
        benchmark=bench,
        summary=_esc(d["summary"]),
    )


_REPORT_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Playground — {title}</title>
<style>
:root{{color-scheme:light dark}}
body{{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;
 max-width:1100px;margin-inline:auto}}
h1{{font-size:20px;margin:0 0 4px}} h2{{font-size:15px;margin:28px 0 8px;text-transform:uppercase;
 letter-spacing:.06em;opacity:.6}}
.meta{{opacity:.65;margin-bottom:20px}}
.kv{{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}}
.kv div{{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;padding:10px 12px}}
.kv b{{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.55}}
.kv span{{font-size:20px;font-variant-numeric:tabular-nums}}
video{{width:100%;max-width:100%;border-radius:8px;background:#000}}
.videos{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}}
.scroll{{overflow-x:auto;max-height:520px;overflow-y:auto;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:8px}}
table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{text-align:left;padding:5px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);white-space:nowrap}}
thead th{{position:sticky;top:0;background:Canvas;font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.6}}
tr.t-event td{{font-weight:600}} tr.t-behavior td,tr.t-composite td{{color:#b26a00}}
tr.t-detection td{{opacity:.6}}
pre{{white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
 border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:8px;padding:12px;overflow-x:auto}}
</style></head><body>
<h1>AI Playground — {title}</h1>
<div class="meta">{source} · session {session} · model {model} ({engine})</div>

<div class="kv">
 <div><b>frames</b><span>{frames}</span></div>
 <div><b>detections</b><span>{detections}</span></div>
 <div><b>behaviors</b><span>{behaviors}</span></div>
 <div><b>composites</b><span>{composites}</span></div>
 <div><b>events</b><span>{events}</span></div>
 <div><b>effective fps</b><span>{fps}</span></div>
</div>

<h2>Video</h2>
<div class="videos">
 <video controls preload="metadata" src="original.mp4"></video>
 <video controls preload="metadata" src="annotated.mp4"></video>
</div>

<h2>Timeline — {counts}</h2>
<div class="scroll"><table><thead><tr><th>frame</th><th>at</th><th>tier</th><th>what happened</th></tr></thead>
<tbody>{rows}</tbody></table></div>

<h2>Incident candidates</h2>
<table><thead><tr><th>event type</th><th>occurrences</th><th>frames</th></tr></thead>
<tbody>{candidates}</tbody></table>
<p class="meta">Candidates only. The rules service decides what is an incident; the runtime never does.</p>

<h2>Performance</h2>
<table><thead><tr><th>stage</th><th>total ms</th><th>per frame</th><th>share</th></tr></thead>
<tbody>{stages}</tbody></table>
{benchmark}

<h2>Summary</h2>
<pre>{summary}</pre>
</body></html>
"""


def _esc(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


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
