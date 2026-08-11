"""Tier-1 ground truth: what a human says is in the frame — P3.2c.

    annotation file ──▶ Annotations ──▶ detection_scoring.score()  ──▶ precision / recall / IoU
                                   └──▶ align(corpus case)         ──▶ ⛔ refuse if it drifted

⛔ **This is the only thing in the platform allowed to authorise an accuracy metric.** Everything the
benchmark reports today is observational — a detection count, a latency, a track total — because
nobody has ever written down what was actually in the frame. Precision and recall are not harder
versions of those numbers; they are a different kind of claim, and they require this file to exist.

### ⭐ Provenance-bound, not merely versioned

An annotation set names the clip **by digest**, not by filename. ⚠️ Filenames get reused: re-export a
clip from a phone, keep the name, and every box silently describes different pixels — producing a
precision score that is precise, reproducible and about nothing. `align()` refuses that, and it is
the check that makes the rest of the file trustworthy.

### ⚠️ What Tier-1 deliberately is not

No masks, no attributes, no re-identification across clips. Identity is **stable within one clip**
and means nothing outside it — `gtId: 1` in two clips is two different people. Cross-clip identity is
a re-identification claim, and ADR-0055 governs those.

⭐ `keypoints` is accepted now and scored later. The field exists so the annotation format does not
have to change on the day pose validation begins — but nothing here scores a pose, and declaring
keypoints authorises no pose model.

Stdlib-only, pure, deterministic. No video, no model, no I/O beyond reading its own file.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Tuple

#: The annotation format's own version. ⚠️ Bumped when the *meaning* of a field changes, never for a
#: new optional one — a scorer must be able to tell "this file predates that rule" from "this file
#: disagrees with it".
SCHEMA_VERSION = "tier1-2026-08-11"

#: ⛔ Visibility is not confidence, and both are needed. A box a human is certain is *mostly hidden*
#: is a different fact from one they were unsure how to draw. The distinction is what makes "recall
#: on occluded subjects" a separate question from "recall".
VISIBILITY = ("fully-visible", "partially-occluded", "heavily-occluded")


class AnnotationError(ValueError):
    """Ground truth that cannot be trusted as ground truth.

    ⛔ Raised rather than warned, and never softened into a skipped frame. A scorer that quietly
    dropped an unreadable annotation would compute recall over the subset a human happened to get
    right, which reads high precisely where the footage is hardest.
    """


@dataclass(frozen=True)
class Box:
    """One annotated object. ⚠️ `[x, y, w, h]` normalized to `[0,1]` — the runtime's own convention,
    so a comparison needs no transform that could itself be wrong."""

    label: str
    bbox: Tuple[float, float, float, float]
    #: Stable **within this clip only**. Two boxes sharing a `gt_id` are the same subject across
    #: frames; the same integer in another clip is a different person.
    gt_id: Optional[int] = None
    visibility: str = "fully-visible"
    #: ⭐ Accepted, never scored here. Present so pose validation needs no format change.
    keypoints: Tuple[Mapping[str, object], ...] = ()

    def __post_init__(self) -> None:
        if not self.label:
            raise AnnotationError("a box carries no label")
        if len(self.bbox) != 4:
            raise AnnotationError(f"box '{self.label}' has {len(self.bbox)} bbox values, expected 4")
        x, y, w, h = self.bbox
        if w <= 0 or h <= 0:
            raise AnnotationError(
                f"box '{self.label}' has non-positive size {w}×{h}. ⛔ A zero-area box matches "
                f"nothing at any IoU threshold and would count as a permanent miss."
            )
        for name, value in (("x", x), ("y", y), ("w", w), ("h", h)):
            if not (0.0 <= value <= 1.0):
                raise AnnotationError(
                    f"box '{self.label}' has {name}={value}, outside [0,1]. ⚠️ Annotations are "
                    f"normalized like the runtime's own boxes; pixel coordinates here would score "
                    f"every frame as a total miss."
                )
        if self.visibility not in VISIBILITY:
            raise AnnotationError(
                f"box '{self.label}' declares visibility '{self.visibility}', expected one of {VISIBILITY}"
            )


@dataclass(frozen=True)
class AnnotatedFrame:
    """Every object a human found in one sampled frame — ⛔ including none.

    ⚠️ An empty frame is a *positive statement* that nothing was there, and it is what makes false
    positives measurable. Omitting empty frames instead would make a detector that hallucinates in
    quiet moments look perfect.
    """

    frame_index: int
    boxes: Tuple[Box, ...] = ()
    at_seconds: Optional[float] = None

    def __post_init__(self) -> None:
        if self.frame_index < 0:
            raise AnnotationError(f"frame index {self.frame_index} is negative")


@dataclass(frozen=True)
class Annotations:
    """One clip's Tier-1 ground truth, bound to the bytes it describes."""

    schema_version: str
    case_id: str
    #: ⛔ The digest of the clip these boxes describe — the binding that makes them evidence.
    #: `None` only for constructed fixtures, which git binds instead; real footage must carry one.
    clip_sha256: Optional[str]
    #: The rate the annotator worked at. ⚠️ Must match the benchmark's sampling rate, or box 30
    #: describes a different instant than detection 30.
    annotated_fps: float
    frames: Tuple[AnnotatedFrame, ...]
    annotator: str = ""
    note: str = ""

    @property
    def frame_indices(self) -> Tuple[int, ...]:
        return tuple(f.frame_index for f in self.frames)

    @property
    def labels(self) -> Tuple[str, ...]:
        return tuple(sorted({b.label for f in self.frames for b in f.boxes}))

    @property
    def box_count(self) -> int:
        return sum(len(f.boxes) for f in self.frames)

    def by_frame(self) -> Dict[int, AnnotatedFrame]:
        return {f.frame_index: f for f in self.frames}

    def identities(self) -> Dict[int, int]:
        """`gt_id` → how many frames it appears in."""
        counts: Dict[int, int] = {}
        for frame in self.frames:
            for box in frame.boxes:
                if box.gt_id is not None:
                    counts[box.gt_id] = counts.get(box.gt_id, 0) + 1
        return counts


