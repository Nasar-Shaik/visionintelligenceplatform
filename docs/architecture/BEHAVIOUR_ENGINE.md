# Behaviour Engine — architecture

**Layers 1 and 2 are implemented and deployed (P-11 slice 2.2). Layer 3 is design only.**
Item 1 (persistent track history) and the domain-neutral primitive set run on the live production
path; items 2–7 are unbuilt and the sequencing is in [PHASE2_PLAN](PHASE2_PLAN.md).

> ⭐ **The engine's purpose is to make theft detection unnecessary to special-case.** Every capability
> the platform will be asked for — retail concealment, hospital fall, warehouse pallet movement,
> school corridor crowding, factory PPE — is the same small set of geometric and temporal facts read
> under different rules. This document specifies that set.

---

## 1. Three layers, and the line that matters

[ADR-0052](../adr/ADR-0052-behaviour-reasoning-is-not-perception.md) fixes the boundary:

```
┌ Layer 1 · PERCEPTION ────────────────────────────── runtime, perception registry (P-10) ┐
│  detection · pose · segmentation · re-identification · OCR                              │
│  emits OBSERVATIONS — "a person, here, with these joints"                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
┌ Layer 2 · BEHAVIOUR PRIMITIVES ─────────────────── runtime, domain-neutral, reusable ────┐
│  trajectory · velocity · direction · dwell · proximity · zone transition                 │
│  hand-object association · object ownership · appearance continuity                      │
│  emits FACTS about geometry and time — "this hand was within 4 cm of that object for 2 s" │
└─────────────────────────────────────────────────────────────────────────────────────────┘
┌ Layer 3 · DOMAIN REASONING ─────────────────────── rules engine, per tenant, per pack ───┐
│  shelf interaction → concealment → no-checkout → alert                                   │
│  the ONLY layer that names an intent                                                     │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

⛔ **The test for Layer 2 membership: can a hospital use it?** `dwell_in_zone` passes — a hospital
calls it *waiting*, retail calls it *queueing*, a factory calls it *idle*. `concealment` fails, and
that failure is the signal it belongs in Layer 3.

### Where the Architect's seven items land

| # | Item | Layer | Depends on |
| --- | --- | --- | --- |
| 1 | Persistent track history — ✅ **shipped, slice 2.2** | **2** | Nothing new — the runtime already computes it and discards it |
| 2 | Pose plugin | **1** | Perception registry (exists) · ⚠️ compute (§4) |
| 3 | Segmentation plugin | **1** | Perception registry (exists) · ⚠️ compute |
| 4 | Re-identification embeddings | **1 + 2** | `Detection.embedding` (frozen field, exists) |
| 5 | Object memory | **2** | ⛔ **an object detector that can see merchandise — does not exist** (§5) |
| 6 | Behaviour graph | **2** | 1, 4, 5 |
| 7 | Retail reasoning | **3** | 6 — and it is a **rule pack**, not runtime code |

---

## 2. The primitive interface — one seam, already built

Every Layer 2 primitive registers through the **P-10 perception registry** and returns a
`PerceptionOutput`. Nothing new is invented:

```python
register_task("behaviour", "Geometric and temporal facts derived from tracked subjects")

