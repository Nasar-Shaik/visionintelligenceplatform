# Phase 2 — implementation plan and verification strategy

**Behaviour Engine (P-11).** The architecture is [BEHAVIOUR_ENGINE](BEHAVIOUR_ENGINE.md); the two
decisions it rests on are [ADR-0051](../adr/ADR-0051-track-history-becomes-durable.md) and
[ADR-0052](../adr/ADR-0052-behaviour-reasoning-is-not-perception.md).

> ⭐ **The order below is the Architect's, with one change and two gates**, each argued rather than
> assumed. Nothing here is implemented.

---

## 1. The plan at a glance

| Slice | What ships | Blocked by | Gate before starting |
| --- | --- | --- | --- |
| **2.1** | Persistent track history + motion primitives | — | — |
| **2.2** | Behaviour primitive seam (`register_task("behaviour")`) + zone/relational primitives | 2.1 | — |
| **2.3** | ⛔ **Detector benchmark on a quiet host** | — | Runs *before* any new model is chosen |
| **2.4** | Pose plugin | 2.3 | ⛔ **Compute gate** — §4 |
| **2.5** | Re-identification embeddings | 2.3 | Compute gate |
| **2.6** | Segmentation plugin | 2.4, 2.5 | Compute gate |
| **2.7** | Object memory | 2.6 + ⛔ **an object detector that does not exist** | §5 |
| **2.8** | Behaviour graph | 2.2, 2.5, 2.7 | — |
| **2.9** | Retail rule pack (Layer 3) | 2.8 | Ships as **rules**, not runtime code |

### The one change to the requested order

**Re-identification (item 4) moves ahead of segmentation (item 3).**

⭐ **Reason: re-id is the cheapest item with the highest downstream leverage, and segmentation's main
consumer is object memory, which is blocked anyway.** `Detection.embedding` is already a frozen
field, so re-id needs no contract work; it unblocks `appearance_continuity`, cross-camera candidacy
and — critically — the ability to say *the same object* after an occlusion, which object memory needs
and segmentation alone cannot provide. Building segmentation first produces class-agnostic masks that
nothing can follow across a gap.

⚠️ If the Architect prefers the original order, the cost is that 2.6 delivers masks with no consumer
until 2.5 lands anyway.

### The two inserted gates

**2.3 — benchmark first.** Workstream B built the framework and deliberately ran nothing, because the
host was at 496 % CPU. Choosing a pose model before that runs would be choosing on upstream marketing
figures. It costs a few hours on a quiet machine.

**Compute gate before 2.4** — see §4. It has a pass/fail number, not a judgement.

---

## 2. Slice 2.1 — persistent track history

**Ships:** a durable `TrackHistory` record keyed by `identityId`; motion primitives (`trajectory`,
`velocity`, `direction`, `path_length`, `dwell_in_zone`) as pure functions; tenant-scoped retention
and erasure.

**Deliberately not shipped:** the behaviour graph, any per-frame detection persistence
(ADR-0049 stands for those), embeddings.

⛔ **The three defects this slice is most likely to ship**, each with the check that catches it:

| Defect | Check |
| --- | --- |
| Accumulating by `trackingId` instead of `identityId` — sees two short visits as one person walks behind a display | A test with a **scripted occlusion**: one person, one occlusion, assert **one** identity with the full dwell, not two halves |
| Time derived from frame counts, when age advances per frame and `CAMERA_IDLE_SECONDS = 300` | The same footage at 1 fps and 4 fps must yield the **same dwell in seconds** |
| Velocity reported as a speed when coordinates are normalized | The API names the unit; two cameras with different fields of view are asserted to disagree, and the test says that is correct |

---

## 3. Slice 2.2 — the primitive seam

**Ships:** `register_task("behaviour", …)`, primitives as `PerceptionModule`s returning
`PerceptionOutput`, and the zone/relational set (`zone_transition`, `proximity`, `overlap`,
`co_presence_duration`, `occupancy_count`).

⭐ **No new contract, no new stage.** The P-10 registry already accepts a task nobody designed for,
and `FrameLabel` already carries a boxless statement about the scene. If this slice needs either
widened, the P-10 design was wrong and that is the finding.

**The domain-neutrality test is executable**: a test asserts that no primitive's name or output
vocabulary contains a domain word (`shelf`, `theft`, `patient`, `pallet`). ⚠️ Crude, and it catches
the exact regression that matters — a retail concept leaking into Layer 2.

---

## 4. ⛔ The compute gate (before 2.4)

Measured in P-9: detection alone is **57.0 ms/frame** and **949 % CPU at 25 fps**; the `crowd`
scenario holds **8.00 detections/frame**. Pose, segmentation and re-id are **per person**, so at 8
subjects they are up to 24 additional inferences per frame.

**The gate, stated as a number before the work starts:**

