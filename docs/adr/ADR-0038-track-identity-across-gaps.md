# ADR-0038 — Track identity across gaps: a link, never a reassignment

- **Status:** Accepted
- **Date:** 2026-08-05
- **Milestone:** P-8 Phase 4 (object tracking)
- **Supersedes / amends:** none — evolves the FROZEN `Track` contract additively (ED-0039)
- **Related:** [ADR-0002](ADR-0002-model-agnostic-capability-runtime.md) (model-agnostic runtime),
  [ADR-0037](ADR-0037-model-agnostic-runtime-and-registry-driven-loading.md) (real inference)

## Context

Phase 3 made inference real: frames arrive, a model runs, detections come back. Every one of those
detections is an **observation in one frame**, and nothing connected them. Phase 4's job is the
connection — turning a stream of observations into identities that persist.

Three decisions had to be made, and one of them was about a guarantee the platform had already
given.

### The live path had nowhere to keep tracking state

Tracking already worked for **batch** analysis. `VideoAnalyzer` materialises a video, holds one
`TrackManager` for the whole file, and walks it frame by frame. The live path cannot do that: media
posts each frame to `POST /infer` as an independent, stateless request. There is no session, no
ordering guarantee, and nothing that survives between two frames of the same camera — which is
precisely what a tracker needs.

### An object that leaves and comes back is a real event, and the obvious fix breaks a promise

Someone walks out of shot and returns. Someone stands behind a pillar for ten seconds. Reporting
them as an unrelated stranger throws away the fact an investigator most wants.

The obvious implementation gives the returning object its **old track id** back. The frozen `Track`
contract guarantees the opposite: a `trackId` is unique per tenant → camera → session and is
**never reused within a running session**.

### IoU association cannot survive an occlusion, and the reason is structural

`IouAssociator` compares a detection against a track's _last observed_ box. That works while the
object is visible. The moment it is hidden the box stops updating and the object keeps walking; when
it reappears there is no overlap, association fails, and the platform issues a **new identity for
the same person**. This is not a threshold that needs tuning — at 2 fps a person at walking pace
clears their own width in about a second, so the overlap is genuinely zero.

## Decision

### 1. Tracking state lives in the runtime, per (tenant, camera), created on demand

A `RuntimeTracker` implements the existing `pipeline.Tracker` protocol and holds one `TrackManager`
per `(tenant, camera)` pair. It drops in where `NoopTracker` was, so nothing above it changes.

State is created **lazily, on the first frame that actually arrives for a camera**, and released
when that camera goes quiet. There is no camera list, no enrolment step, and no "all cameras"
anywhere in the module.

⚠️ **That shape is what lets Camera Processing Assignment (C-14c) arrive without a redesign.**
Selective AI processing is designed and not built; today every recording camera's frames are
offered. When assignment does arrive it changes _which frames are sent_ — and this module needs no
change at all, because it only ever knew about cameras that sent something.

One tracker is shared across every capability, because an identity belongs to a **camera** rather
than to whichever capability analysed the frame. Give each capability its own and the same person
acquires two unrelated identities the moment a second capability is enabled.

### 2. Re-entry is a LINK, not a reassignment

The returning object gets a **new** `trackId`. Three additive optional fields carry the connection:

| Field        | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| `identityId` | the `trackId` of the **first** track in the chain     |
| `precededBy` | the immediate predecessor                             |
| `recoveries` | how many gaps this identity has been re-linked across |

A consumer asking "the same person" groups by `identityId`. One asking "this uninterrupted
observation" uses `trackId`. Both are legitimate questions and they are **different** questions.

⚠️ **Recycling the id would have broken the guarantee silently.** Nothing would error. Every
consumer already holding the earlier id — an event, an evidence reference, a rule's memory — would
simply start referring to a different appearance, and the data would mean something else without
anything reporting a change. On a platform whose output becomes evidence, that is the worst
available failure mode.

Occlusion **shorter** than the tracker's tolerance is not a re-entry at all: the same `trackId`
survives it and `quality.lostFrames` records that it happened.

