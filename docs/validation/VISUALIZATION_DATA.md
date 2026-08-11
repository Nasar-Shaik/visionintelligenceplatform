# Visualization data contract — design, P3.2c

**⛔ No UI work is authorised by this document.** It defines what the eventual live/recorded overlay
must be *driven by*, and — more importantly — what it must never invent.

> ⭐ **The rule the whole document exists for: every pixel drawn must correspond to something the
> runtime observed.** A frontend that interpolates a skeleton between two frames, or draws a
> smoothed trajectory the tracker never produced, is generating evidence. The overlay is an
> investigation surface: an operator uses it to *disagree* with the platform, which is impossible if
> the picture is partly the frontend's own opinion.

---

## 1. What the runtime already publishes

⚠️ Most of this exists today. The column that matters is the last one.

| Datum | Source | Available? |
| --- | --- | --- |
| **Bounding box** | `Detection.bbox` — `[x, y, w, h]` normalized `[0,1]` | ✅ today |
| **Confidence** | `Detection.confidence` | ✅ today |
| **Class label** | `Detection.label` | ✅ today |
| **Identity** | `Track.trackId` (stable; ⛔ never reused — re-entry is a *link*) | ✅ today |
| **Track state** | `Track.state` — `created` · `tentative` · `confirmed` · `lost` · `removed` | ✅ today |
| **Trajectory** | `Track.history[]` → `{frameIndex, at, bbox, centroid}` | ✅ today |
| **Frame / time reference** | `frameIndex` + `at` on every history point; `timestamp` in frame meta | ✅ today |
| **Object boxes** | same `Detection` record — objects are tracked identities too | ✅ today |
| **Object ↔ person association** | `associations()` spans, with the reason and the distance | ✅ today |
| **Quality** | `Track.quality` — `trackingConfidence`, `predictionFrames`, `lostFrames` | ✅ today |
| **Skeleton / keypoints** | `Detection.attributes["pose"].keypoints[]` + `skeleton` | ⛔ **contract ready, no producer** |

⭐ **Only one row is missing, and it is missing a *model*, not a contract.** See `POSE_SEAM.md`.

---

## 2. The overlay's rules

### ⛔ Never interpolate

The runtime analyses at **2 fps** while the video plays at 25–30. The overlay therefore has a box for
roughly every twelfth displayed frame.

- **Permitted:** hold the last observed box until the next observation, and show the analysed frame
  index it came from.
- **Permitted:** a visible "no observation for this frame" state.
- ⛔ **Forbidden:** interpolating a box or a keypoint between two analysed frames. It looks better and
  it is a fabrication — and it would be *most* wrong exactly when the subject moves fastest, which is
  when an operator is looking hardest.

### ⛔ Never draw a joint the model did not report

A skeleton is drawn from `keypoints[]`. A joint absent from the array is **not drawn**; a joint with
`visible: false` is drawn distinctly (dashed, dimmed) rather than as a normal joint or omitted
entirely — the model *inferred* it, and hiding that loses the occlusion signal the retail case is
built on.

⚠️ Edges come from the `skeleton` topology name (`"coco-17"`), never from a hardcoded frontend edge
list — two instances in one frame cannot disagree about the convention, and a frontend list would
silently mis-draw the first model that uses a different one.

### ⚠️ Show confidence, do not filter by it

The runtime already applied the capability's floor (`confidenceThreshold`, published with the
result). The overlay's job is to show what was admitted and how strongly — a second, invisible
frontend threshold would make the picture disagree with the evidence record for reasons nobody can
reconstruct.

### ⚠️ Identity colour must come from the identity

Colour keyed on `trackId`, stable for a track's whole life. ⛔ Never keyed on array position: the
detection order is not stable between frames, and a subject that changes colour mid-clip reads as an
identity switch that never happened.

---

## 3. The association overlay — the one with teeth

An object box linked to a person box is a **claim**, and the operator must be able to check it:

- draw the link only while an association span is open;
- publish the **reason** and the **distance** the association was made on, as `associationDiagnostic`
  already does;
- ⭐ when association is **ambiguous** — two people reaching for one object — show it as ambiguous
  rather than picking one. `AssociationModule` has warned since it was written that "two people
  reaching at once will make the association alternate, and that alternation is a signal a rule
  should read as ambiguous". An overlay that renders whichever side won that frame turns a known
  uncertainty into a confident-looking picture.

---

## 4. ⛔ What the overlay must never render

| Never | Why |
| --- | --- |
| A skeleton the frontend generated or smoothed | It is evidence the platform did not produce |
| An interpolated box between analysed frames | Most wrong exactly when it matters most |
| A trajectory smoothed or extrapolated beyond `history[]` | The tracker's own uncertainty is the point |
| A word like *theft*, *suspicious*, *concealment* on a perception overlay | Perception states observations; rules state meaning (ADR-0052) |
| An identity merged across cameras or clips | A re-identification claim, gated by ADR-0055 |
| A box with no frame reference | Unfalsifiable against the video |

---

## 5. Acceptance test for the eventual UI

⭐ **Freeze the video on any analysed frame. Every drawn element must be traceable to one record in
that frame's payload — and an operator with the raw JSON must be able to confirm each one by hand.**

If something on screen cannot be traced to a runtime observation, it is not a visualization defect;
it is fabricated evidence, and it invalidates the investigation surface the whole platform exists to
provide.
