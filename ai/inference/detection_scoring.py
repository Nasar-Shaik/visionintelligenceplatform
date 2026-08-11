"""Detection accuracy against Tier-1 ground truth — P3.2c.

    Annotations + predictions ──▶ score() ──▶ precision · recall · IoU · per class · FP · FN

⛔ **Nothing in this module may run without annotations, and there is no default that lets it.**
`score()` takes an `Annotations` object; there is no path that invents one, no `expected=None`
branch, and no "assume the detector was right" fallback. That is deliberate: the failure this whole
milestone guards against is a plausible accuracy number computed from footage nobody labelled.

### ⭐ The matching rule, stated once

Per frame, per class, greedy by descending prediction confidence: each prediction claims the
unclaimed ground-truth box it overlaps most, if that overlap is at least `iou_threshold`. Claimed
boxes cannot be claimed twice.

⚠️ **Greedy-by-confidence is a choice, not the only one**, and it is the COCO convention. A global
optimal assignment (Hungarian) scores marginally higher for the same detector, which is precisely why
mixing the two across runs would show a "regression" that is really a change of arithmetic. It is
named here so a later reader can tell which was used.

⚠️ Class-aware matching: a `person` box never matches a `backpack` prediction however well they
overlap. A detector that finds the right rectangle with the wrong name has not found the object.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import annotations as ann

#: ⚠️ 0.5 is the COCO convention and is stated in every report, because precision at 0.5 and at 0.75
#: are different numbers and nothing in a bare "precision: 0.82" says which was meant.
DEFAULT_IOU = 0.5


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection over union of two `[x, y, w, h]` boxes. 0.0 when they do not overlap."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    left, right = max(ax, bx), min(ax + aw, bx + bw)
    top, bottom = max(ay, by), min(ay + ah, by + bh)
    if right <= left or bottom <= top:
        return 0.0
    overlap = (right - left) * (bottom - top)
    union = (aw * ah) + (bw * bh) - overlap
    if union <= 0:
        return 0.0
    # ⚠️ Clamped and rounded at the source. Two identical boxes give 1.0000000000000004 in binary
    # floating point, and an IoU above 1.0 is impossible by definition — published in a mean IoU
    # column it reads as a defect in the scorer, which is exactly what it would be.
    return min(1.0, round(overlap / union, 9))


@dataclass(frozen=True)
class Prediction:
    """One detection as the runtime produced it."""

    label: str
    bbox: Tuple[float, float, float, float]
    confidence: float = 1.0


@dataclass(frozen=True)
class ClassScore:
    """What one class's boxes amounted to. ⛔ Every count is a whole number of boxes, never a rate
    dressed as one — the rates are derived here so a reader can check them."""

    label: str
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    iou_sum: float = 0.0

    @property
    def predicted(self) -> int:
        return self.true_positives + self.false_positives

    @property
    def actual(self) -> int:
        return self.true_positives + self.false_negatives

    @property
    def precision(self) -> Optional[float]:
        """⚠️ `None`, never 0.0, when nothing was predicted. "Predicted nothing" and "predicted only
        wrong things" are different failures and averaging them together hides the first."""
        return round(self.true_positives / self.predicted, 6) if self.predicted else None

    @property
    def recall(self) -> Optional[float]:
        """⚠️ `None` when the class does not appear in the ground truth at all — a recall over zero
        real objects is undefined, and reporting 0.0 would penalise a detector for a class nobody
        annotated."""
        return round(self.true_positives / self.actual, 6) if self.actual else None

    @property
    def mean_iou(self) -> Optional[float]:
        """Mean IoU of the **matched** boxes: how tight the hits were, not how many there were."""
        return round(self.iou_sum / self.true_positives, 6) if self.true_positives else None

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "truePositives": self.true_positives,
            "falsePositives": self.false_positives,
            "falseNegatives": self.false_negatives,
            "precision": self.precision,
            "recall": self.recall,
            "meanIou": self.mean_iou,
        }


@dataclass(frozen=True)
class Score:
    """The accuracy of one detector on one annotated clip."""

    case_id: str
    iou_threshold: float
    classes: Tuple[ClassScore, ...]
    frames_scored: int
    #: ⚠️ Frames the run produced that carry no annotation. Not scored, and reported so a reader can
    #: see the denominator — a score over 6 of 60 frames is not a score of the clip.
    frames_unannotated: int = 0

    def _totals(self) -> Tuple[int, int, int, float]:
        tp = sum(c.true_positives for c in self.classes)
        fp = sum(c.false_positives for c in self.classes)
        fn = sum(c.false_negatives for c in self.classes)
        return tp, fp, fn, sum(c.iou_sum for c in self.classes)

    @property
    def precision(self) -> Optional[float]:
        tp, fp, _, _ = self._totals()
        return round(tp / (tp + fp), 6) if (tp + fp) else None

    @property
    def recall(self) -> Optional[float]:
        tp, _, fn, _ = self._totals()
        return round(tp / (tp + fn), 6) if (tp + fn) else None

    @property
    def mean_iou(self) -> Optional[float]:
        tp, _, _, total = self._totals()
        return round(total / tp, 6) if tp else None

    @property
    def f1(self) -> Optional[float]:
        p, r = self.precision, self.recall
        if p is None or r is None or (p + r) == 0:
            return None
        return round(2 * p * r / (p + r), 6)

    def to_dict(self) -> dict:
        tp, fp, fn, _ = self._totals()
        return {
            "caseId": self.case_id,
            "iouThreshold": self.iou_threshold,
            "framesScored": self.frames_scored,
            "framesUnannotated": self.frames_unannotated,
            "truePositives": tp,
            "falsePositives": fp,
            "falseNegatives": fn,
            "precision": self.precision,
            "recall": self.recall,
            "f1": self.f1,
            "meanIou": self.mean_iou,
            "perClass": [c.to_dict() for c in self.classes],
        }


