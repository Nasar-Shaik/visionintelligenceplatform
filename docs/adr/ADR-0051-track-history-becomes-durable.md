# ADR-0051 · Track history becomes durable

- **Status:** Accepted
- **Date:** 2026-08-08
- **Milestone:** P-11 Professional Perception Phase 2 (Behaviour Engine)
- **Supersedes:** [ADR-0049](ADR-0049-per-frame-perception-data-is-not-persisted.md) — in part
- **Relates to:** [ADR-0038](ADR-0038-track-identity-across-gaps.md), [ADR-0041](ADR-0041-identity-travels-with-the-subject.md), [ADR-0050](ADR-0050-the-perception-vocabulary-is-the-plugin-boundary.md)

## Context

[ADR-0049](ADR-0049-per-frame-perception-data-is-not-persisted.md) recorded, as a **deliberate
deferral**, that per-frame perception data is not persisted. Its reasoning was sound and is worth
restating because most of it still holds:

- one 33-second recording produced **285 detections and 24 persisted events** — persistence was
  already 8.4 % of what perception produced, and trajectories invert that ratio;
- retention, tenancy and erasure all apply to a movement path in a way they do not to a count;
- **the consumer did not exist**, and storing a trajectory nothing reads is a migration nobody can
  undo.

The third reason is the one that has changed. On 2026-08-08 the Principal Architect directed the
Behaviour Engine, whose first item is persistent track history — trajectory, velocity, direction,
dwell, interaction history, embedding history. Every downstream capability in that direction
(shelf interaction, concealment, queue analytics, loitering across a shift, cross-camera identity)
reads exactly that data. **The consumer now exists.**

⚠️ Note what is *not* claimed: ADR-0049's first two reasons are untouched. Volume and privacy did not
become less true; a decision was taken to pay them.

## Decision

**1. Track history becomes durable, and it is a first-class record — not a widened `Detection`.**
The frozen five contracts are untouched (ADR-0050's rule). A `TrackHistory` document is written by
the platform tier from the events the runtime already emits, plus a runtime-side export of the
in-memory `history[]` that today is evicted on retirement.

**2. It is keyed by `identityId`, never by `trackingId`.** ⛔ This is the single most likely defect
in the whole phase. A person briefly occluded returns with a **new** `trackingId` — ADR-0038 forbids
reuse — so anything that accumulates over time and groups by `trackingId` sees *two short visits
instead of one long one*. Dwell, loitering and "time in store" are all accumulations. The failure is
silent and the number it produces is plausible.

**3. Derived motion is computed, not stored.** Trajectory is the stored primitive; velocity,
acceleration, direction and dwell are pure functions over it. Storing a derived value freezes the
definition at the moment it was written and makes a corrected formula unable to fix history.

**4. Footage time, never wall-clock.** Every timestamp in a track history is the frame's own time.
Offline replay does not move footage time, and live capture stamps with the service clock; a
duration mixing the two means different things on the two paths.

**5. Retention is declared per tenant, and erasure is a first-class operation.** A movement path is
personal data in a way a detection count is not. Default retention is short (days), configurable,
and a tenant-scoped delete must remove history alongside the incidents that cite it.

## Consequences

⭐ **Behaviour primitives become possible at all.** Nothing in the Architect's list beyond item 1 can
be built without it — which is why it is item 1.

⚠️ **Volume is the cost, and it was already measured.** 285 detections per 33-second clip is ~8.6/s
per camera. A 16-hour retail day on 10 cameras is ~5 M trajectory points. The mitigations are
decided now rather than after the first customer: store **one point per track per sampled frame**,
not per detection; bound each track's stored path the way `historyMax` bounds the in-memory one; and
write on **track retirement**, not per frame, so the hot path stays a stream.

⛔ **`CAMERA_IDLE_SECONDS = 300` and per-frame ageing are load-bearing here.** Track age advances per
*frame*, not per second, so a camera at 1 fps ages tracks five times slower than one at 5 fps. Any
retention or dwell computation that assumes wall-clock ageing will be wrong, and P-9 found this by
reading the runtime rather than by any test.

⛔ **What this ADR does not license.** It does not persist per-frame *detections* — ADR-0049 stands
for those. It does not persist raw frames or embeddings-per-frame (embedding history is item 4 and
gets its own decision). It does not put behaviour reasoning in the runtime; see
[ADR-0052](ADR-0052-behaviour-reasoning-is-not-perception.md).