registry.register("behaviour", "dwell", lambda: DwellPrimitive())
```

| Statement about | Carried in | Example |
| --- | --- | --- |
| A subject | `RawInstance.attributes` | `{"dwell": {"zone": "z_till", "seconds": 47.2}}` |
| The scene | `FrameLabel` | `FrameLabel("queue_length", confidence=1.0, attributes={"n": 6})` |
| A span of time | `FrameLabel.span` | `FrameLabel("stationary", span=(120, 400))` |

⭐ **No new pipeline stage and no second inference path.** A primitive is a `PerceptionModule` that
consumes tracks rather than pixels — which is why the P-10 contract was built with `bbox` optional
and `FrameLabel` boxless.

### The primitive set

**Motion** — `trajectory` · `velocity` · `acceleration` · `direction` · `path_length`
**Occupancy** — `dwell_in_zone` · `zone_transition` · `entry` · `exit` · `occupancy_count`
**Relational** — `proximity(a,b)` · `overlap(a,b)` · `approach_rate` · `co_presence_duration`
**Manipulation** — `hand_object_association` · `object_ownership` · `object_state_change`
**Identity** — `appearance_continuity` · `reappearance_link` · `cross_camera_candidate`

⚠️ **Every one is a pure function over track history.** None needs a new model except where Layer 1
supplies it (pose for hands, re-id for appearance). That is what makes them cheap and testable.

---

## 3. ⛔ The defect this phase is most likely to ship

**`identityId`, never `trackingId`.**

A person briefly occluded returns with a **new** `trackingId` — [ADR-0038](../adr/ADR-0038-track-identity-across-gaps.md)
forbids reuse. Every primitive that *accumulates* — dwell, path length, co-presence, ownership
duration — must group by `identityId` or it sees **two short visits instead of one long one**.

⚠️ The failure is silent and the number is plausible. A loitering rule with a 60-second threshold
simply never fires for anyone who walks behind a display, and the report shows normal dwell times.

**Two further traps, both found by reading the runtime rather than by any test:**

- ⛔ `CAMERA_IDLE_SECONDS = 300`, and **track age advances per frame, not per second**. A camera at
  1 fps ages tracks five times slower than one at 5 fps. Any primitive with a time threshold must
  derive it from footage timestamps, never from frame counts.
- ⛔ **Normalized coordinates are not metric.** Velocity in screen-widths-per-second is not speed,
  and two cameras with different fields of view will disagree about the same walk. Anything sold as
  a speed needs calibration (`coordinates.py` already defines the `CoordinateTransform` seam); until
  then the honest unit is normalized-per-second and it must be labelled that way in every API.

---

## 4. ⛔ The compute budget decides whether Phase 2 is possible at all

Measured in P-9, on the 10-core deployment host, CPU only:

| | |
| --- | ---: |
| `yolox-nano` inference, per frame | **57.0 ms** of an 87.3 ms end-to-end path |
| CPU at 25 fps, one camera | **949 %** — 9.5 of 10 cores |
| `crowd` scenario occupancy | **8.00 detections/frame** |

⚠️ **Detection is per frame. Pose, segmentation and re-id are per *person*.** At 8 people in frame,
adding all three is not three more models — it is up to **24 additional inferences per frame** on a
box already at 65 % of its budget in the detector alone.

⛔ **On this hardware, Phase 2 items 2–4 are not simultaneously viable at the live path's 4 fps.**
That is an arithmetic conclusion, not a pessimistic one, and the plan
([PHASE2_PLAN](PHASE2_PLAN.md)) is sequenced around it rather than through it. The three mitigations,
in the order they should be tried:

1. **Run per-person models at a lower rate than detection.** Pose at 1 fps against detection at 4 fps
   is sufficient for postural facts and cuts the cost fourfold. Behaviour is slower than motion.
2. **Gate on zones.** Pose only for subjects inside a shelf zone; most of a frame is floor.
3. **Accept GPU as a requirement for the full stack**, and say so before a customer discovers it.

⚠️ **No number in this section is a reason to skip measuring.** The benchmark framework from
Workstream B exists precisely to replace this arithmetic with results — and it must be run on a quiet
host before item 2 is committed to.

---

## 5. ⚠️ Object memory — a correction

> ⛔ **This section originally claimed object memory was blocked on "a detector that does not
> exist". That was wrong.** The shipped COCO-80 model already detects `bottle` (39), `cup` (41),
> `backpack` (24), `handbag` (26) and `suitcase` (28) — a takeable object *and* a container to
> conceal it in — and `shelf` is an operator-drawn **zone**, not a detection. `labels` is a lookup
> table, not a filter. **The engine is buildable and verifiable today.** What follows is the real,
> narrower gap: merchandise *variety* and accuracy on it.

Items 5, 6 and 7 all rest on *"which object is this, and who has it"*. The shipped detector is
COCO-80 and its capability is `perception.person-detection`. COCO-80 contains `bottle`, `cup`,
`handbag`, `backpack` — and **nothing that means "merchandise"**. A supermarket shelf is not in the
label space.

**Three honest options, none of them free:**

| Option | Cost | ⚠️ |
| --- | --- | --- |
| Class-agnostic proposals (segmentation) | Item 3 delivers it | "An object" without a class cannot be re-identified as *the same* object after occlusion without appearance embedding — item 4 |
| Open-vocabulary detection (GroundingDINO, Florence-2) | A new plugin; large models | Latency far beyond §4's budget; likely GPU-only |
| Customer-specific fine-tuning | A dataset per customer | The corpus does not exist ([DATASET_STRATEGY](DATASET_STRATEGY.md)) |

⭐ **This is the real gate on theft detection, and naming it now is the point of this document.**
Pose and trajectory make a *demo* look close; without object identity, "taking" and "replacing"
remain the same skeleton ([ACTION_FOUNDATION §3](ACTION_FOUNDATION.md)).

---

## 5b. ⛔ The zone gap — the finding of slice 2.2

**Zone membership is resolved downstream of the runtime, so the zone primitives cannot execute inside
it on the product path.** Stated as a fact rather than as a limitation to be argued away:

```
media                      runtime                    media                      events
 decode ──frame──▶ /infer ─ detect · track · behave ─▶ resolveZones ──▶ publish ──▶ normalize
                              ▲                          │
                              └──── membership lands HERE, one hop too late ───┘
