# ADR-0053 · Zone membership returns to the runtime as an observation

- **Status:** Accepted
- **Date:** 2026-08-08
- **Milestone:** P-11 Professional Perception Phase 2 (Behaviour Engine), slice 2.3
- **Relates to:** [ADR-0044](ADR-0044-one-word-two-zones.md), [ADR-0050](ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md), [ADR-0051](ADR-0051-track-history-becomes-durable.md), [ADR-0052](ADR-0052-behaviour-reasoning-is-not-perception.md)
- **Closes:** the zone gap recorded as slice 2.2's finding ([BEHAVIOUR_ENGINE §5b](../architecture/BEHAVIOUR_ENGINE.md))

## Context

Slice 2.2 put the behaviour primitives on the live path and then measured that **the zone ones never
ran**: `inference_behaviour_zone_membership 0` on a deployment with real footage, real identities and
real events. The cause is ordering, not code.

```
media                      runtime                    media                      events
 decode ──frame──▶ /infer ─ detect · track · behave ─▶ resolveZones ──▶ publish ──▶ normalize
                              ▲                          │
                              └──── membership lands HERE, one hop too late ───┘
```

A polygon test needs the boxes inference produces, so `services/media/src/application/zone-resolver.ts`
necessarily runs **after** `/infer` answers. Every zone primitive — dwell, visits, transitions,
occupancy — therefore had nothing to read, and reported nothing rather than reporting `0.0 s`.

Slice 2.2 costed three ways out and deliberately took none of them without a decision. Restated:

| Option | ⚠️ Why not |
| --- | --- |
| Send the **zone plan** on `/infer` | ⛔ **Two polygon engines** answering "which zone was this person in", in two languages. The first time they disagree nobody can say which is right — and they *will* disagree, because `zoneAnchor` and `pointInPolygon` are floating-point boundary decisions |
| Move the zone primitives **downstream**, beside the membership | ⛔ Layer 2 in two places and two languages; the domain-neutrality test could not span both |
| **Echo the membership back** | ⚠️ A one-frame lag |

## Decision

**1. Membership travels back to the runtime as an *observation*, on the next frame, and the polygon
engine stays in exactly one place.**

`InferenceRequest.frame` gains one optional field, `zoneMembership`. Media fills it from the zones it
has *just resolved for the previous frame it got an answer for*; the runtime applies it to the track
history it already holds. The runtime never sees a polygon, a `PlanZone`, or a zone name it did not
first receive from media.

⭐ **This is not a configuration channel and the distinction is the whole decision.** Configuration
would be the operator's polygons flowing into the runtime, which is what the standing guardrail
forbids and what would create the second engine. What flows here is a *fact about a frame the runtime
itself produced*, computed by the one component that owns the geometry, expressed in the runtime's own
vocabulary (`identityId`, `zoneId`). The runtime's answer to "which zone" is still "whatever media
said" — as it was in slice 2.2, and as `MembershipZone` already assumes.

**2. The echo carries the frame sequence it describes, and is applied to *that* point.**

⛔ Not "the most recent point". At `maxInflight > 1` two frames of one camera can be in flight, so an
echo raised for frame *N* may ride on the request for frame *N+2*. Applying it to whichever point is
newest would attribute one frame's zones to another — a wrong answer that is indistinguishable from a
right one, which is this project's most-repeated failure mode. `annotate_zones` takes a
`frame_index`, finds the point with that index, and **counts a miss when there is none**.

**3. The tail is lost, counted, and published — never inferred.**

The final frame of a stream has no successor to carry its echo. That is one point out of up to 512
per identity; it is reported as `zoneEchoPending` on the sink and `zoneAnnotationsMissed` on the
stage, rather than back-filled from the previous frame's zones. ⚠️ Back-filling would invent a
membership for the one frame most likely to be an exit.

**4. Absence stays three-valued.** `unobserved` (no frames yet) · `absent` (no upstream ever supplied
membership — the zone primitives were inert) · `present`. ⛔ A deployment with no zones drawn must not
read the same as one whose echo is broken, and neither may read as `0.0 s of dwell`.

