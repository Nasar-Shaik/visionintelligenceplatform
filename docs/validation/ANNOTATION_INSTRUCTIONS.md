# Human annotation instructions — take-01-spine

**For the person drawing the boxes.** The schema is `ANNOTATION_SCHEMA.md`; this is how to *do* it.

> ⛔ **Nothing here may be produced by a model.** Ground truth generated from detector output scores
> a detector against itself and measures nothing. If you cannot tell what something is, mark it by
> the rules below — never ask the platform.

---

## 0. Before you start

```
python3 real_footage_cli.py --extract-frames .data/real/take-01.mp4 \
    --frames-out .data/real/take-01-frames --clip-id take-01-spine
```

This writes `frame-00000.png …`, a `frames.json`, and `annotations.skeleton.json` already containing
one entry per frame.

⚠️ **Annotate the extracted PNGs, never the video.** They are the exact frames the benchmark scores,
numbered as it numbers them, so your `frameIndex` and its `frameIndex` cannot drift apart.

⛔ **Copy the `effectiveFps` the tool prints into `annotatedFps`.** It is *not* 2.0 — a 30 fps clip
gives 2.000, a 27 fps clip gives 1.929. Guessing gets your file refused after the work is done.

---

## 1. Person bounding boxes

Draw the **tightest rectangle containing every visible part of the person** — including a raised hand
and any limb sticking out, excluding shadow and reflection.

- Coordinates are **normalized `[0,1]`**: `x = left ÷ image width`, `w = box width ÷ image width`.
  ⛔ Pixel coordinates are refused at parse time; they would score every frame as a total miss.
- `label: "person"`.
- ⭐ **Box what you can see, not what you know is there.** If the legs are behind a table, the box
  stops at the table. The detector cannot see through furniture and must not be penalised for it —
  the fact that the person continues is carried by `visibility`, not by the rectangle.

## 2. `gtId` — identity within this clip

An integer, stable for one subject across the whole clip. The first person is `1`, the object they
carry is `2`, a second person is `3`.

- ⭐ **Keep the same number through occlusion and through leaving and re-entering the frame.** It is
  the same person; that is precisely the thing tracking is being measured on.
- ⛔ **It means nothing outside this clip.** `gtId: 1` in another take is a different person. Any
  cross-clip identity claim is re-identification and is governed by ADR-0055.
- One `gtId` may appear **only once per frame** — the checker rejects a subject in two places at once.
- A `gtId` may never change `label` between frames.

## 3. `visibility`

| Value | Use when |
| --- | --- |
| `fully-visible` | the whole subject is in shot and unobstructed |
| `partially-occluded` | something hides part of them, **or** they are partly outside the frame |
| `heavily-occluded` | less than roughly a third is visible |

⚠️ This is not confidence in your own annotation. It is a fact about the pixels, and it is what makes
"recall on occluded subjects" a separate question from "recall".

## 4. Entering and leaving the frame — ⛔ the convention that decides the number

A subject entering or leaving is a *sliver* at the edge for several frames. **Where you stop drawing
sets the recall score**, so the rule is fixed rather than left to judgement:

> **Draw the box while any part of the person is visible, however small. Mark it
> `partially-occluded` whenever the frame edge cuts them.**

⭐ This is deliberately the *strict* choice: it counts the hardest frames against the detector rather
than quietly excluding them. On the authored fixture every miss was exactly such a sliver — 5–37 px
of a 90 px subject — which is the honest result and the one worth knowing.

⛔ Do not "help" by omitting hard frames. A frame you skip is not neutral: it is excluded from
scoring entirely, and the average silently describes only the easy part of the clip.

## 5. Object boxes — bottle and bag

Same rules, `label: "bottle"` / `"backpack"` / `"handbag"`, each with its own `gtId`.

- Annotate the object **whenever it is visible**, including while it sits on the table before anyone
  touches it and after it is put down.
- ⭐ While it is carried, box **the object**, not the hand — they overlap, and that overlap is exactly
  what object association is later measured on.
- If the object is entirely inside a bag or a fist, it is **not visible**: stop drawing it. ⚠️ Do not
  guess its position; an invented box is a false negative charged to the detector for something it
  had no way to see.

## 6. ⭐ Empty-room frames — the negative control

The 5 s of empty room at each end are annotated as `"boxes": []` — **and that is a statement, not a
blank**.

⛔ It is what makes false positives measurable at all. Without those frames, a detector that
hallucinates people in a quiet room scores perfectly.