def match_frame(
    truth: Sequence[ann.Box],
    predictions: Sequence[Prediction],
    *,
    iou_threshold: float = DEFAULT_IOU,
) -> Tuple[List[Tuple[int, int, float]], List[int], List[int]]:
    """One frame's matches. Returns `(matches, unmatched_prediction_ids, unmatched_truth_ids)`.

    ⚠️ Indices are into the sequences passed in, so a caller can report *which* box was missed rather
    than only how many — the difference between "recall 0.6" and "it missed the person behind the
    shelf, every time".
    """
    order = sorted(range(len(predictions)), key=lambda i: -predictions[i].confidence)
    claimed: Dict[int, bool] = {}
    matches: List[Tuple[int, int, float]] = []
    unmatched_predictions: List[int] = []
    for p in order:
        prediction = predictions[p]
        best, best_iou = -1, 0.0
        for t, box in enumerate(truth):
            if claimed.get(t) or box.label != prediction.label:
                continue
            overlap = iou(prediction.bbox, box.bbox)
            if overlap > best_iou:
                best, best_iou = t, overlap
        if best >= 0 and best_iou >= iou_threshold:
            claimed[best] = True
            matches.append((p, best, best_iou))
        else:
            unmatched_predictions.append(p)
    unmatched_truth = [t for t in range(len(truth)) if not claimed.get(t)]
    return matches, unmatched_predictions, unmatched_truth


def score(
    truth: ann.Annotations,
    predictions_by_frame: Mapping[int, Sequence[Prediction]],
    *,
    iou_threshold: float = DEFAULT_IOU,
    labels: Optional[Sequence[str]] = None,
) -> Score:
    """⛔ Accuracy for one clip. Requires annotations; there is no path that fabricates them.

    ⚠️ Only annotated frames are scored. A frame the run produced but nobody labelled is **not** a
    frame of zero ground truth — treating it as one would count every correct detection in it as a
    false positive, and a partially annotated clip would read as a catastrophic detector.
    """
    by_frame = truth.by_frame()
    counts: Dict[str, Dict[str, float]] = {}

    def bucket(label: str) -> Dict[str, float]:
        return counts.setdefault(label, {"tp": 0, "fp": 0, "fn": 0, "iou": 0.0})

    for label in labels or ():
        bucket(label)

    scored = 0
    for index, frame in sorted(by_frame.items()):
        preds = list(predictions_by_frame.get(index, ()))
        scored += 1
        matches, missed_predictions, missed_truth = match_frame(
            frame.boxes, preds, iou_threshold=iou_threshold
        )
        for p, t, overlap in matches:
            b = bucket(frame.boxes[t].label)
            b["tp"] += 1
            b["iou"] += overlap
        for p in missed_predictions:
            bucket(preds[p].label)["fp"] += 1
        for t in missed_truth:
            bucket(frame.boxes[t].label)["fn"] += 1

    unannotated = sum(1 for index in predictions_by_frame if index not in by_frame)
    classes = tuple(
        ClassScore(
            label=label,
            true_positives=int(values["tp"]),
            false_positives=int(values["fp"]),
            false_negatives=int(values["fn"]),
            iou_sum=values["iou"],
        )
        for label, values in sorted(counts.items())
    )
    return Score(
        case_id=truth.case_id,
        iou_threshold=iou_threshold,
        classes=classes,
        frames_scored=scored,
        frames_unannotated=unannotated,
    )


def render(scores: Sequence[Tuple[str, Score]]) -> str:
    """The accuracy section of the benchmark report — ⛔ omitted entirely when nothing is annotated."""
    if not scores:
        return ""
    lines = [
        "## Accuracy — measured against Tier-1 ground truth",
        "",
        f"⚠️ IoU threshold **{scores[0][1].iou_threshold}**, class-aware, greedy by descending "
        f"confidence (the COCO convention). Precision at 0.5 and at 0.75 are different numbers.",
        "",
        "| Detector | Case | Frames | TP | FP | FN | Precision | Recall | F1 | Mean IoU |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for model_id, s in scores:
        d = s.to_dict()
        lines.append(
            f"| `{model_id}` | `{s.case_id}` | {s.frames_scored} | {d['truePositives']} | "
            f"{d['falsePositives']} | {d['falseNegatives']} | {_num(s.precision)} | "
            f"{_num(s.recall)} | {_num(s.f1)} | {_num(s.mean_iou)} |"
        )
    lines += ["", "### Per class", "", "| Detector | Case | Class | TP | FP | FN | Precision | Recall | Mean IoU |",
              "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for model_id, s in scores:
        for c in s.classes:
            lines.append(
                f"| `{model_id}` | `{s.case_id}` | `{c.label}` | {c.true_positives} | "
                f"{c.false_positives} | {c.false_negatives} | {_num(c.precision)} | "
                f"{_num(c.recall)} | {_num(c.mean_iou)} |"
            )
    lines += [
        "",
        "⚠️ A blank precision means nothing was predicted for that class; a blank recall means the "
        "class does not appear in the ground truth. ⛔ Neither is a zero — "
        "\"predicted nothing\" and \"predicted only wrong things\" are different failures.",
    ]
    unannotated = sum(s.frames_unannotated for _, s in scores)
    if unannotated:
        lines.append("")
        lines.append(
            f"⚠️ **{unannotated} analysed frame(s) carry no annotation and were not scored.** They "
            f"are not frames of zero ground truth; counting them as such would report every correct "
            f"detection in them as a false positive."
        )
    return "\n".join(lines)


def _num(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:.3f}"