### 3. Association predicts forward, and re-acquires by distance when overlap collapses

`PredictiveIouAssociator` matches a lost track against where it _would be_ if it had kept moving,
using velocity derived from the track's own history — so the associator stays stateless and
therefore interchangeable. The predicted box is used only when it scores better than the observed
one, so a visible, well-tracked object associates exactly as before.

⚠️ **IoU alone is the wrong tool for reacquisition, and this was measured.** IoU does not degrade,
it collapses: at one pixel of separation it reports exactly `0.0`, the same score it gives for
someone on the other side of the room. A walker who slowed from 0.040 to 0.033 normalized units per
frame across a six-frame occlusion scored 0.43 against a 0.45 gate and was issued a new identity. So
a coasting track may also be re-acquired by **centre distance**, scaled to the track's own box —
about one and a half body-widths from the prediction.

Distance matches score strictly **below** any genuine overlap, so reacquisition can only ever
recover an identity that would otherwise have been lost. It can never take one from a better-
evidenced match, which would turn a recovery mechanism into a cause of identity switches.

### 4. Motion is measured in normalized image units, and named for it

`TrackMotion` carries duration, travelled path, displacement, average and current speed, image-space
heading, dwell and straightness — all derived from the track's own bounded history by pure
functions, so an archived track recomputes to the same answer.

⚠️ **Every distance is a fraction of the frame, and every field name says so.** Converting to metres
per second requires camera calibration — intrinsics, mounting height, tilt, a ground-plane
homography — that this platform neither has nor asks for. A field called `speedMps` would be a
fabricated physical quantity in an evidence product. Two people walking at identical real speeds,
one near the lens and one far from it, produce very different numbers here; that is a property of
the measurement, not a defect in it.

Heading is image space: `0°` is +x, increasing clockwise because image `y` grows downward. It is not
a compass bearing.

## Consequences

**Good.** The frozen contract keeps its guarantee while gaining the behaviour that motivated
breaking it. Downstream consumers choose which question they are asking. The tracker remains
swappable — ByteTrack, BoT-SORT, OC-SORT all fit the same `TrackerAdapter` seam, and none of them
would have to reimplement lifecycle, history, identity linking or motion.

**Costly.** Two ids for one person is more to explain than one. The operator pages carry that cost
explicitly: a re-entered track shows both, with a sentence stating that the link is geometric.

⚠️ **Limited, and stated rather than discovered.** Re-entry matching is **appearance-blind** —
position, size, elapsed time and label. There is no re-identification model: no embedding, no
clothing colour, no gait. Two similarly-sized people passing through the same doorway inside the gap
window are indistinguishable to this logic, and it will link the wrong one. That is why the gate is
deliberately tight and why `identityId` is advisory metadata rather than an assertion of fact. See
[L-42](../project/KNOWN_LIMITATIONS.md).

⚠️ **Verified against authored scenarios, not against real footage.** The five identity properties
are proved with clips whose trajectories are written down in advance, because on real footage nobody
knows the right answer and nothing can be asserted — only observed. L-1 stands: no camera has ever
been connected. Tracker behaviour on real video is P-9's question.

## Alternatives considered

**Reuse the track id on re-entry.** Rejected — see decision 2. It is the smaller change and it
breaks the contract's one promise without any signal that it has.

**A global identity service across cameras and sessions.** Rejected for this phase. Cross-camera
association is a genuinely different capability needing re-identification, and building the
single-camera case as if it were the general one would have produced an identity model nobody had
validated. `attributes` and `identityId` are the seam it will hang from.

**Kalman filtering instead of constant velocity.** Rejected for now. At 2 fps with a bounded history
a Kalman filter's advantage is small and its state is another thing the associator would have to own
— which is exactly what keeps trackers interchangeable today. Revisit when frame rates rise.

**Report speed in metres per second using an assumed camera height.** Rejected outright. It would
produce a plausible number from an invented parameter, on a page an investigator may rely on.
