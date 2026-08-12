"""Pose accuracy against **human** keypoints — P3.3c.

    human annotations ──┐
                        ├──▶ match persons by IoU ──▶ PCK@α ──▶ per joint · wrists · visible/occluded
    model predictions ──┘

⛔ **Nothing here may read a model as truth.** The ground truth is a person's stated joint positions
and their stated visibility. A model's `confidence` is not evidence, a model's `visible` is not
evidence, and a detection is not evidence. The only thing this module takes from the runtime is
*where it said the joints were*.

### ⭐ Detection accuracy and pose accuracy are different measurements

PCK is computed **only over ground-truth people the detector actually found**, because a top-down
pose model is never given the ones it missed. Folding those in would report a detector's recall as a
pose model's accuracy — one number, two causes, no way to act on it. The people the detector missed
are counted and reported separately, and a run where that count is large is a run whose PCK describes
an easy subset.

### ⚠️ Distances are computed in PIXELS, and that is not a detail

Every coordinate in this platform is normalized to `[0,1]` **per axis**. On movie101 (1080×1920) a
normalized `dx` of 0.01 is 10.8 px and the same `dy` is 19.2 px, so Euclidean distance in normalized
space is anisotropic — it would score a horizontal error as roughly half a vertical one of the same
physical size. Every distance here is un-normalized with the clip's real dimensions first, which is
why `frame_width`/`frame_height` are required rather than optional.

Stdlib-only, pure, deterministic. No model, no video, no I/O.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from annotations import Annotations, Box, GroundTruthKeypoint
from perception import COCO_17

#: PCK's tolerance, as a fraction of the normalizing length. ⚠️ 0.2 is a *convention*, not a
#: property of the model — a number reported without its α and its normalizer is not comparable to
#: anything, so both travel with every result this module produces.
DEFAULT_ALPHA = 0.2

#: How far a predicted box must overlap a human's box before the two are called the same person.
#: ⚠️ Deliberately strict. A loose match attributes person A's skeleton to person B's label and the
#: error appears as a uniformly poor PCK rather than as a matching failure.
DEFAULT_MATCH_IOU = 0.5

#: ⭐ **The normalizing length is taken from the HUMAN's annotation, never the model's.** A detector
#: that draws generous boxes would otherwise widen its own tolerance and score better for being vaguer.
NORMALIZERS = ("torso", "bbox-diagonal", "bbox-max-side")

#: ⛔ **Torso, and the box-based alternatives are kept only for comparison.** Measured on a movie101
#: standing person (a 216×768 px box on a 1080×1920 portrait frame):
#:
#: | normalizer | length | tolerance @ α=0.2 | as % of BOX WIDTH |
#: | --- | --- | --- | --- |
#: | `bbox-diagonal` | 798 px | 160 px | **74 %** |
#: | `bbox-max-side` | 768 px | 154 px | **71 %** |
#: | `torso` | 266 px | 53 px | 25 % |
#:
#: A box-normalized PCK@0.2 on a tall portrait box accepts a wrist placed on the *opposite side of
#: the body*. It would have reported a high number for a model that had learned almost nothing about
#: limbs, and the number would have been reproducible, defensible-sounding and worthless. Torso
#: (shoulder to opposite hip) is the conventional PCK reference and scales with the body rather than
#: with how the detector felt about padding.
#:
#: ⚠️ The cost is real and is not hidden: a person whose shoulders and hips were not both annotated
#: has no torso, is **excluded** from PCK, and is counted as excluded — never silently rescued by a
#: fallback that would change every threshold while the report kept printing "torso".
DEFAULT_NORMALIZER = "torso"

#: Reported on their own because they are the joints this product will actually be judged on: a
#: wrist is where a concealed object is held, and wrists are the hardest joints in the skeleton.
WRISTS = ("left_wrist", "right_wrist")


class PoseScoringError(ValueError):
    """A comparison that cannot be made honestly. ⛔ Raised rather than scored as zero."""


@dataclass(frozen=True)
class PredictedKeypoint:
    """What the runtime said. ⚠️ `visible` is the MODEL's claim and is never used as ground truth."""

    name: str
    x: float
    y: float
    confidence: float
    visible: bool


@dataclass(frozen=True)
class PredictedPerson:
    bbox: Tuple[float, float, float, float]
    keypoints: Tuple[PredictedKeypoint, ...]
    confidence: float = 0.0


