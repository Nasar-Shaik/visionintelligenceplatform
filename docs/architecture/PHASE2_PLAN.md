# Phase 2 — implementation plan and verification strategy

**Behaviour Engine (P-11).** The architecture is [BEHAVIOUR_ENGINE](BEHAVIOUR_ENGINE.md); the two
decisions it rests on are [ADR-0051](../adr/ADR-0051-track-history-becomes-durable.md) and
[ADR-0052](../adr/ADR-0052-behaviour-reasoning-is-not-perception.md).

> ⭐ **The order below is the Architect's, with one change and two gates**, each argued rather than
> assumed. Slices 2.1–2.3 are implemented and deployed; everything from 2.3b on is not.

---

## 1. The plan at a glance

| Slice | What ships | Blocked by | Gate before starting |
| --- | --- | --- | --- |
| **2.1** | ✅ Motion primitives, as pure functions | — | — |
| **2.2** | ✅ The seam (`register_task("behaviour")`), the four modules on the live path, durable track history, multi-class verified | 2.1 | — |
| **2.3** | ✅ Zone propagation (ADR-0053), the `SceneObservation` carrier (ADR-0054), the Behaviour API and the Behaviour Timeline | 2.2 | — |
| **2.3b** | ⛔ **Detector benchmark on a quiet host** | — | Runs *before* any new model is chosen |
| **2.4** | Pose plugin | 2.3b | ⛔ **Compute gate** — §4 |
| **2.5** | Re-identification embeddings | 2.3b | Compute gate |
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

**2.3b — benchmark first.** Workstream B built the framework and deliberately ran nothing, because the
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

### ✅ What actually shipped, and the three findings

**The prediction held.** `register_task("behaviour", …)` needed no change to `perception.py`,
`perception_registry.py` or the pipeline, and `StageChain` — itself `Tracker`-shaped — put a second
stage in the one slot that already existed. Per-subject facts ride in
`Detection.attributes["behaviour"]` and reach the events store intact, verified on the deployed
stack over real footage.

⛔ **Finding 1 — `FrameLabel` has nowhere to go.** ✅ Closed in slice 2.3 by
[ADR-0054](../adr/ADR-0054-a-scene-observation-is-not-a-detection.md): `DetectionResult.scene`, an
optional additive field at schema 1.2. As shipped in 2.2 the contract could *express* a scene-level
statement and had no frame-level open map to carry one — only `Detection.attributes`, which is per
subject, so occupancy and handover left through `GET /tracking/behaviour` rather than on the frame.
⚠️ Nothing was ever lost for a rule that wants a handover — the per-object `association.heldBy` array
shows the object changing hands and *does* ride the detection — but the asymmetry was real, and it was
recorded rather than papered over until a decision could be taken.

⛔ **Finding 2 — zone membership arrives one hop too late.** ✅ Closed in slice 2.3 by
[ADR-0053](../adr/ADR-0053-zone-membership-returns-as-an-observation.md); the three costed options
and the one taken are in [BEHAVIOUR_ENGINE §5b](BEHAVIOUR_ENGINE.md).

⛔ **Finding 3 — two defects that only a deployment could find**, both in slice 2.2's own code: a
root-owned Docker volume against a uid-999 runtime, and — much worse — a history write failure that
propagated into the perception path and answered **HTTP 500 on every frame** while the container
reported healthy. Both fixed, both regression-tested, and the second changed a design rule: *a
secondary duty must never be able to stop the primary one.*

**The domain-neutrality test is executable**: a test asserts that no primitive's name or output
vocabulary contains a domain word (`shelf`, `theft`, `patient`, `pallet`). ⚠️ Crude, and it catches
the exact regression that matters — a retail concept leaking into Layer 2.

---

## 3b. ✅ Slice 2.3 — the infrastructure before reasoning

**Ships:** zone propagation ([ADR-0053](../adr/ADR-0053-zone-membership-returns-as-an-observation.md)),
the `SceneObservation` carrier ([ADR-0054](../adr/ADR-0054-a-scene-observation-is-not-a-detection.md)),
`GET /api/behaviour/primitives`, `GET /api/behaviour/timeline`, and the zone-evaluation metrics media
had been computing since P-8 Phase 7 and publishing nowhere.

**Both of slice 2.2's findings are closed, and each cost one decision rather than one workaround:**

| Finding | Closed by | ⚠️ |
| --- | --- | --- |
| Zone membership arrives one hop too late | Membership returns as an **observation** on the next frame | ⛔ Not the zone plan going the other way — that would have put a second polygon engine in the platform, and the first disagreement would be unresolvable |
| `FrameLabel` has nowhere to go | An optional `scene[]` on `DetectionResult`, schema **1.2** | ⚠️ The frozen contract's own additive path, carried on the `FrameContext` that already reached every stage — no new stage, no widened protocol |

⭐ **The read APIs recompute; they store nothing.** Track history is the one durable substrate, and
`primitives_for` runs *the same four modules the live path runs*, so Layer 2 cannot drift into two
implementations. The Behaviour Timeline is a projection over the same functions.

⛔ **What slice 2.3 taught, and it is the same lesson three times: the ambiguity between "no" and
"not yet" is where the plausible wrong numbers live.**

1. `zoneIds: []` (decided: inside nothing) versus no key (undecided) — collapsing them emits a `left`
   transition on every frame for a subject standing still.
2. `occupancy: 0` on a stream with no subjects at all — a camera that is down, a stage that never
   ran and an empty shop rendered identically. **Slice 2.2 shipped this**; a slice 2.3 test found it.
3. The echo join keyed on the runtime's private frame counter rather than the caller's `frame.seq` —
   off by one, on every frame, producing a dwell short by exactly one interval.

⚠️ Plus one that was only visible on real footage: timeline instants printed as `1.77109e+09 s`,
because a recording stamped with wall-clock capture times has footage seconds in the billions. The
durations were right and every instant was unreadable.

**Verified on the deployed stack** with two operator-drawn zones on a real camera, over the uploaded
recording *and* over the live `FrameSink.push` path: `zoneMembership: present` on both, 23 and 25
memberships applied, 0 and 1 missed, 37 and 40 echoes sent, 0 dropped, dwell of 15.0 s and a
two-visit 6.5 s, three entries and two exits, 191 scene observations, and 98 durable records
surviving a container replacement.

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
