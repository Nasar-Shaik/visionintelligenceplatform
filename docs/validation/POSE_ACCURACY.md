# Pose accuracy — P3.3c tooling report

**2026-08-12.** The measurement path from human keypoints to PCK@0.2 is built, calibrated and
deployed. ⛔ **No accuracy result exists**, because no human has annotated anything yet — and the
tooling refuses to produce a number in that state rather than reporting zero.

Predecessors: `POSE_VERIFICATION.md` (P3.3b — pose runs), `POSE_ARTIFACT.md` (P3.3a — provenance),
`ANNOTATION_INSTRUCTIONS.md` (the box rules), `POSE_ANNOTATION_MOVIE101.md` (⭐ **the annotator's
guide, and the file to read next**).

---

## 1. Metric, and the choice inside it

**PCK@0.2, normalized by torso** — shoulder to opposite hip, taken from the *human's* annotation.

⚠️ "PCK@0.2" alone names no measurement. The normalizer is the whole metric, and the obvious choice
was badly wrong here. Measured on a movie101 standing person (216×768 px box, 1080×1920 frame):

| normalizer | reference length | tolerance @ α=0.2 | as % of box width |
| --- | --- | --- | --- |
| `bbox-diagonal` | 798 px | 160 px | **74 %** |
| `bbox-max-side` | 768 px | 154 px | **71 %** |
| **`torso`** ⭐ | 266 px | **53 px** | **25 %** |

⛔ A box-normalized PCK@0.2 on a tall portrait frame accepts a wrist placed on the **opposite side of
the body**. It would have reported a high number, reproducibly, for a model that had learned almost
nothing about limbs. Torso scales with the person rather than with how the detector felt about
padding. The box normalizers remain selectable for comparison and are never the default.

**Consequences, stated rather than hidden:** a person whose shoulders and hips were not both
annotated has no computable torso, is **excluded** from PCK, and is counted as excluded with a
mandatory caveat — never rescued by a silent fallback that would change every threshold while the
report kept printing "torso".

### ⚠️ Distances are computed in pixels

Every coordinate in this platform is normalized `[0,1]` **per axis**. On a 1080×1920 frame a
normalized `dx` of 0.01 is 10.8 px and the same `dy` is 19.2 px. A scorer comparing in normalized
space would score a horizontal error as roughly half a vertical one of the same physical size —
plausible, reproducible and wrong. `frame_width`/`frame_height` are required arguments, not optional
ones, and a test asserts that equal physical errors score equally on both axes.

---

## 2. What the scorer separates, and refuses to merge

| Kept apart | Why |
| --- | --- |
| **Detector recall** vs **pose accuracy** | PCK is computed only over ground-truth people the detector actually found — a top-down model is never shown the ones it missed. Unmatched people are counted and reported as a *detector* number. Folding them in would report one number with two causes |
| **Localization** vs **visibility agreement** | The model's `visible` flag is never consulted when scoring position. If it were, a model could raise its own score by declining to answer. Agreement is tallied separately as a confusion count |
| **Human `visible`** vs **model `confidence`** | Ground truth carries no confidence; the annotation schema *refuses* the field at parse time |
| **Omitted** vs **hidden** joints | An omitted joint is never counted; a hidden one is counted and reported in its own column. "Not annotated" is not a failure |
| **Left wrist** vs **right wrist** | A mirrored model has a mediocre overall PCK and **zero** wrist PCK — see §4 |

---

## 3. The coverage gate

⛔ **No headline number below the declared minimum.** Counts are always printed; the PCK line is
replaced by `NOT PUBLISHED`.

| Verdict | Requires | Headline |
| --- | --- | --- |
| `no-ground-truth` | zero annotated keypoints | ⛔ refused, with the strongest banner |
| `insufficient` | below 5 people / 50 joints | ⛔ refused |
| `indicative` | below 30 people / 300 joints / 10 subjects | ⚠️ published **only** with the sample size attached |
| `measured` | at or above all three | published |

⛔ **Every verdict below `measured` carries a caveat, and the caveats are gated on the UNSAFE state
rather than on the empty one.** A banner reading "no accuracy may be claimed" conditioned on
`joints == 0` deletes itself the moment the first joint is annotated — exactly when the sample is
smallest and the warning matters most. A test sweeps 0→7 frames and asserts a caveat at every step.

⚠️ **movie101 can never reach `measured`**: one subject, ~12 person instances, ~204 joints. The best
attainable verdict for this clip is `indicative`, and that is the correct outcome rather than a
shortfall in the tooling.

---

## 4. Negative controls

Every one of these must produce a *low or refused* result. A scorer that is structurally wrong
reports a plausible number, and a plausible number is the one nobody checks.

| Control | Asserted |
| --- | --- |
| **Swapped subjects** — person A's skeleton on person B | both still *match* by box; PCK **0.0** |
| **Mirrored joints** — every left/right label exchanged | ⭐ overall PCK stays **> 0.3** while wrists, elbows and shoulders go to **0.0** — the headline *hides* a mirror and the per-joint rates expose it |
| **Boundary** | 0.999× tolerance correct, 1.001× wrong (the exact boundary is not asserted: a normalized→pixel round-trip cannot represent it, and a test sitting on it would turn on the last bit of a float) |
| **Anisotropy** | equal physical errors score equally on x and y |
| **Empty ground truth** | `pck is None`, verdict `no-ground-truth`, publication refused |
| **Generous detector box** | scores identically to a tight one — the normalizer comes from the human |
| **Torso not computable** | person excluded and counted, never silently rescued |
| **Matched person with no pose** | counted as 17 missed joints, not skipped |
| **Unannotated frame** | excluded from the denominator, never a failure |