def load(path: str) -> Annotations:
    """Read and validate one annotation file. ⛔ Every defect raises; none is skipped."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        raise AnnotationError(f"cannot read annotations '{path}': {exc}") from exc
    return parse(raw, source=path)


def parse(raw: Mapping[str, object], *, source: str = "<memory>") -> Annotations:
    version = str(raw.get("schemaVersion") or "").strip()
    if not version:
        raise AnnotationError(
            f"annotations '{source}' declare no schemaVersion. ⛔ A scorer cannot tell a file that "
            f"predates a rule from one that disagrees with it."
        )
    # ⛔ **One rule, applied at both layers.** The corpus *forbids* constructed fixtures a `sha256`
    # (git binds file to content there) and *requires* one for real footage. Requiring it here
    # unconditionally made authored ground truth unparseable, so the exemption in `align()` was
    # unreachable — found by running the first end-to-end scoring job.
    #
    # ⚠️ Explicit `null` means "not digest-bound" and is permitted. A *malformed* value is still
    # refused: that is somebody who meant to bind and got it wrong.
    raw_digest = raw.get("clipSha256", None)
    if raw_digest is None:
        digest = None
    else:
        digest = str(raw_digest).strip().lower()
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise AnnotationError(
                f"annotations '{source}' declare clipSha256 '{raw_digest}', which is not a "
                f"64-character hex digest. ⛔ Without it these boxes describe no particular pixels."
            )
    case_id = str(raw.get("caseId") or "").strip()
    if not case_id:
        raise AnnotationError(f"annotations '{source}' name no caseId")
    try:
        fps = float(raw.get("annotatedFps") or 0.0)
    except (TypeError, ValueError):
        fps = 0.0
    if fps <= 0:
        raise AnnotationError(
            f"annotations '{source}' declare annotatedFps '{raw.get('annotatedFps')}'. ⚠️ Without "
            f"the rate the annotator worked at, a frame index cannot be matched to an instant."
        )

    frames: List[AnnotatedFrame] = []
    seen: set = set()
    entries = raw.get("frames")
    if not isinstance(entries, list) or not entries:
        raise AnnotationError(f"annotations '{source}' contain no frames")
    for entry in entries:
        index = entry.get("frameIndex")
        if not isinstance(index, int):
            raise AnnotationError(f"annotations '{source}' contain a frame with no integer frameIndex")
        if index in seen:
            # ⛔ Two records for one frame is not a merge question: which one is the truth is
            # unknowable, and picking either would silently halve or double that frame's recall.
            raise AnnotationError(f"annotations '{source}' declare frame {index} twice")
        seen.add(index)
        boxes = tuple(_box(b, source=source, frame=index) for b in entry.get("boxes", []))
        frames.append(
            AnnotatedFrame(
                frame_index=index,
                boxes=boxes,
                at_seconds=_optional_float(entry.get("atSeconds")),
            )
        )

    return Annotations(
        schema_version=version,
        case_id=case_id,
        clip_sha256=digest,
        annotated_fps=fps,
        frames=tuple(sorted(frames, key=lambda f: f.frame_index)),
        annotator=str(raw.get("annotator") or ""),
        note=str(raw.get("note") or ""),
    )


def _box(raw: Mapping[str, object], *, source: str, frame: int) -> Box:
    bbox = raw.get("bbox")
    if not isinstance(bbox, (list, tuple)):
        raise AnnotationError(f"annotations '{source}' frame {frame}: a box has no bbox")
    gt_id = raw.get("gtId")
    if gt_id is not None and not isinstance(gt_id, int):
        raise AnnotationError(f"annotations '{source}' frame {frame}: gtId '{gt_id}' is not an integer")
    keypoints = raw.get("keypoints") or ()
    return Box(
        label=str(raw.get("label") or ""),
        bbox=tuple(float(v) for v in bbox),  # type: ignore[arg-type]
        gt_id=gt_id,
        visibility=str(raw.get("visibility") or "fully-visible"),
        keypoints=tuple(keypoints),  # type: ignore[arg-type]
    )


def _optional_float(value: object) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


# --- the checks that decide whether these boxes may score anything ------------------------------


@dataclass(frozen=True)
class AlignmentReport:
    """Whether an annotation set may be used against a particular clip and run."""

    problems: Tuple[str, ...] = ()

    @property
    def aligned(self) -> bool:
        return not self.problems


def align(
    annotations: Annotations,
    *,
    case_id: str,
    clip_sha256: Optional[str],
    sampled_fps: Optional[float] = None,
    analysed_frames: Optional[int] = None,
) -> AlignmentReport:
    """⛔ **The gate.** Ground truth scores a run only when it provably describes the same pixels,
    the same instants and the same frames.

    Each check exists because its absence produces a *plausible wrong number* rather than an error:

    - **digest** — a re-exported clip keeps its name; boxes then describe different pixels and the
      precision score is precise and meaningless.
    - **rate** — annotate at 2 fps, sample at 5, and box 30 is compared against a detection 9 seconds
      away. Every frame reads as a miss and a false positive at once.
    - **range** — annotations beyond the frames the run produced are not misses; they are frames
      nobody analysed, and counting them as misses reports recall against footage never processed.
    """
    problems: List[str] = []
    if annotations.case_id != case_id:
        problems.append(f"annotations name case '{annotations.case_id}', run is '{case_id}'")
    # ⚠️ `None` means the case declares no digest, which the corpus permits **only** for constructed
    # fixtures — those live in the repository, where git already binds the file to its content. Real
    # footage lives outside git and is required to carry a digest, so `None` cannot reach here for
    # it. ⛔ An empty string is *not* the same thing: that is a case that should have had one.
    if clip_sha256 is not None and annotations.clip_sha256 is None:
        # ⛔ The case is digest-bound (real footage) and the annotations are not. Scoring here would
        # silently drop the only check that ties these boxes to those pixels.
        problems.append(
            "the case is bound by sha256 but these annotations declare none — real footage must be "
            "digest-bound, or a re-exported clip scores against boxes drawn on different pixels"
        )
    elif clip_sha256 is None and annotations.clip_sha256 is not None:
        problems.append(
            f"annotations declare sha256:{annotations.clip_sha256[:12]}… but the case declares none "
            f"— a constructed fixture is bound by git, so this pairing is a mistake somewhere"
        )
    elif clip_sha256 is not None and annotations.clip_sha256 != clip_sha256.lower():
        problems.append(
            f"annotations describe sha256:{annotations.clip_sha256[:12]}…, "
            f"clip is sha256:{clip_sha256[:12]}… — these boxes describe different pixels"
        )
    if sampled_fps is not None and abs(annotations.annotated_fps - sampled_fps) > 1e-6:
        problems.append(
            f"annotated at {annotations.annotated_fps} fps, run sampled at {sampled_fps} fps — "
            f"frame indices refer to different instants"
        )
    if analysed_frames is not None:
        beyond = [i for i in annotations.frame_indices if i >= analysed_frames]
        if beyond:
            problems.append(
                f"{len(beyond)} annotated frame(s) beyond the {analysed_frames} the run produced "
                f"(first: {beyond[0]}) — these are frames nobody analysed, not misses"
            )
    return AlignmentReport(problems=tuple(problems))


def identity_problems(annotations: Annotations) -> Tuple[str, ...]:
    """Ground-truth identity defects that would corrupt a tracking comparison.

    ⚠️ Reported rather than raised: a clip can be perfectly good for *detection* scoring while its
    identities are unusable, and refusing to load it would throw away the usable half.
    """
    problems: List[str] = []
    for frame in annotations.frames:
        seen: Dict[int, int] = {}
        for box in frame.boxes:
            if box.gt_id is None:
                continue
            seen[box.gt_id] = seen.get(box.gt_id, 0) + 1
        for gt_id, count in seen.items():
            if count > 1:
                # ⛔ One subject cannot be in two places in one frame. Left unchecked this inflates
                # every identity metric computed from the file.
                problems.append(f"frame {frame.frame_index}: gtId {gt_id} appears {count} times")
    labels: Dict[int, set] = {}
    for frame in annotations.frames:
        for box in frame.boxes:
            if box.gt_id is not None:
                labels.setdefault(box.gt_id, set()).add(box.label)
    for gt_id, names in sorted(labels.items()):
        if len(names) > 1:
            problems.append(f"gtId {gt_id} changes label between {sorted(names)}")
    return tuple(problems)
