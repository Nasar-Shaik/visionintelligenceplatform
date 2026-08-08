# ADR-0054 · A scene observation is not a detection

- **Status:** Accepted
- **Date:** 2026-08-08
- **Milestone:** P-11 Professional Perception Phase 2 (Behaviour Engine), slice 2.3
- **Relates to:** [ADR-0049](ADR-0049-per-frame-perception-data-is-not-persisted.md), [ADR-0050](ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md), [ADR-0051](ADR-0051-track-history-becomes-durable.md), [ADR-0052](ADR-0052-behaviour-reasoning-is-not-perception.md)
- **Closes:** slice 2.2's Finding 1 — *`FrameLabel` has nowhere to go*

## Context

[ADR-0050](ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md) gave the perception
vocabulary a boxless statement — `FrameLabel` — precisely so a model could say *"the queue is six
people long"*, which no per-object record can hold. Slice 2.2 then produced the first ones
(`occupancy`, `handover`) and discovered they **cannot leave the runtime**: `DetectionResult` carries
`detections[]`, and the only open map on it is `Detection.attributes`, which is per subject.

The workaround shipped in 2.2 was a bounded in-memory snapshot read through `GET /tracking/behaviour`.
⚠️ That is a debugging read, not a carrier: it is lost on restart, capped at 32 frames, and invisible
to anything consuming the detection stream.

Three shapes were considered:

| Shape | ⚠️ |
| --- | --- |
| Fold scene facts into every `Detection.attributes` | ⛔ N copies of one statement per frame, and no way to state a fact about a frame with **no** detections — occupancy 0 is a fact |
| A second document, published beside the result | ⛔ A second publish path, a second ordering guarantee, and two documents describing one frame that can arrive out of order |
| **An optional array on `DetectionResult`** | Widens a frozen contract — additively, which the contract's own version note already sanctions |

## Decision

**1. `DetectionResult` gains an optional `scene: SceneObservation[]`, and the schema version goes to
`1.2`.**

```ts
SceneObservation = { kind, confidence, attributes, span? }
```

This is `FrameLabel` on the wire, renamed for the audience: inside the runtime it labels a frame, on
the wire it *observes a scene*. It is **additive and optional** — the exact path
`DETECTION_RESULT_SCHEMA_VERSION` was introduced to allow ("Additive only; a breaking change needs an
ADR and a major bump"). A consumer that has never heard of `scene` is unaffected, and an archived
`1.1` document stays valid.

**2. `kind` is an open vocabulary, and it is domain-neutral by the same test as everything in Layer 2.**
`occupancy`, `handover`, `density`, `queueLength` pass the hospital test. `shoplifting` does not, and
the executable domain-neutrality test covers the producers.

**3. It is carried by the `FrameContext`, which already reaches every stage.**

⭐ **No new pipeline stage, no protocol signature change, and no side channel.** `FrameContext` is
built once per `/infer` request and passed to every stage *and* to the translator. It gains one
mutable, bounded collector; a stage appends, the translator drains. The carrier existed for the same
reason the seam did — the object was already threaded through the whole pipeline.

**4. ⛔ A scene observation does not become an event, and that is deliberate.**

At 4 fps on one camera, occupancy alone is 4 statements a second — 345 000 a day, per camera, most of
them identical to the last. [ADR-0049](ADR-0049-per-frame-perception-data-is-not-persisted.md)'s
volume reasoning applies unchanged, and none of it is *needed*: every scene observation this platform
produces is a pure function of track history, which [ADR-0051](ADR-0051-track-history-becomes-durable.md)
already made durable. So the read path **recomputes** rather than stores.

⚠️ The day a scene observation is *not* derivable from track history — a model that says "this is a
checkout area" from pixels — this decision must be revisited, and that is the trigger to write it
down here.

## Consequences

⭐ **One durable substrate, everything else derived.** Track history is stored; primitives, scene
observations and the behaviour timeline are computed from it on read. A corrected formula fixes
history rather than being unable to; a stored occupancy count would have frozen the definition at the
moment it was written — the same argument ADR-0051 decision 3 makes about velocity, one level up.

⚠️ **The live path and the read path can disagree, and the read path is right.** A live consumer sees
`scene` as it was computed frame by frame, from a bounded window; a reader asks for a stream and gets
the whole history recomputed. When they differ, the recomputation is the answer, because it saw more.

⚠️ **`scene` is bounded per frame** (`MAX_SCENE_OBSERVATIONS`). A frozen contract that could carry an
unbounded array would put a stage bug on the broker.

⛔ **This does not license per-frame persistence of anything.** ADR-0049 stands for detections;
this ADR adds a *transport*, not a store.