@dataclass(frozen=True)
class JointScore:
    """One joint's tally. ⛔ `correct/total`, never a bare percentage — a rate without its
    denominator cannot be distinguished from a rate over three samples."""

    name: str
    correct: int = 0
    total: int = 0
    #: The same tally split by what the **human** said about visibility.
    correct_visible: int = 0
    total_visible: int = 0
    correct_occluded: int = 0
    total_occluded: int = 0

    @property
    def pck(self) -> Optional[float]:
        return None if self.total == 0 else self.correct / self.total

    def to_dict(self) -> dict:
        return {
            "joint": self.name,
            "correct": self.correct,
            "total": self.total,
            "pck": None if self.pck is None else round(self.pck, 4),
            "visible": _rate(self.correct_visible, self.total_visible),
            "occluded": _rate(self.correct_occluded, self.total_occluded),
        }


def _rate(correct: int, total: int) -> dict:
    """⛔ `null` when nothing was measured, never `0.0`. Zero means "measured, all wrong"."""
    return {"correct": correct, "total": total,
            "pck": None if total == 0 else round(correct / total, 4)}


@dataclass
class PoseReport:
    """What was measured, over what, by whom, against which artifact."""

    alpha: float
    normalizer: str
    match_iou: float
    frame_width: int
    frame_height: int
    #: ⭐ Provenance travels with the number or the number is not reportable.
    provenance: Dict[str, object] = field(default_factory=dict)

    frames_annotated: int = 0
    frames_scored: int = 0
    gt_people: int = 0
    #: People a human annotated who carried at least one keypoint. Others cannot contribute to PCK.
    gt_people_with_keypoints: int = 0
    #: ⚠️ **A detector measurement, reported here only so PCK's subset is visible.** Never folded in.
    gt_people_matched: int = 0
    gt_people_unmatched: int = 0
    predicted_people_unmatched: int = 0
    #: Matched people whose prediction carried no pose at all.
    matched_without_pose: int = 0
    #: ⛔ Counted, not merely noted. People excluded because the chosen normalizer was not computable
    #: from their annotation — a silent exclusion would shrink the denominator invisibly and raise
    #: the score by dropping exactly the hardest, least-completely-annotated subjects.
    excluded_no_normalizer: int = 0
    #: ⛔ Distinct `gtId`s carrying keypoints. **The single most important number for reading any
    #: per-joint rate**: a clip with one subject measures one body, one wardrobe, one camera angle,
    #: and generalises to nothing. It is counted rather than assumed because a reader who is told
    #: "PCK 0.91" and not told "n=1 person" has been misled by a true number.
    subjects: int = 0

    joints: Dict[str, JointScore] = field(default_factory=dict)
    #: How often the model's `visible` flag agreed with the human's. ⛔ Kept apart from PCK: a
    #: localization score and a visibility-agreement score answer different questions.
    visibility_agreement: Dict[str, int] = field(
        default_factory=lambda: {"agree": 0, "modelSaidVisibleHumanDidNot": 0,
                                 "humanSaidVisibleModelDidNot": 0, "total": 0}
    )
    notes: List[str] = field(default_factory=list)

    @property
    def total_joints(self) -> int:
        return sum(j.total for j in self.joints.values())

    @property
    def correct_joints(self) -> int:
        return sum(j.correct for j in self.joints.values())

    @property
    def pck(self) -> Optional[float]:
        """⛔ `None` when nothing was scored. A headline of `0.0` over an empty set is a claim that
        the model got everything wrong, which is the opposite of what an empty set says."""
        return None if self.total_joints == 0 else self.correct_joints / self.total_joints

    def wrists(self) -> dict:
        """⭐ Both wrists together **and** each one alone.

        ⚠️ The split is not decoration. A left/right confusion — the classic pose failure, and one a
        mirrored training set produces — leaves the combined wrist rate looking merely mediocre while
        each individual wrist is catastrophically wrong in a way that points straight at the cause.
        """
        present = [w for w in WRISTS if w in self.joints]
        c = sum(self.joints[w].correct for w in present)
        t = sum(self.joints[w].total for w in present)
        cv = sum(self.joints[w].correct_visible for w in present)
        tv = sum(self.joints[w].total_visible for w in present)
        co = sum(self.joints[w].correct_occluded for w in present)
        to = sum(self.joints[w].total_occluded for w in present)
        return {
            "overall": _rate(c, t),
            "visible": _rate(cv, tv),
            "occluded": _rate(co, to),
            "left": self.joints["left_wrist"].to_dict() if "left_wrist" in self.joints else None,
            "right": self.joints["right_wrist"].to_dict() if "right_wrist" in self.joints else None,
        }

    def to_dict(self) -> dict:
        return {
            "metric": f"PCK@{self.alpha}",
            "normalizer": self.normalizer,
            "matchIou": self.match_iou,
            "frameSize": [self.frame_width, self.frame_height],
            "provenance": dict(self.provenance),
            "sample": {
                "framesAnnotated": self.frames_annotated,
                "framesScored": self.frames_scored,
                "gtPeople": self.gt_people,
                "gtPeopleWithKeypoints": self.gt_people_with_keypoints,
                "distinctSubjects": self.subjects,
                "gtPeopleMatched": self.gt_people_matched,
                "gtPeopleUnmatchedByDetector": self.gt_people_unmatched,
                "predictedPeopleUnmatched": self.predicted_people_unmatched,
                "matchedWithoutPose": self.matched_without_pose,
                "excludedNoNormalizer": self.excluded_no_normalizer,
                "jointsScored": self.total_joints,
            },
            "overall": _rate(self.correct_joints, self.total_joints),
            "wrists": self.wrists(),
            "perJoint": [self.joints[n].to_dict() for n in COCO_17 if n in self.joints],
            "visibilityAgreement": dict(self.visibility_agreement),
            "notes": list(self.notes),
        }