> A pose plugin passes if, on the deployment host, the **live path still meets 4 fps with an
> end-to-end p95 under 200 ms** on the `crowd` scenario, with pose enabled at whatever rate it needs.

⚠️ **If it fails, that is a result, not a blocker to route around.** The recorded response, in order:
run per-person models at a **lower rate than detection** (pose at 1 fps against detection at 4 fps —
behaviour is slower than motion); **gate on zones** so pose runs only for subjects in a shelf region;
and if neither suffices, **declare GPU a requirement for the pose-and-beyond stack** before a
customer discovers it.

⛔ **What must not happen is the gate quietly moving.** It is written here, before the measurement,
for that reason.

---

## 5. Slice 2.7 — ⚠️ a correction to an earlier claim in this document

**This section previously said object memory was blocked on "a detector that does not exist". That
was wrong in an important way**, and the Architect's own diagram — which named *Bottle* — is what
exposed it.

The shipped COCO-80 detector already sees both halves of the problem:

| | COCO class id | Role |
| --- | ---: | --- |
| `person` | 0 | the subject |
| **`bottle`** · `cup` · `wine glass` | **39** · 41 · 40 | a takeable object |
| **`backpack`** · `handbag` · `suitcase` | **24** · 26 · 28 | ⭐ a container to conceal it in |

And `shelf` is **not a detection at all** — it is an operator-drawn **zone**, which the platform
already has. Detecting shelves was never the requirement.

⭐ **So the whole chain — approach, pick, conceal, leave without passing the till — is buildable and
verifiable today**, with a bottle and a backpack, on the shipped model. `labels` is a lookup table,
not a filter; the model always emits all 80 classes.

⚠️ **What is genuinely missing is merchandise *variety*, and accuracy on it.** A cereal box, a razor
pack and a joint of meat are not COCO classes, and `yolox-nano` scores 25.8 COCO AP overall — small
objects held in a hand under CCTV optics are the hardest case it faces. So:

- **The engine is unblocked.** Build and verify it with bottles and backpacks.
- **Coverage is not.** A production retail deployment needs open-vocabulary detection or
  per-customer fine-tuning, both costed in [BEHAVIOUR_ENGINE §5](BEHAVIOUR_ENGINE.md), and the
  accuracy question needs the benchmark corpus before any promise is made to a customer.

⚠️ Slices 2.1–2.6 and 2.8 remain worth building regardless: queue analytics, loitering, occupancy,
fall detection and PPE need none of this.

---

## 6. Verification strategy

**The standing rule this phase inherits:** *an instrument that cannot fail is not an instrument.*
Seven instrument failures were found in P-9 and A2, five of them by the shape of a number rather than
by a check.

### Per slice, three obligations

| | |
| --- | --- |
| **A negative control that reads zero** | Every primitive must be shown producing **nothing** where nothing is happening — `empty-room` produced 0 detections across 73 frames and that is why the P-9 matrix is believable. A dwell primitive that reads 0.0 s because its history buffer was empty is indistinguishable from a person who did not linger |
| **A demonstrated failure** | The check is mutated and must go red on the assertion that owns the claim. Assertion-flipping is not evidence |
| **Determinism** | Injected clock, injected history, no network, no camera, no threads. The same footage twice must produce the same primitives — ⚠️ and offline replay never moves footage time, so anything keyed on camera + timestamp breaks on the second run |

### Phase-specific checks

- ⛔ **The occlusion test is mandatory in every accumulating primitive.** One person, one occlusion,
  one identity — not two.
- ⛔ **The frame-rate invariance test.** The same clip at 1 fps and 4 fps must produce the same
  durations in seconds.
- ⛔ **Prove each primitive can move before trusting a clean run.** A velocity of 0.0 from an empty
  buffer, and a `holds` edge that never fires, both read as "the behaviour did not occur".
- **Cross-model localisation**, reused from A2: where a second model exists, agreement on *where*
  rather than *how many* is the check that verifies geometry.
- **Deployment verification**, per the standing rule: measured against the built stack through
  `https://localhost`, never `pnpm dev`.

### What will not be claimed

⛔ **Accuracy of any behaviour primitive**, until an annotated corpus exists. A dwell time computed
from unlabelled footage is a number, not an accuracy. ⛔ **Cross-camera identity**, until a
calibrated topology exists — embedding similarity alone will confidently link two different people in
similar jackets.

---

## 7. Definition of done, per slice

1. Automated tests, including the negative control and the demonstrated failure.
2. Documentation updated in the same commit — architecture, capability matrix, MASTER_PROGRESS.
3. Verification run against the **deployed** stack where the slice touches it.
4. Benchmark where a model is involved, on a **quiet host**.
5. ⛔ No new service, no new pipeline stage, no change to the five frozen contracts, no business
   logic in the runtime.
