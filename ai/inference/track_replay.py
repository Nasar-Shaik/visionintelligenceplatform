"""Deterministic tracking replay (P-8 Phase 4 freeze).

### What this records, and why that is the right cut

The tracker's entire input is **(frame context, detections)**. Nothing else reaches it: not the
image, not the model, not the preprocessing. So recording exactly that pair, in order, captures
everything needed to reproduce a tracking run *bit for bit* — and replaying it needs no camera, no
RTSP server, no model and no GPU.

⚠️ **This replays TRACKING, never PERCEPTION.** The detections in a recording are the ones the model
produced on the day; re-running them proves the association, lifecycle and identity logic still
behaves identically. It proves nothing about whether the model would still find that person. A
recording that goes green after a model change means "tracking is unchanged", not "the platform
still works" — that is the deployment verification's job, against real video.

### Why it is off unless asked for

A recording contains bounding boxes, camera ids and a tenant id. That is tenant data, so it is never
on by default, never written outside the path the operator names, and never enabled by a code path
that an ordinary deployment takes. It exists for three jobs — debugging a bad night, regression
testing an engine change, and verifying a benchmark scenario without live video — and each of them
is somebody deciding to switch it on.

### The format

JSONL, one frame per line, with a single header line first. Line-oriented on purpose: a run killed
half way through still replays up to the point it died, which is exactly the run you most want to
look at.

Stdlib-only, deterministic.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Dict, Iterable, Iterator, List, Optional, Sequence

from contracts import Detection, FrameContext

#: Bumped when a reader would misinterpret an older file. Replay refuses a version it does not know
#: rather than guessing — a silently misread recording produces a confident wrong diff.
REPLAY_FORMAT_VERSION = 1

#: Frames one recording will hold. A recorder left switched on must not fill a disk; it stops and
#: says so instead, because a truncated recording that claims to be complete is worse than a short one.
MAX_FRAMES = 200_000


class TrackingRecorder:
    """Append-only recorder of the tracker's inputs and the identities it assigned.

    Thread-safe: the runtime is a `ThreadingHTTPServer` and this is called from the update path.
    """

    def __init__(self, path: str, *, max_frames: int = MAX_FRAMES, engine: Optional[dict] = None) -> None:
        self._path = path
        self._max_frames = max_frames
        self._lock = threading.Lock()
        self._frames = 0
        self._stopped = False
        directory = os.path.dirname(os.path.abspath(path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {
                        "kind": "vip.tracking.replay",
                        "formatVersion": REPLAY_FORMAT_VERSION,
                        # ⚠️ The engine settings are part of the recording. Replaying a file against a
                        # differently tuned tracker and calling the difference a regression would be
                        # an experiment with two variables.
                        "engine": engine or {},
                    }
                )
                + "\n"
            )

    @property
    def frames(self) -> int:
        return self._frames

    @property
    def stopped(self) -> bool:
        return self._stopped

    def record(
        self,
        ctx: FrameContext,
        detections: Sequence[Detection],
        stamped: Sequence[Detection],
        frame_index: int,
    ) -> None:
        """One frame: what went in, and which identity each detection came out with."""
        with self._lock:
            if self._stopped:
                return
            if self._frames >= self._max_frames:
                self._stopped = True
                return
            row = {
                "frameIndex": frame_index,
                "tenantId": ctx.tenant_id,
                "cameraId": ctx.camera_id,
                "at": ctx.timestamp,
                "seq": ctx.frame_number,
                "detections": [_detection_row(d) for d in detections],
                # ⚠️ The OUTPUT is recorded too, and that is what makes the file a regression test
                # rather than a log. Replay compares against these; without them a replay can only
                # say "it ran", not "it produced the same identities".
                "trackIds": [d.tracking_id for d in stamped],
            }
            try:
                with open(self._path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row) + "\n")
            except OSError:
                # A recorder must never be the reason inference fails.
                self._stopped = True
                return
            self._frames += 1


def _detection_row(det: Detection) -> dict:
    return {
        "label": det.label,
        "confidence": round(float(det.confidence), 6),
        "bbox": [round(float(v), 6) for v in det.bbox],
        "classId": det.class_id,
    }


def read_recording(path: str) -> tuple:
    """`(header, rows)` from a recording, refusing a format version this build does not know."""
    header: dict = {}
    rows: List[dict] = []
    with open(path, "r", encoding="utf-8") as fh:
        for number, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                # ⚠️ A half-written final line is expected — a recording is usually stopped by
                # killing the runtime. Everything before it is still valid evidence.
                break
            if number == 0 and parsed.get("kind") == "vip.tracking.replay":
                header = parsed
                version = int(header.get("formatVersion") or 0)
                if version != REPLAY_FORMAT_VERSION:
                    raise ValueError(
                        f"recording is format v{version}, this build reads v{REPLAY_FORMAT_VERSION}"
                    )
                continue
            rows.append(parsed)
    return header, rows


def replay(rows: Iterable[dict], tracker) -> List[dict]:
    """Feed a recording back through a tracker. Returns one result row per frame.

    The tracker is passed in rather than constructed here, so a caller can replay the same recording
    against a differently tuned engine deliberately — which is how you find out whether a threshold
    change would have helped the night you are investigating.
    """
    out: List[dict] = []
    for row in rows:
        detections = [
            Detection(
                label=d["label"],
                confidence=float(d["confidence"]),
                bbox=tuple(d["bbox"]),
                class_id=d.get("classId"),
            )
            for d in row.get("detections", [])
        ]
        ctx = FrameContext(
            tenant_id=row["tenantId"],
            camera_id=row["cameraId"],
            image=b"",
            frame_number=row.get("seq") or 0,
            timestamp=row.get("at"),
        )
        stamped = tracker.run(detections, ctx)
        out.append(
            {
                "frameIndex": row.get("frameIndex"),
                "cameraId": row["cameraId"],
                "trackIds": [d.tracking_id for d in stamped],
            }
        )
    return out


def compare(recorded: Sequence[dict], replayed: Sequence[dict]) -> dict:
    """Did the identities come out the same?

    ⚠️ Compares the SHAPE of identity, not the literal ids. Track ids embed a session id, so two runs
    of the same input legitimately produce different strings for the same identity. What must match
    is which detections share an id and which do not — so the ids are canonicalised to their order of
    first appearance before comparison. Comparing the raw strings would fail every single time and
    the check would be quietly worthless.
    """
    differences: List[dict] = []
    left = _canonical(r.get("trackIds", []) for r in recorded)
    right = _canonical(r.get("trackIds", []) for r in replayed)
    for index, (a, b) in enumerate(zip(left, right)):
        if a != b:
            differences.append({"frame": index, "recorded": a, "replayed": b})
    return {
        "frames": min(len(left), len(right)),
        "framesRecorded": len(left),
        "framesReplayed": len(right),
        "identical": not differences and len(left) == len(right),
        "differences": differences[:20],
        "differenceCount": len(differences) + abs(len(left) - len(right)),
    }


def _canonical(frames: Iterable[Sequence[Optional[str]]]) -> List[List[Optional[int]]]:
    """Rewrite ids as 0, 1, 2… in order of first appearance. `None` stays `None`."""
    seen: Dict[str, int] = {}
    out: List[List[Optional[int]]] = []
    for ids in frames:
        row: List[Optional[int]] = []
        for track_id in ids:
            if track_id is None:
                row.append(None)
                continue
            if track_id not in seen:
                seen[track_id] = len(seen)
            row.append(seen[track_id])
        out.append(row)
    return out


def iter_rows(path: str) -> Iterator[dict]:
    """Rows only, for callers that do not need the header."""
    _header, rows = read_recording(path)
    return iter(rows)
