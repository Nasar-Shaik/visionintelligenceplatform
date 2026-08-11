# The pose seam — design, P3.2c

**⛔ No pose model is declared, downloaded, catalogued or implemented, and nothing here authorises
one.** This documents the seam pose will arrive through, so that when it is approved the work is
integration rather than architecture.

⭐ **The headline: the seam already exists and is already load-bearing.** It was built at P-10 under
ADR-0050 and is used in production today by the behaviour analysers. Pose needs **no new contract, no
new stage, and no second inference pipeline.**

Pinned by `tests/test_perception.py::PoseSeamTests` — if those fail, this document is wrong.

---

## 1. What already exists

`ai/inference/perception.py`:

```python
@dataclass(frozen=True)
class Keypoint:
    name: str
    x: float            # normalized [0,1], like every other coordinate
    y: float
    confidence: float = 1.0
    visible: bool = True

@dataclass(frozen=True)
class RawInstance:
    score: float
    bbox: Optional[Tuple[float, float, float, float]] = None
    class_id: Optional[int] = None
    label: Optional[str] = None
    keypoints: Sequence[Keypoint] = ()
    skeleton: Optional[str] = None      # e.g. "coco-17", named once per instance
    mask: Optional[Mask] = None
    embedding: Optional[Sequence[float]] = None
    ...
```

Everything the brief asks pose to produce — **keypoint, confidence, visibility, per-person pose
attributes** — is already in the vocabulary, and `visible` is deliberately **separate from**
`confidence`:

> ⚠️ A joint the model is sure is *hidden* (occluded by a shelf) is high-confidence and not visible; a
> joint it merely guessed at is low-confidence. Collapsing them loses the distinction that occlusion
> reasoning — and therefore shelf interaction — is built on.

That distinction is the single most valuable thing already decided here, and it is the one most
commonly lost by pose formats that ship a single per-joint score.

---

## 2. How pose attaches to the existing detection and identity path

```
   frame ──▶ adapter.infer() ──▶ ┌─ RawDetection[]        (today, unchanged)
                                 └─ PerceptionOutput      (a pose model)
                                        │
                     to_raw_detections() │  ⚠️ lossy, deliberately
                                        ▼
   postprocess ──▶ tracker ──▶ identity ──▶ behaviour ──▶ graph ──▶ rules ──▶ incident
                                        ▲
                     to_attributes() ───┘   keypoints ride in Detection.attributes["pose"]
```

⭐ **The box is what the rest of the platform consumes.** A pose model's person box narrows to an
ordinary `RawDetection` and flows into tracking, identity, association and every behaviour primitive
**unchanged** — so pose does not fork the pipeline, it enriches a record already travelling down it.

⛔ `RawDetection` has four slots and must not grow a fifth: it is the contract every decoder agrees
on, and widening it would make every existing decoder responsible for a field it will never produce.
Keypoints ride in `Detection.attributes`, which the TypeScript contract declares as an open record
(`z.record(z.string(), z.unknown())`) — **so no frozen contract changes.**

⚠️ An instance with no bbox is **dropped**, not placed at the origin — a zero box reads as a real
observation of something in the top-left corner.

---

## 3. ⛔ The one connection that does not exist yet

The vocabulary and both bridges (`from_raw_detections`, `to_raw_detections`) are built and tested.
**`video_analyzer` does not yet call them.** Today:

```python
raw  = self._adapter.infer(prepared)                       # RawDetection[]
dets = self._postprocessor.run(raw, ctx, opts.min_confidence)
```

An adapter returning a `PerceptionOutput` would not be understood. The whole of pose integration is
therefore:

1. At that call site, detect a `PerceptionOutput` and narrow it with `to_raw_detections`.
2. Carry each instance's `to_attributes()` onto the matching `Detection` after post-processing.
3. Register a `pose-estimation` decoder in `model_formats` — the same seam RT-DETR used, which
   required **zero changes above `adapters/model_formats.py`**.
4. One catalogue entry, with licence and checksum, subject to the licensing gate.

⭐ **Three files, none of them a new stage, service, or pipeline.** ⚠️ If pose turns out to need a
change to `pipeline.py`, `capability.py` or `perception_registry.py`, **the design is wrong and that
is the finding** — the same test slice 2.2 applied to behaviour.

---

## 4. ⛔ What pose must never emit

Pose produces **observations of body configuration**. Nothing more.

| Permitted | Forbidden |
| --- | --- |
| `left_wrist at (0.31, 0.44), confidence 0.81, not visible` | `reaching` |
| `wrist-to-shelf distance 0.04 normalized` | `concealment` |
| `torso angle 41° from vertical` | `suspicious`, `intent`, `theft` |

A pose model that emits `"concealing"` has made a domain judgement inside perception, and no operator
can disagree with it against the video. ⭐ **The test for every Phase 3 capability: can an operator
disagree with it?** A keypoint and a threshold can be checked against a frame; a verdict cannot.

Meaning stays in rules (ADR-0052). The eventual theft chain reads:

```
person enters shelf zone → approaches object → object associated with person →
object leaves shelf zone → person carries object → approaches exit →
no checkout evidence → rule evaluation → potential incident
```

Every step there is a geometric fact with a published threshold. Pose adds facts to that chain; it
never adds the conclusion.

---

## 5. Recommended first evaluation, when it is approved

⚠️ **In the benchmark lab, never in production.** The lab exists so a model is measured before it is
deployed, and pose is the first capability where "it ran" and "it was right" differ dramatically.

1. **Two candidates, both permissively licensed** — the licensing gate applies unchanged, and
   `Do NOT silently treat "open source" as "commercially unrestricted"` governs.
2. **Top-down vs bottom-up matters more than the leaderboard.** A top-down model runs once per
   person box (cost scales with crowd size; accuracy holds under occlusion); a bottom-up model runs
   once per frame (constant cost; degrades when people overlap). ⭐ The retail case is *occlusion with
   few people*, which argues for top-down — and top-down also reuses the detector box we already
   have, keeping one pipeline.
3. **Measure on the annotated real footage from this slice**, with keypoints added at Tier-1 (the
   schema already accepts them, so no re-annotation).
4. **Report PCK@0.2 and per-joint accuracy**, plus latency at 2 fps against the 41.2 ms detector
   budget. ⛔ Wrists and hands specifically: a pose model that is excellent on hips and poor on wrists
   is useless for every retail question, and an aggregate score hides exactly that.
5. **The negative control**: frames with no person. A pose model that hallucinates a skeleton in an
   empty aisle is worse than none, because it produces a confident geometric fact from nothing.

**Precondition, in one line:** annotated real footage. Pose cannot be evaluated on the authored
corpus — there is no body in it.