```

`services/media/src/application/zone-resolver.ts` computes membership **after** `/infer` answers —
necessarily, because a polygon test needs the boxes inference produces — and stamps it into the
frozen contract's `Detection.attributes["zoneIds"]`. Slice 2.2 therefore treats membership as an
**input fact** (`MembershipZone`) rather than a computation, and reports its absence rather than
producing a dwell of 0.0 s for every subject.

**Three ways to close it, costed. None is free and the choice is the Architect's:**

| Option | Cost | ⚠️ |
| --- | --- | --- |
| **Send the zone plan on `/infer`** — media already holds `PlanZone[]` at the call site | One optional request field | ⛔ A new configuration channel into a frozen runtime, and **two** polygon engines answering "which zone was this person in". The first time they disagree, nobody can say which is right |
| **Echo the previous frame's membership** on the next `/infer` | One field, no second engine | ⚠️ A one-frame lag and a join by frame sequence — complexity for a fact that is already a frame old by the time a primitive reads it |
| **Move the zone-dependent primitives downstream**, beside the membership | No runtime change | ⛔ Layer 2 would then live in two places and two languages; the domain-neutrality test could not span both |

⭐ **Everything that needs no zone already works**: motion, proximity, co-presence, observation gaps,
object association and handover all run today on both the live and the recorded path.

## 6. The behaviour graph (item 6)

A directed temporal graph over entities the platform already has ids for.

```
(person:identityId) ──[near, 09:41:02–09:41:19]──▶ (zone:shelf_3)
        │                                                 ▲
        └──[holds, 09:41:11–…]──▶ (object:obj_7) ──[was_in]┘
```

- **Nodes** — persons (`identityId`), objects (`objectId`), zones (`zoneId`), cameras.
- **Edges** — `near` · `holds` · `entered` · `exited` · `occluded_by` · `same_as` (cross-camera),
  each with a **footage-time interval** and a confidence.
- **Queries** — "did any object that was in `shelf_3` leave with a person who did not pass
  `till_zone`?" ⭐ That sentence is a *graph query*, not a theft heuristic, and it is the same query
  a warehouse uses for "did a pallet leave without a scan".

⚠️ **The graph is an index over track history, not a second store.** It is derivable from ADR-0051's
records; materialising it is an optimisation to be justified by a measured query cost, not a
starting assumption.

---

## 7. What this architecture refuses to do

- ⛔ **No fixed theft heuristic in the runtime.** Layer 3 or nothing.
- ⛔ **No new pipeline stage.** Every component is a registered `PerceptionModule`.
- ⛔ **No second inference path.** The P-9 structural test (`one-pipeline.test.ts`) still fails the
  build if one appears.
- ⛔ **No change to the five frozen contracts.** Behaviour output rides in `attributes` and
  `FrameLabel`, exactly as pose does ([ADR-0050](../adr/ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md)).
- ⛔ **No accusation from the runtime.** It emits observations; a rule names an intent; an incident
  has an owner and an audit trail.
