# Annotating movie101 for pose accuracy — P3.3c

**For the person marking the joints.** The schema is `ANNOTATION_SCHEMA.md`; the box-drawing rules
are `ANNOTATION_INSTRUCTIONS.md` §1–§6 and they apply unchanged. This document is the **17-joint**
part, for this clip, with the exact commands.

> ⛔ **Nothing here may be produced by a model, and this document deliberately withholds what the
> model saw.** It does not tell you which frames contain a person, how many people are in any frame,
> or where any joint is. That information exists — the predictions file is already captured — and
> putting it here would anchor you to the model's answer on exactly the frames where the model is
> wrong. Ground truth derived from a detector scores the detector against itself.

---

## 0. What already exists

| File | What it is |
| --- | --- |
| `.data/real/movie101-frames/frame-00000.png … frame-00036.png` | the 37 frames the runtime analysed, numbered as it numbers them |
| `.data/real/movie101-pose/annotations.template.json` | ⭐ **the file you fill in** — 37 empty frames, plus a joint template to copy |
| `.data/real/movie101-pose/predictions.json` | what the model said. ⛔ Do not open it until you have finished |

The clip is `sha256:e6f1448f5482…`, 1080×1920, sampled at **1.9286 fps**. Those numbers are already
in your template and you should not change them.

---

## 1. Annotate every frame, including the empty ones

⚠️ All 37, in order. An empty frame is a **positive statement** that nobody was there, and it is what
makes a false positive measurable — a frame you skip is indistinguishable from a frame you reviewed
and found empty, and the second is worth far more.

For each frame that does contain a person: draw the box (`ANNOTATION_INSTRUCTIONS.md` §1), give it a
`gtId` that stays the same for that person across frames (§2), then add the joints.

---

## 2. The 17 joints

Copy the `keypoints` block from `_keypointTemplate` in your template file into the person's box, fill
in `x`/`y`, and **delete every joint you cannot place**.

```jsonc
{
  "label": "person",
  "gtId": 1,
  "bbox": [0.244, 0.328, 0.703, 0.662],
  "visibility": "fully-visible",
  "skeleton": "coco-17",
  "keypoints": [
    { "name": "nose",           "x": 0.686, "y": 0.405, "visible": true  },
    { "name": "left_shoulder",  "x": 0.640, "y": 0.470, "visible": true  },
    { "name": "right_wrist",    "x": 0.720, "y": 0.612, "visible": false }
  ]
}
```

Names, spelled exactly — `nose` · `left_eye` · `right_eye` · `left_ear` · `right_ear` ·
`left_shoulder` · `right_shoulder` · `left_elbow` · `right_elbow` · `left_wrist` · `right_wrist` ·
`left_hip` · `right_hip` · `left_knee` · `right_knee` · `left_ankle` · `right_ankle`.

⚠️ **Left and right are the SUBJECT's**, not yours. A person facing the camera has their left
shoulder on the right of your screen. This is the single most common annotation error and it
produces a mirrored ground truth that makes a correct model look broken.

⛔ **There is no `hand` joint.** COCO-17 annotates the wrist. The validator refuses anything else.

### ⭐ Annotate the four torso joints whenever you possibly can

`left_shoulder`, `right_shoulder`, `left_hip`, `right_hip`.

PCK measures error **relative to the size of the person**, and the reference length is the torso —
shoulder to opposite hip. A person missing a shoulder *and* the opposite hip has no computable torso,
is **excluded from the score entirely**, and is reported as excluded.

⚠️ That exclusion is not neutral. The people hardest to annotate are the people hardest to detect, so
excluding them quietly leaves a score describing an easier clip than the one you filmed. If a torso
joint is hidden, still place it to your best judgement with `visible: false` — a hidden hip has a
position, and a positioned hidden hip keeps that person in the measurement.

---

## 3. `visible` is your judgement about the pixels, and nothing else

| | Meaning | Who says it |
| --- | --- | --- |
| `visible: true` | you can **see** the joint | you |
| `visible: false` | the joint is **there but hidden** — behind the body, a wall, furniture | you |
| `confidence` | how sure the **model** was | ⛔ the model, never you. Writing one is refused at parse time |

- **Give `x`/`y` even when `visible: false`.** "Did the model put the hidden wrist in the right
  place" is one of the two questions this exercise exists to answer.
- If you genuinely cannot tell where a joint is — the arm is out of shot entirely — **omit it**.
  Omitted and hidden are different facts and the scorer treats them differently: an omitted joint is
  never counted, a hidden one is counted and reported in its own column.
- ⛔ Your `visible` is never compared against the model's `visible` inside the accuracy number. The
  two are tallied side by side as a separate agreement statistic, because a model that declines to
  answer must not be able to raise its own score by doing so.

---

## 4. Finishing

1. Set `annotator` to your name and `note` to anything ambiguous you decided, and how.
2. ⛔ Delete the `UNFILLED SKELETON` note, and the `_keypointTemplate` / `_boxTemplate` blocks.
3. Save as `.data/real/movie101-pose/annotations.json`.

```bash
# validate — seconds, and it is the difference between finding a mistake now
# and finding it after the numbers are quoted
cd ai/inference
python3 real_footage_cli.py --validate-annotations \
    ../../.data/real/movie101-pose/annotations.json \
    --case movie101 --real-root ../../.data/real
```

```bash
# score
cd ai/inference
python3 pose_score_cli.py score \
    --annotations ../../.data/real/movie101-pose/annotations.json \
    --predictions ../../.data/real/movie101-pose/predictions.json \
    --case movie101 \
    --json ../../.data/real/movie101-pose/pose-score.json
```

The scorer refuses before it computes anything if the clip digest, the sample rate, the frame range,
the case or the `gtId`s disagree — and it refuses to publish a headline number at all if coverage is
below the declared minimum. It prints the counts either way.

---

## 5. ⚠️ What this clip can and cannot establish

**One adult male, one room, one camera, one wardrobe.** Even annotated perfectly and completely,
movie101 yields at most ~12 person instances and ~200 joints from **one subject**.

The scorer will therefore never return `measured` for this clip — the best available verdict is
`indicative`, and every number will carry the sample size. That is the correct outcome, not a
shortfall in the tooling: a per-joint rate from one body describes that body.

⭐ **What it is genuinely good for** is the thing a large corpus is bad at: catching *structural*
error. A mirrored ground truth, a coordinate-space mistake, a left/right swap or a decode bug will
all show up unmistakably in 200 joints from one person. Generalisable accuracy needs a corpus with
many subjects, and that is a separate acquisition problem — see `FOOTAGE_ACQUISITION.md`.
