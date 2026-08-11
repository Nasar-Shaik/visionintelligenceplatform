# Tier-1 annotation schema — `tier1-2026-08-11`

**The only thing in this platform allowed to authorise an accuracy metric.** Everything the benchmark
reports today is observational, because nobody has written down what was actually in the frame.

Implementation: `ai/inference/annotations.py`. Scorer: `ai/inference/detection_scoring.py`.

---

## 1. The file

One file per clip, stored **beside the clip** (so `.data/real/` for real footage — annotations of real
people are derived data, but they are worthless without the footage they describe, so they travel
together rather than splitting across a third location).

```jsonc
{
  "schemaVersion": "tier1-2026-08-11",
  "caseId":        "take-01-spine",
  "clipSha256":    "e6f1448f…",        // ⛔ 64 hex — binds these boxes to those exact pixels
  "annotatedFps":  2.0,                 // ⚠️ must equal the benchmark's sampling rate
  "annotator":     "nasar",
  "frames": [
    { "frameIndex": 0, "atSeconds": 0.0,
      "boxes": [
        { "label": "person", "bbox": [0.31, 0.12, 0.14, 0.62],
          "gtId": 1, "visibility": "fully-visible" },
        { "label": "bottle", "bbox": [0.52, 0.41, 0.03, 0.07],
          "gtId": 2, "visibility": "partially-occluded" }
      ] },
    { "frameIndex": 1, "atSeconds": 0.5, "boxes": [] }   // ⭐ a positive statement: nothing here
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | ✔ | ⚠️ Bumped when a field's *meaning* changes, never for a new optional one — a scorer must distinguish "predates that rule" from "disagrees with it" |
| `caseId` | ✔ | The benchmark case these boxes score |
| `clipSha256` | ✔ | ⛔ The binding. See §2 |
| `annotatedFps` | ✔ | The rate the annotator worked at. ⛔ The **effective** rate, not the requested one — see §2b |
| `frames[].frameIndex` | ✔ | Index into the **sampled** sequence, from 0 |
| `frames[].atSeconds` | — | Wall time into the clip; convenience for a human |
| `boxes[].label` | ✔ | Class name, matching the detector's vocabulary (`person`, `bottle`, `backpack`, …) |
| `boxes[].bbox` | ✔ | `[x, y, w, h]`, **normalized `[0,1]`** — the runtime's own convention, so comparison needs no transform that could itself be wrong |
| `boxes[].gtId` | — | Identity, **stable within this clip only** |
| `boxes[].visibility` | — | `fully-visible` \| `partially-occluded` \| `heavily-occluded` |
| `boxes[].keypoints` | — | ⭐ Accepted now, scored later. See §5 |

---

## 2. ⛔ Why the digest, and why it is not optional

Filenames get reused. Re-export a clip from a phone, keep the name, and every box silently describes
different pixels — producing a precision score that is precise, reproducible and about nothing.
`align()` refuses that, and it is the check that makes every other number here trustworthy.

Three more refusals, each because its absence produces a *plausible wrong number* rather than an error:

| Check | What it prevents |
| --- | --- |
| **Digest** | Boxes scored against different pixels |
| **Rate** | Annotate at 2 fps, sample at 5, and box 30 is compared against a detection 9 s away — every frame is both a miss and a false positive |
| **Range** | Annotations beyond the frames the run produced are not misses; they are frames nobody analysed |
| **Case id** | One clip's ground truth scoring another clip |

⚠️ **Constructed fixtures declare `"clipSha256": null`** and are exempt: they live in the repository,
where git already binds file to content — the same rule the corpus applies, which *forbids* authored
cases a `sha256`. ⛔ An **empty or malformed** digest is not the same as an explicit `null`: that is
somebody who meant to bind and got it wrong, and it is refused.

The pairing is checked **both ways**: digest-bound footage may not be scored by unbound annotations
(that would silently drop the only check tying boxes to pixels), and unbound footage may not be
scored by digest-bound annotations (a pairing mistake somewhere).

---

## 2b. ⛔ Annotate at the rate the benchmark *actually* samples

`FrameSampler.stride` is an **integer**: `stride = round(source_fps / target_fps)`. A 15 fps clip
asked for 2.0 fps therefore gets stride 8 and is sampled at **1.875 fps** — 6.25 % low, and 8.75
frames of divergence over a 70 s clip.

| Source fps | Target | Stride | **Effective** |
| ---: | ---: | ---: | ---: |
| 30 | 2.0 | 15 | 2.000 |
| 15 | 2.0 | 8 | **1.875** |
| 27 | 2.0 | 14 | **1.929** |
| 25 | 2.0 | 13 | **1.923** |

⭐ **`annotatedFps` must be the effective rate**, and alignment is checked against it. This was found
by running the first end-to-end scoring job: aligning against the *requested* rate would refuse an
annotator who correctly worked at the true rate and accept one who assumed 2.0.

⚠️ In practice the annotator works from the **extracted sampled frames**, so `frameIndex` alignment
is exact by construction; the rate matters for `atSeconds` and for this check.

## 3. ⛔ What the schema deliberately refuses

- **An unannotated frame is not an empty frame.** A frame nobody labelled is excluded from scoring;
  treating it as zero ground truth would count every correct detection in it as a false positive, and
  a partially annotated clip would read as a catastrophic detector.
- **An empty frame *is* a statement.** `"boxes": []` means "nothing was here" and is what makes false
  positives measurable. Omitting empty frames would make a detector that hallucinates in quiet
  moments look perfect.
- **Zero-area and pixel-coordinate boxes** are refused at parse time — both would score as total
  misses, a catastrophic-looking result caused by a formatting mistake.
- **A duplicated `frameIndex`** is refused rather than merged: which record is the truth is
  unknowable, and picking either silently halves or doubles that frame's recall.

---

## 4. Identity — `gtId`

Stable **within one clip**. `gtId: 1` in two clips is two different people.

⛔ **Cross-clip identity is a re-identification claim, and ADR-0055 governs those.** Tier-1 makes no
such claim and the schema gives it nowhere to live.

Two consistency checks are reported (not raised — a clip can be perfectly good for detection scoring
while its identities are unusable):

- one `gtId` twice in one frame — one subject cannot be in two places, and unchecked this inflates
  every identity metric computed from the file;
- a `gtId` whose label changes between frames — a typo that would otherwise be scored as a tracking
  failure the detector caused.

---

## 5. ⭐ Keypoints: accepted now, scored later

`boxes[].keypoints` parses and round-trips today and **nothing scores it**. The field exists so the
annotation format does not have to change on the day pose validation begins — annotating a take twice
is the expensive mistake this avoids.

⛔ **Accepting the field authorises no pose model.** See `POSE_SEAM.md`.

---

## 6. What is measured, once annotations exist

Per detector, per case, **class-aware**, greedy by descending confidence at **IoU ≥ 0.5** (the COCO
convention, named in every report because precision at 0.5 and at 0.75 are different numbers):

`truePositives` · `falsePositives` · `falseNegatives` · `precision` · `recall` · `f1` · `meanIou`,
each also **per class**.

⚠️ **Blank is not zero.** A blank precision means nothing was predicted for that class; a blank recall
means the class does not appear in the ground truth. "Predicted nothing" and "predicted only wrong
things" are different failures, and averaging them together hides the first.

⛔ **No accuracy section is rendered at all when nothing is annotated** — absent, not zeroed. And an
annotation set that fails alignment is *printed as a refusal*, because "this clip has no accuracy
number" and "this clip's annotations did not describe its pixels" look identical in a report that
omits both.
