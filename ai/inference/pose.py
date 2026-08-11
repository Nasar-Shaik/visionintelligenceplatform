"""Top-down pose: a person box in, COCO-17 keypoints out — P3.3b.

    detector ──▶ person bbox ──▶ crop_for() ──▶ preprocess() ──▶ [RTMPose] ──▶ decode()
                                                                                  │
                                          perception.Keypoint[] ◀─────────────────┘

⛔ **Pose never decides whether a person is present.** RTMPose is top-down: it is *told* a person is
in the crop and answers accordingly. Run on an empty room it returns all 17 joints at confidence
0.21–0.57 — and in the P3.3a measurement its hallucinated left shoulder (0.489) was **more confident
than a real person's** (0.383). Person presence is the detector's answer, always; this module is only
ever handed a box the detector produced. That is what makes "empty frame → no skeleton" structural
rather than a threshold someone has to tune.

### ⚠️ Three coordinate spaces, and every bug here lives between two of them

    frame (pixels)  ──crop──▶  crop (pixels)  ──letterbox──▶  model input 192×256  ──SimCC──▶ bins
                    ◀──────────────────────────────────────────────────────────────────────────

`decode()` walks that chain backwards. It is pure arithmetic over numbers the caller supplies, so it
is testable without a model, an image, or onnxruntime — which is why the transform lives here rather
than inside the adapter.

### ⛔ `visible` is a RUNTIME statement and not the annotator's

`perception.Keypoint` carries `confidence` and `visible`, and the pose seam exists because those are
different facts. The model supplies only the first: **there is no visibility output in the graph.**
So `visible` here means exactly one thing, and it is written down so no consumer can drift:

> **visible = the model localised this joint above `VISIBILITY_THRESHOLD`, and the argmax did not
> saturate at the crop boundary.**

⚠️ That is *not* "the joint is not occluded". A human annotator's `visible` answers whether the joint
can be seen in the pixels; this one answers whether the model found it. Tier-1 ground truth keeps its
own meaning (`annotations.GroundTruthKeypoint`), and nothing here overwrites it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

from perception import COCO_17, DEFAULT_SKELETON, Keypoint

#: Model input, width × height. Read off the exported graph (`image [1,3,256,192]`), not the paper.
INPUT_W, INPUT_H = 192, 256

#: The catalogue `outputFormat` this module decodes. ⛔ Declared here rather than registered in
#: `adapters/model_formats.py`: that registry maps a format to a `Decoder`, whose contract is
#: `tensors → RawDetection[]`. A pose model produces keypoints for a box the detector already found,
#: so it has no detections to return, and a decoder that returned none would be a lie shaped like an
#: implementation. The catalogue guard checks this name alongside the detector decoders.
OUTPUT_FORMAT = "rtmpose"

#: SimCC bins per pixel. The artifact emits `simcc_x [1,17,384]` and `simcc_y [1,17,512]`;
#: 384/192 == 512/256 == 2.0. ⛔ Verified against the traced graph at load time by `check_outputs`.
SPLIT_RATIO = 2.0

#: ImageNet statistics, in RGB order — the preprocessing RTMPose was trained with.
MEAN = (123.675, 116.28, 103.53)
STD = (58.395, 57.12, 57.375)
PAD_VALUE = 114

#: Below this the joint is reported `visible=False`. ⚠️ A threshold on MODEL CONFIDENCE, nothing more.
VISIBILITY_THRESHOLD = 0.30

#: How close to the last SimCC bin counts as saturated. ⛔ See `_saturated`.
_EDGE_BINS = 1

#: The canonical COCO-17 skeleton edges, by joint name. ⭐ Named rather than indexed so a renderer
#: cannot silently connect the wrong pair when a topology gains joints.
COCO_17_EDGES: Tuple[Tuple[str, str], ...] = (
    ("left_ankle", "left_knee"), ("left_knee", "left_hip"),
    ("right_ankle", "right_knee"), ("right_knee", "right_hip"),
    ("left_hip", "right_hip"), ("left_shoulder", "left_hip"), ("right_shoulder", "right_hip"),
    ("left_shoulder", "right_shoulder"),
    ("left_shoulder", "left_elbow"), ("right_shoulder", "right_elbow"),
    ("left_elbow", "left_wrist"), ("right_elbow", "right_wrist"),
    ("left_eye", "right_eye"), ("nose", "left_eye"), ("nose", "right_eye"),
    ("left_eye", "left_ear"), ("right_eye", "right_ear"),
    ("left_ear", "left_shoulder"), ("right_ear", "right_shoulder"),
)


class PoseError(ValueError):
    """A pose output that cannot be trusted as a pose output."""


@dataclass(frozen=True)
class CropBox:
    """A person box in frame pixels, plus the letterbox that maps it into the model input.

    ⚠️ `scale`, `pad_x` and `pad_y` are stored rather than recomputed: `decode()` must undo exactly
    the transform `preprocess()` applied, and a second derivation is a second chance to disagree.
    """

    x: int
    y: int
    w: int
    h: int
    scale: float
    pad_x: float
    pad_y: float


def crop_for(bbox: Sequence[float], frame_w: int, frame_h: int, *, margin: float = 0.10) -> CropBox:
    """A person's normalized `[x, y, w, h]` → a pixel crop and its letterbox transform.

    ⭐ **The margin exists because top-down pose needs the whole body in the crop.** A detector box
    is tight; wrists and ankles sit right at its edge, and a joint on the boundary decodes to the
    boundary. ⚠️ The crop is clamped to the frame — a person at the edge simply gets less context,
    which is honest, rather than a padded region the model reads as body.
    """
    if frame_w <= 0 or frame_h <= 0:
        raise PoseError(f"frame is {frame_w}×{frame_h}")
    bx, by, bw, bh = (float(v) for v in bbox)
    cx, cy = (bx + bw / 2) * frame_w, (by + bh / 2) * frame_h
    pw, ph = bw * frame_w * (1 + margin), bh * frame_h * (1 + margin)
    x0 = max(0, int(round(cx - pw / 2)))
    y0 = max(0, int(round(cy - ph / 2)))
    x1 = min(frame_w, int(round(cx + pw / 2)))
    y1 = min(frame_h, int(round(cy + ph / 2)))
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        raise PoseError(f"person box {tuple(bbox)} produced an empty crop in a {frame_w}×{frame_h} frame")
    scale = min(INPUT_W / w, INPUT_H / h)
    pad_x = (INPUT_W - w * scale) / 2
    pad_y = (INPUT_H - h * scale) / 2
    return CropBox(x=x0, y=y0, w=w, h=h, scale=scale, pad_x=pad_x, pad_y=pad_y)


def check_outputs(simcc_x_bins: int, simcc_y_bins: int) -> None:
    """⛔ Refuse a graph whose SimCC widths are not the ones this decode was written for.

    A different split ratio decodes every joint to the wrong place *proportionally* — a skeleton that
    looks like a skeleton, slightly wrong, everywhere. That reads as a bad model rather than a bad
    assumption, which is the most expensive kind of defect this file can ship.
    """
    want_x, want_y = int(INPUT_W * SPLIT_RATIO), int(INPUT_H * SPLIT_RATIO)
    if simcc_x_bins != want_x or simcc_y_bins != want_y:
        raise PoseError(
            f"SimCC widths are ({simcc_x_bins}, {simcc_y_bins}); this decode requires "
            f"({want_x}, {want_y}) — i.e. split ratio {SPLIT_RATIO} at {INPUT_W}×{INPUT_H}"
        )


def _saturated(index: int, bins: int) -> bool:
    """⛔ Did the argmax land on the first or last bin?

    RTMPose has no "not found" output: asked for a joint outside the crop it returns the extreme bin,
    which decodes to a *plausible coordinate on the crop edge*. Measured on real footage — a chest-up
    framing put all eight lower-body joints at exactly y=0.958, the crop's bottom edge, at confidence
    0.05–0.34. A consumer reading position without confidence gets a real-looking lie, so the
    saturation is carried explicitly rather than left to a threshold to catch by accident.
    """
    return index <= _EDGE_BINS - 1 or index >= bins - _EDGE_BINS


def decode(
    simcc_x: Sequence[Sequence[float]],
    simcc_y: Sequence[Sequence[float]],
    crop: CropBox,
    frame_w: int,
    frame_h: int,
    *,
    threshold: float = VISIBILITY_THRESHOLD,
) -> List[Keypoint]:
    """SimCC logits → `perception.Keypoint`s in normalized frame coordinates.

    `simcc_x[k]` / `simcc_y[k]` are the 1-D distributions for joint `k`. Returns exactly 17 keypoints
    in `COCO_17` order — ⚠️ never a short list, because "joint 9 is missing" and "the list happens to
    be shorter" are different facts and only one of them survives a index-based consumer.
    """
    if len(simcc_x) != len(COCO_17) or len(simcc_y) != len(COCO_17):
        raise PoseError(
            f"expected {len(COCO_17)} joints, got {len(simcc_x)}/{len(simcc_y)} — the artifact does "
            f"not emit the '{DEFAULT_SKELETON}' topology this runtime decodes"
        )
    check_outputs(len(simcc_x[0]), len(simcc_y[0]))

    out: List[Keypoint] = []
    for k, name in enumerate(COCO_17):
        xs, ys = simcc_x[k], simcc_y[k]
        ix = max(range(len(xs)), key=xs.__getitem__)
        iy = max(range(len(ys)), key=ys.__getitem__)
        # ⚠️ The joint's confidence is the weaker of its two axes: a joint localised sharply in x and
        # vaguely in y is not a confident joint, and taking the max would say it was.
        confidence = float(min(xs[ix], ys[iy]))

        # bins → model-input pixels → crop pixels → frame pixels → normalized
        px = (ix / SPLIT_RATIO - crop.pad_x) / crop.scale
        py = (iy / SPLIT_RATIO - crop.pad_y) / crop.scale
        fx = (crop.x + px) / frame_w
        fy = (crop.y + py) / frame_h

        edge = _saturated(ix, len(xs)) or _saturated(iy, len(ys))
        inside = 0.0 <= fx <= 1.0 and 0.0 <= fy <= 1.0
        # ⛔ Not clamped. A coordinate outside the frame is reported where it was computed and marked
        # not-visible; folding it back to 0.0 or 1.0 would manufacture a keypoint on the frame border
        # that no consumer could distinguish from a real one.
        visible = bool(confidence >= threshold and not edge and inside)
        out.append(Keypoint(name=name, x=round(fx, 6), y=round(fy, 6),
                            confidence=round(confidence, 6), visible=visible))
    return out


def summarise(keypoints: Sequence[Keypoint]) -> dict:
    """Observational counts for the benchmark and the runtime log.

    ⛔ Nothing here is an accuracy measure. There is no human keypoint ground truth, so "how many
    joints the model reported" is the honest question; "how many it got right" is not answerable.
    """
    visible = [k for k in keypoints if k.visible]
    confs = [k.confidence for k in keypoints]
    return {
        "joints": len(keypoints),
        "visible": len(visible),
        "belowThreshold": sum(1 for k in keypoints if k.confidence < VISIBILITY_THRESHOLD),
        "meanConfidence": round(sum(confs) / len(confs), 6) if confs else 0.0,
        "skeleton": DEFAULT_SKELETON,
    }


def to_attribute(keypoints: Sequence[Keypoint], *, model_id: str, artifact_sha256: str) -> dict:
    """The `Detection.attributes["pose"]` payload — ⭐ self-describing, so a reader never has to guess.

    ⚠️ Carries the artifact digest with the observation. A keypoint is only interpretable against the
    model that produced it, and "which weights was this?" is exactly the question asked six months
    later when a number looks wrong.
    """
    return {
        "skeleton": DEFAULT_SKELETON,
        "model": model_id,
        "artifactSha256": artifact_sha256,
        "visibleMeaning": "model-localized above threshold; NOT a claim about physical occlusion",
        "threshold": VISIBILITY_THRESHOLD,
        "keypoints": [k.to_dict() for k in keypoints],
    }
