# Pose Foundation — interface design

**Design only. No pose inference is implemented, and none is authorised by this document.**

> ⭐ **The contract is already in place.** `perception.py` defines `Keypoint`, the `skeleton`
> topology name, and the route pose takes to the platform — `Detection.attributes["pose"]`. What is
> missing is a model, not an interface. This document is what a pose plugin must satisfy.

---

## 1. The interface

```python
RawInstance(
    score=0.86,
    bbox=(0.31, 0.22, 0.12, 0.44),          # the person; normalized [x, y, w, h]
    keypoints=[Keypoint("nose", 0.36, 0.25, confidence=0.95, visible=True), ...],
    skeleton="coco-17",                      # the topology, named once
)
```

| Decision | Why |
| --- | --- |
| Coordinates normalized `[0,1]` | The same convention as `bbox`. ⚠️ Two coordinate conventions in one document is a defect nobody notices until they diff two renderings |
| `skeleton` names a topology | The edge list is a property of the convention, not of each person. Two instances in a frame cannot disagree about it |
| `confidence` **and** `visible` | ⛔ Different questions. A joint the model is sure is *hidden* behind a shelf is high-confidence and not visible; a joint it guessed at is low-confidence and "visible". Collapsing them destroys exactly what shelf-interaction reasoning is built on |
| Rides in `attributes` | No frozen contract changes (ADR-0050) |

## 2. Derived outputs — and where they belong

**Body orientation** and **posture** are *derived*, not perceived. A pose model returns joints; a
consumer decides that shoulder-hip geometry means "facing the shelf" or "bent over".

⛔ **That derivation does not belong in the runtime.** The guardrail is that the runtime stays
perception-only, and "is this person bending" is one short step from "is this person stealing". Pose
modules emit joints; interpretation is a `BehaviorAnalyzer` — a seam that already exists
(`behavior_registry.py`).

⚠️ **Orientation from a single camera is ambiguous by construction.** Front-facing and back-facing
skeletons are near-identical in 2D from a top-down CCTV mount, which is the mount retail actually
uses. Any orientation output must carry its own confidence and must not be presented as a fact.

## 3. Topologies

Start with **COCO-17** (the widest model support). ⚠️ It has **no spine and no fingers** — so
"reaching toward a shelf" is inferred from wrist-relative-to-shoulder, not observed. Whether that is
sufficient is an empirical question for the benchmark corpus, not something to decide on paper.

Registering a second topology (Halpe-26, MPII-16) is a string; a consumer that hard-codes joint
*indices* rather than names will break silently when it changes. **Joints are addressed by name in
this contract for that reason.**

## 4. Cost, which decides whether this is viable at all

Measured P-9 baseline: `yolox-nano` inference is **57.0 ms of an 87.3 ms** end-to-end path, at ~42 %
of a core per fps, saturating a 10-core box at ~25 fps for one camera.

⚠️ **Top-down pose is a second model over every person, not over every frame** — cost scales with
occupancy. A crowd scenario measured **8.00 detections/frame**; eight pose inferences per frame on
the same box is not affordable at 4 fps on CPU. **The first honest question for a pose milestone is
not "which model" but "at what rate, on what hardware, for how many people"** — and the answer must
come from the benchmark corpus, on the crowd scenarios, before any integration work.

## 5. Verification a pose milestone must include

- **A negative control**: an empty frame must produce zero skeletons, and the check must be shown
  capable of failing.
- **Occlusion cases**: the `occl-*` scenarios already exist and already have ground truth.
- ⛔ **A rotated-camera case.** P-9 found a camera mounted 90° from upright detects **nothing** (L-74).
  A pose model will likely fail the same way, and it must be measured rather than assumed.