⚠️ The skeleton starts *every* frame as `"boxes": []`. That is a placeholder you must confirm or
replace, one frame at a time. An unreviewed empty frame in the middle of the clip charges every
correct detection in it as a false positive — the single most damaging mistake available here.

## 7. Wrist and hand keypoints

⛔ **Only for the frames listed below, and only after §1–§6 are complete for the whole clip.** Boxes
first: detector scoring must not wait on pose work.

Per person box, add:

```jsonc
"keypoints": [
  { "name": "left_wrist",  "x": 0.412, "y": 0.508, "visible": true  },
  { "name": "right_wrist", "x": 0.463, "y": 0.501, "visible": false }
]
```

Names: **`left_wrist`, `right_wrist`** — spelled exactly. Coordinates are the **joint centre**,
normalized `[0,1]`, like every other coordinate.

⛔ **There is no `hand` joint.** An earlier draft of this document listed `left_hand`/`right_hand`;
that was wrong. COCO-17 annotates the **wrist**, and a model trained on those labels cannot report
something they never contained. The validator now refuses any name outside the topology — the full
list is `perception.COCO_17`, and `python3 real_footage_cli.py --validate-annotations` prints it.

### Which frames
- Every frame of **step 7** (hands raised) — wrists clearly visible.
- Every frame of **steps 10–11** (pick up, carry) — wrists doing the thing that matters.
- Every frame of **steps 9 and 14** (bending to the table, walking behind it) — ⭐ **the occluded
  wrists, which are the point of the exercise.**
- The empty-room frames need nothing: no person, no keypoints.

### 8. ⛔ `visible` is not confidence, and ground truth carries no confidence at all

This is the distinction the whole pose evaluation turns on, so it is worth being exact:

| | Meaning | Who says it |
| --- | --- | --- |
| `visible: true` | you can **see** the joint in the pixels | you |
| `visible: false` | the joint is **there but hidden** — behind the body, the table, a bag | you |
| `confidence` | how sure the **model** was | ⛔ the model, never you |

- **Always give `x`/`y`, even when `visible: false`.** Put them where the joint actually is, to your
  best judgement from the arm's direction. A hidden wrist still has a position, and "did the model
  put the hidden wrist in the right place" is a question worth answering.
- ⛔ **Never write a `confidence` field.** A human is not uncertain in the way a model is; a number
  there would be compared against model confidence at scoring time and would mean something entirely
  different from what you intended.
- If you genuinely cannot tell where a joint is — the whole arm is out of shot — **omit that keypoint
  entirely**. Omitted and hidden are different facts, and the scorer treats them differently.

---

## 9. When you finish — ⭐ check it before anyone scores it

1. `annotator`: your name. `note`: anything ambiguous you decided, and how.
2. ⛔ Delete the `UNFILLED SKELETON` note — it is there so an unreviewed file cannot be mistaken for
   a finished one.
3. Save as `.data/real/take-01-spine.json`, beside the clip.
4. **Run the validator.** It takes seconds and it is the difference between finding a mistake now
   and finding it after the numbers are quoted:

```
python3 real_footage_cli.py --validate-annotations .data/real/take-01-spine.json \
    --case take-01-spine --real-root .data/real
```

`PASS` (exit 0) or `FAIL` (exit 1) with **every** problem listed — not just the first.

| It checks | Because |
| --- | --- |
| schema version | a field's meaning may have changed between versions |
| every box: label, `[0,1]` range, non-zero area, visibility enum | a pixel coordinate scores as a total miss |
| every keypoint: known joint, `[0,1]`, `visible` present and boolean, no duplicates, **no `confidence`** | see §8 |
| `gtId` consistency | one subject cannot be in two places in one frame, or change class |
| clip digest | ⛔ that these boxes describe *these* pixels |
| annotated rate vs the rate actually sampled | box 30 must mean the same instant on both sides |
| frame range | annotations beyond the analysed frames are not misses |
| case id | one clip's ground truth cannot score another |

⛔ It computes **no accuracy**, modifies nothing, and repairs nothing — it refuses rather than
producing a plausible result. ⚠️ Lines beginning `⚠️ NOT CHECKED` are disclosures, not failures:
without `--case` it cannot check digest, rate or range, and it says so rather than passing silently.

⚠️ Expect **~2 hours** for 120–180 frames of boxes, and roughly the same again for the keypoint
frames. ⛔ That cost is why only take-01 is annotated until it has been through the whole pipeline.