# --- geometry ---------------------------------------------------------------------------------


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection over union of two `[x, y, w, h]` boxes, normalized units."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    iy = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return 0.0 if union <= 0 else inter / union


def normalizing_length(box: Box, gt: Mapping[str, GroundTruthKeypoint], *,
                       normalizer: str, frame_width: int, frame_height: int) -> Optional[float]:
    """The PCK reference length **in pixels**, from the human's annotation only.

    ⛔ Returns `None` rather than a fallback when the chosen normalizer is not computable. A torso
    length silently replaced by a box diagonal would change every threshold in the run and leave the
    reported normalizer name describing something that did not happen.
    """
    if normalizer == "torso":
        # Shoulder to opposite hip: the standard torso reference, and the one that survives a person
        # standing at an angle better than shoulder-to-shoulder does.
        a, b = gt.get("left_shoulder"), gt.get("right_hip")
        if a is None or b is None:
            a, b = gt.get("right_shoulder"), gt.get("left_hip")
        if a is None or b is None:
            return None
        length = math.hypot((a.x - b.x) * frame_width, (a.y - b.y) * frame_height)
        return length if length > 0 else None

    w = box.bbox[2] * frame_width
    h = box.bbox[3] * frame_height
    if w <= 0 or h <= 0:
        return None
    if normalizer == "bbox-max-side":
        return max(w, h)
    if normalizer == "bbox-diagonal":
        return math.hypot(w, h)
    raise PoseScoringError(f"unknown normalizer '{normalizer}', expected one of {NORMALIZERS}")


# --- the measurement --------------------------------------------------------------------------