⛔ **The fixtures themselves were a defect first.** The first version placed the 17 joints on a tight
index-derived grid, so every joint sat inside the tolerance of every other and a **fully mirrored
skeleton scored 1.00**. The negative control passed while proving nothing. Fixture joints are now
laid out as a body is, as fractions of the person's own box.

---

## 5. Instrument calibration — ⛔ not accuracy

A measuring tool that has only ever printed a refusal has not been shown to work. The previous
milestone lost two rebuild cycles to a counter that could only ever read zero, so the scorer was run
end to end against known-answer inputs: the model's own predictions, treated as if a human had
written them, displaced by a known multiple of the tolerance.

| displacement | expected | measured |
| --- | --- | --- |
| 0.0 × tolerance | 1.00 | **0.9951** (203/204) |
| 0.5 × tolerance | 1.00 | **0.9951** (203/204) |
| 1.5 × tolerance | 0.00 | **0.0000** (0/204) |

The single miss at zero displacement is `right_ankle` (11/12) and is fully explained: the model
placed it **outside the frame** (`y > 1.0`), correctly flagged `visible: false` rather than clamped,
and the calibration input had to clamp it because a human annotation cannot leave the frame. That
asymmetry is by design on both sides.

⛔ **These numbers are properties of the arithmetic, not of the model.** The inputs were derived from
model output; scoring a model against itself measures self-consistency. The calibration file is
written to a scratchpad, is never committed, and is labelled so it cannot be mistaken for ground
truth. **No line of this table may be quoted as pose accuracy.**

⚠️ Two of the three arms initially disagreed with their known answer, and both were the *calibration
script's* fault, not the scorer's: an edge clamp that silently shrank the displacement, and the
out-of-frame ankle above. Finding them is what the exercise is for.

---

## 6. Provenance

`predict` refuses to write a file it cannot fully attribute — no commit, no output.

```json
{
  "caseId": "movie101",
  "clipSha256": "e6f1448f54821fae4d5a197e464a08fc6c5a85453309f98fffc407aa99396107",
  "frameWidth": 1080, "frameHeight": 1920,
  "sourceFps": 27.001, "stride": 14, "effectiveFps": 1.928643,
  "effectiveFpsSource": "manifest capture.fps / stride",
  "provenance": {
    "commit": "11888cec49ba4c1fadd57285ef92814e0a487c3e",
    "image": "sha256:100e64f2d79e…",
    "runtimeVersion": "0.1.0", "executionProvider": "CPUExecutionProvider",
    "poseModel": "rtmpose-tiny",
    "poseArtifactSha256": "38b1d4724f679639fbe3f2ba4679b87d99b737eda01d7bc0e0666700df461a68",
    "detector": { "id": "yolox-nano", "version": "1.0.0" }
  },
  "totals": { "frames": 37, "personDetections": 12, "personsWithPose": 12 }
}
```

Every frame additionally carries its own `fileSha256`, so predictions regenerated from a re-extracted
frame set cannot silently describe different pixels. Each keypoint payload's artifact digest is
checked against the runtime's — a file mixing two artifacts is refused rather than scored as one
model.

### ⚠️ Two rates, and the tolerance between them

The annotation skeleton derives the sample rate from the clip's **measured** header (1.928609); the
predictions file derives it from the manifest's **rounded** `fps: 27.001` (1.928643). They differ in
the fifth decimal. `check_alignment` compares them against a tolerance **derived from the manifest's
own decimal precision** (±0.0005 fps ÷ stride = ±3.6e-5), never against a convenient epsilon — the
same class of mismatch once made a correct annotation file fail its own validator by 34× the
tolerance. A genuine rate mistake (2.0 vs 1.9286) is still refused, with the explanation that a rate
error slides the whole file rather than misplacing one frame.

### ⛔ A defect found in this tooling, in this milestone

`bc.DEFAULT_REAL_ROOT` is the **relative** `.data/real`, so running the scorer from `ai/inference`
rather than the repo root turned the rate-and-range check into a `NOT CHECKED` line. It was caught
only because the earlier work made that disclosure loud instead of silent. The path is now resolved
absolutely against the repository root.

---

## 7. Tests and gates

| Gate | Result |
| --- | --- |
| `tests/test_pose_scoring.py` — metric, splits, negative controls, coverage gate | 36 |
| `tests/test_pose_score_cli.py` — alignment, provenance, frame order, template | 22 |
| **Python runtime suite** | **1868 OK** (skipped 50) |
| `pnpm turbo lint typecheck test` | 70/70 |
| `pnpm verify:contracts` | OK |
| `node tools/validation/verify-deployment.mjs` | online |
| End-to-end through the deployed runtime | 37 frames captured, 12 person detections, 12 with pose |

---

## 8. State

| | |
| --- | --- |
| **IMPLEMENTED** | metric, coverage gate, alignment checks, provenance binding, CLI, template, instructions |
| **VERIFIED** | 58 tests; end-to-end capture from the deployed runtime; instrument calibrated to known answers |
| **ACCURACY** | ⛔ **none, and none may be quoted.** Zero human keypoint annotations exist. PCK is not computable and the tooling refuses to publish one |
| **BLOCKED ON** | a human annotating `.data/real/movie101-pose/annotations.template.json` |

⚠️ Even a perfect, complete annotation of movie101 yields ~204 joints from **one subject** and can
only ever reach the `indicative` verdict. It is excellent at catching *structural* error — a
mirrored ground truth, a coordinate-space mistake, a decode bug — and cannot establish generalisable
accuracy. That needs a corpus with many subjects: a separate acquisition problem, `FOOTAGE_ACQUISITION.md`.