## Consequences

⭐ **The zone primitives execute on the product path**, for uploaded recordings and for live cameras,
through the same runtime and the same code — dwell, visits, entry/exit transitions and per-zone
occupancy all become available to Layer 3 without Layer 3 existing yet.

⚠️ **One frame of lag, and it is a lag in availability rather than in the data.** The echo annotates
the history point it belongs to, so a dwell computed over 300 points is complete; only the newest
point is un-annotated at any instant. At 4 fps that is 250 ms on a fact that a rule reads in seconds.

⚠️ **A dropped frame drops its membership.** The live sink drops frames under back-pressure by design
(freshness over completeness), and an echo whose frame was never delivered has nothing to describe.
The offline path awaits every frame in order, so an analysis loses only its last one.

⛔ **This does not license sending the runtime anything else.** One field, one direction, one purpose.
A second optional field carrying "the plan", "the schedule" or "the rules" is the configuration
channel this ADR exists to avoid, and it should be refused with this paragraph.

## ⭐ It also makes membership durable, amending ADR-0051

[ADR-0051](ADR-0051-track-history-becomes-durable.md) refused to persist membership, reasoning that
it would be "recomputed on re-read". **That step does not exist**: recomputing needs the polygons at
read time, and the runtime deliberately holds none. So membership was not recomputed — it was lost,
and every completed analysis answered the zone question with nothing.

**Membership is now stored, and `zoneVersion` is what makes that safe.** Each record names the
polygon set that decided it. A polygon later found to be drawn two metres off does not silently
invalidate history: the archive says which geometry it used, the correction is visible as a version
change, and re-resolving is a deliberate act rather than a rewrite.

⛔ **`zoneIds: []` and no key at all are different facts, and the whole design rests on it.** An
explicit empty list says *somebody decided this observation was inside no zone*. Absence says *nobody
has decided yet*. Collapsing them is not a rounding error: a zone visit walks consecutive
observations, so an undecided point read as "outside" closes the visit and emits a `left` transition
— on every frame, for as long as the echo runs one frame behind. A person standing still at a till
would produce a stream of departures and a dwell that never grew past one interval. So:

- `HistoryPoint.zones_settled` distinguishes the two, and a point carrying zones cannot claim to be
  undecided — the contradiction is unbuildable, not merely discouraged;
- an echo **settles a frame, not a subject**: the named identities were inside the zones given and
  *every other subject observed on that frame was inside none*;
- media sends the echo whenever the camera has zones **even when nobody was inside one**, because a
  suppressed empty echo is indistinguishable from a lost one;
- a zone that answers only from what a point carries declares `requires_membership`, and undecided
  points are **skipped** rather than treated as outside — skipping joins the observations either
  side, which is right: the subject did not leave and come back, we were not told about the moment
  in between.

⚠️ ADR-0051 decision 3 is untouched. Dwell, velocity and direction remain computed. Membership is not
a derived value — it is an observation about a frame, made by the component that owns the geometry,
and it is the one input the runtime cannot reproduce for itself.

### ⛔ Two defects this decision produced, both found before it shipped

**The join was off by one, and the wrong number looked right.** The runtime stored its own per-camera
frame counter on each history point, not the caller's `frame.seq`. The echo therefore matched the
*previous* frame every time — producing a dwell short by exactly one interval, on a graph nobody
would have questioned. History points now store `ctx.frame_number`, which is also what
`DetectionResult.frame.seq` and `EventEnvelope.payload.frameSeq` carry, so a movement path is
joinable to the events that cite it. `tools/contracts/perception-boundary.mjs` §G asserts it.

**Two upstreams answered one question.** On the echo channel a detection never carries `zoneIds`, so
the older attribute path read every current frame as "inside no zone" — settling it *outside* one
frame before the echo arrived to say the subject was inside. A person standing still produced an
`entered`/`left` pair on every single frame. The channels are now mutually exclusive per stream:
once a stream has spoken through the echo, the attribute path is ignored for it. ⚠️ Two upstreams
answering one question is something to pick between, not something to merge.