def _match(gt_boxes: Sequence[Box], predictions: Sequence[PredictedPerson],
           *, min_iou: float) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Greedy highest-IoU matching. Returns (pairs, unmatched_gt, unmatched_pred).

    ⚠️ Greedy rather than optimal (Hungarian) by choice: with the handful of people a retail frame
    holds, the two agree, and a reader can verify greedy by eye. If a case ever appears where they
    disagree, that is a finding about the footage worth reporting rather than hiding in an algorithm.
    """
    scored = sorted(
        ((iou(g.bbox, p.bbox), gi, pi)
         for gi, g in enumerate(gt_boxes) for pi, p in enumerate(predictions)),
        key=lambda t: (-t[0], t[1], t[2]),
    )
    pairs: List[Tuple[int, int]] = []
    used_gt: set = set()
    used_pred: set = set()
    for overlap, gi, pi in scored:
        if overlap < min_iou or gi in used_gt or pi in used_pred:
            continue
        pairs.append((gi, pi))
        used_gt.add(gi)
        used_pred.add(pi)
    return (pairs,
            [i for i in range(len(gt_boxes)) if i not in used_gt],
            [i for i in range(len(predictions)) if i not in used_pred])


def score(
    annotations: Annotations,
    predictions: Mapping[int, Sequence[PredictedPerson]],
    *,
    frame_width: int,
    frame_height: int,
    alpha: float = DEFAULT_ALPHA,
    normalizer: str = DEFAULT_NORMALIZER,
    match_iou: float = DEFAULT_MATCH_IOU,
    provenance: Optional[Mapping[str, object]] = None,
    person_label: str = "person",
) -> PoseReport:
    """Score model keypoints against human keypoints. ⛔ Never invents a subject or a joint.

    `predictions` is keyed by **frame index**, the same index the annotator used. A frame the human
    did not annotate is not scored and not counted as a failure — it is counted as unannotated, which
    is a different fact and one the report states.
    """
    if normalizer not in NORMALIZERS:
        raise PoseScoringError(f"unknown normalizer '{normalizer}', expected one of {NORMALIZERS}")
    if frame_width <= 0 or frame_height <= 0:
        raise PoseScoringError(
            "frame width and height are required and must be positive. ⚠️ Coordinates here are "
            "normalized per axis, so a distance computed without the real dimensions scores a "
            "horizontal error and an equal vertical one differently."
        )
    if not 0 < alpha:
        raise PoseScoringError(f"alpha must be positive, got {alpha}")

    report = PoseReport(alpha=alpha, normalizer=normalizer, match_iou=match_iou,
                        frame_width=frame_width, frame_height=frame_height,
                        provenance=dict(provenance or {}))
    report.joints = {name: JointScore(name=name) for name in COCO_17}
    tallies = {name: [0, 0, 0, 0, 0, 0] for name in COCO_17}  # c, t, cv, tv, co, to

    report.frames_annotated = len(annotations.frames)
    subject_ids: set = set()
    for frame in annotations.frames:
        people = [b for b in frame.boxes if b.label == person_label]
        report.gt_people += len(people)
        with_kp = [b for b in people if b.keypoints]
        report.gt_people_with_keypoints += len(with_kp)
        # ⚠️ A box with no gtId counts as its own subject: an unnamed person is one person, and
        # folding every anonymous box into a single bucket would report one subject for a crowd.
        subject_ids.update((frame.frame_index, id(b)) if b.gt_id is None else ("gt", b.gt_id)
                           for b in with_kp)
        if not with_kp:
            # ⚠️ Not an error and not a zero: a frame whose people carry no keypoints is a frame this
            # measurement has nothing to say about.
            continue

        predicted = list(predictions.get(frame.frame_index, ()))
        report.frames_scored += 1
        pairs, unmatched_gt, unmatched_pred = _match(with_kp, predicted, min_iou=match_iou)
        report.gt_people_unmatched += len(unmatched_gt)
        report.predicted_people_unmatched += len(unmatched_pred)

        for gi, pi in pairs:
            report.gt_people_matched += 1
            gt_box = with_kp[gi]
            pred = predicted[pi]
            gt_by_name = {k.name: k for k in gt_box.keypoints}
            if not pred.keypoints:
                # ⛔ Counted, not skipped. A matched person the pose stage produced nothing for is a
                # real miss, and dropping it would compute PCK over the successes only.
                report.matched_without_pose += 1
                for name, k in gt_by_name.items():
                    t = tallies[name]
                    t[1] += 1
                    t[3 if k.visible else 5] += 1
                continue

            length = normalizing_length(gt_box, gt_by_name, normalizer=normalizer,
                                        frame_width=frame_width, frame_height=frame_height)
            if length is None:
                report.excluded_no_normalizer += 1
                report.notes.append(
                    f"frame {frame.frame_index}: '{normalizer}' is not computable for gtId "
                    f"{gt_box.gt_id} — that person is excluded from PCK and counted as excluded"
                )
                continue

            pred_by_name = {k.name: k for k in pred.keypoints}
            for name, truth in gt_by_name.items():
                guess = pred_by_name.get(name)
                t = tallies[name]
                t[1] += 1
                bucket_total, bucket_correct = (3, 2) if truth.visible else (5, 4)
                t[bucket_total] += 1
                if guess is None:
                    continue
                # ⛔ The model's own `visible` flag is NOT consulted here. PCK asks where the model
                # put the joint; whether it also believed the joint was visible is a separate
                # question, tallied separately below. Conflating them would let a model raise its
                # score by declining to answer.
                distance = math.hypot((truth.x - guess.x) * frame_width,
                                      (truth.y - guess.y) * frame_height)
                if distance <= alpha * length:
                    t[0] += 1
                    t[bucket_correct] += 1

                agreement = report.visibility_agreement
                agreement["total"] += 1
                if guess.visible == truth.visible:
                    agreement["agree"] += 1
                elif guess.visible:
                    agreement["modelSaidVisibleHumanDidNot"] += 1
                else:
                    agreement["humanSaidVisibleModelDidNot"] += 1

    report.joints = {
        name: JointScore(name=name, correct=t[0], total=t[1], correct_visible=t[2],
                         total_visible=t[3], correct_occluded=t[4], total_occluded=t[5])
        for name, t in tallies.items()
    }
    report.subjects = len(subject_ids)
    return report


# --- the coverage gate ------------------------------------------------------------------------

#: What a headline PCK requires before it may be published at all. ⚠️ These are **conventions this
#: project is declaring**, not properties of PCK — so they are named, versioned with the report, and
#: stated in every output rather than applied silently.
MEASURED_MIN_SUBJECTS = 10
MEASURED_MIN_PEOPLE = 30
MEASURED_MIN_JOINTS = 300

INDICATIVE_MIN_PEOPLE = 5
INDICATIVE_MIN_JOINTS = 50

VERDICTS = ("no-ground-truth", "insufficient", "indicative", "measured")


@dataclass(frozen=True)
class Coverage:
    """Whether this sample may carry a headline number, and what must be said beside it.

    ⛔ **The caveats are gated on the UNSAFE state, never on the empty one.** A banner that reads
    "no accuracy may be claimed" and is conditioned on `jointsScored == 0` deletes itself the moment
    the first joint is annotated — exactly when the sample is smallest and the warning matters most.
    So every verdict below `measured` carries a caveat, and `no-ground-truth` carries the strongest.
    """

    verdict: str
    #: ⛔ `False` means the report must print counts and **no** PCK. Not a zero, not a dash: a
    #: headline that exists is a headline that gets quoted without its footnote.
    publishable: bool
    caveats: Tuple[str, ...]

    def to_dict(self) -> dict:
        return {"verdict": self.verdict, "headlinePublishable": self.publishable,
                "caveats": list(self.caveats)}


def coverage(report: PoseReport) -> Coverage:
    """Classify the sample. ⛔ Called before any number is printed, never after."""
    joints = report.total_joints
    people = report.gt_people_matched
    caveats: List[str] = []

    if report.gt_people_with_keypoints == 0:
        return Coverage(
            verdict="no-ground-truth",
            publishable=False,
            caveats=(
                "⛔ NO HUMAN KEYPOINT GROUND TRUTH EXISTS. No PCK, per-joint rate or accuracy claim "
                "of any kind may be made or quoted from this run.",
                "⚠️ Model output is not a substitute: scoring predictions against themselves "
                "measures self-consistency and reports it in the vocabulary of accuracy.",
            ),
        )

    if report.gt_people_unmatched:
        caveats.append(
            f"⚠️ {report.gt_people_unmatched} annotated person(s) were never matched to a detection, "
            f"so PCK describes only the people the DETECTOR found. That is a detector measurement "
            f"and is reported separately — it must not be read as a pose result."
        )
    if report.excluded_no_normalizer:
        caveats.append(
            f"⛔ {report.excluded_no_normalizer} matched person(s) were EXCLUDED from PCK because "
            f"'{report.normalizer}' was not computable from their annotation. Excluded people are "
            f"disproportionately the incompletely annotated ones, so the remaining score describes "
            f"an easier subset than the footage."
        )
    if report.matched_without_pose:
        caveats.append(
            f"⚠️ {report.matched_without_pose} matched person(s) carried no pose at all; their joints "
            f"count as misses in the denominator."
        )
    if report.subjects < MEASURED_MIN_SUBJECTS:
        caveats.append(
            f"⛔ {report.subjects} distinct subject(s). Per-joint rates describe this individual, "
            f"this wardrobe and this camera — they do not generalise, and must never be quoted as "
            f"the model's accuracy."
        )

    if joints < INDICATIVE_MIN_JOINTS or people < INDICATIVE_MIN_PEOPLE:
        caveats.insert(0, (
            f"⛔ INSUFFICIENT COVERAGE: {people} scored person(s) and {joints} joint(s), below the "
            f"declared minimum of {INDICATIVE_MIN_PEOPLE} people / {INDICATIVE_MIN_JOINTS} joints. "
            f"Counts are reported; NO headline accuracy number may be published."
        ))
        return Coverage(verdict="insufficient", publishable=False, caveats=tuple(caveats))

    if (joints < MEASURED_MIN_JOINTS or people < MEASURED_MIN_PEOPLE
            or report.subjects < MEASURED_MIN_SUBJECTS):
        caveats.insert(0, (
            f"⚠️ INDICATIVE ONLY: {people} scored person(s), {joints} joint(s), "
            f"{report.subjects} subject(s) — below the declared measured threshold of "
            f"{MEASURED_MIN_PEOPLE} people / {MEASURED_MIN_JOINTS} joints / "
            f"{MEASURED_MIN_SUBJECTS} subjects. The number is real; the sample is small. Report it "
            f"with this sentence attached or not at all."
        ))
        return Coverage(verdict="indicative", publishable=True, caveats=tuple(caveats))

    return Coverage(verdict="measured", publishable=True, caveats=tuple(caveats))
