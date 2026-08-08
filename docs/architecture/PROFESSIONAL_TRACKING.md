# Professional Tracking — architecture

**Design only. Nothing here is implemented, and one part of it is deliberately deferred.**

> ⭐ **The runtime already computes most of this and throws it away.** Each track carries `history[]`
> — per-frame `frameIndex`, `bbox` and `centroid` — plus `age`, `hits` and `quality`, capped at
> `historyMax: 50` frames and evicted as tracks retire. [ADR-0049] records that decision. So the gap
> between "what VIP tracks today" and "trajectories, velocity, dwell" is **retention and
> derivation**, not perception.

---

## 1. What exists

| | |
| --- | --- |
| Tracker | `predictive-iou` — minIou 0.3, minIouLost 0.45, minHits 2, maxAgeFrames 8 |
| Re-entry | `reentryGapSeconds: 12`, `reentryDistance: 0.35` → `identity_id` bridges the gap |
| Identity | ⚠️ `tracking_id` is **not** `identity_id`. A person briefly occluded returns with a **new** `tracking_id` (ADR-0038 forbids reuse). Anything that accumulates over time must group by `identity_id` or it sees two short visits instead of one long one |
| History | 50 frames, in memory, evicted on retirement |
| Measured | P-9 soak: 24 tracks over 30 minutes, **0 out-of-order frames** |

⛔ **`CAMERA_IDLE_SECONDS = 300` and track age advances per *frame*, not per second.** Found by
reading the runtime during P-9, not by any check. Any design below that assumes wall-clock ageing is
wrong; a camera at 1 fps ages tracks five times slower than one at 5 fps.

## 2. The derived layer

Each is a pure function of `history[]` — none needs a new model, and none is implemented.

| Signal | Derived from | ⚠️ The trap |
| --- | --- | --- |
| **Trajectory** | Ordered centroids | Meaningless without `identity_id` grouping (see above) |
| **Velocity** | Δcentroid / Δt | Δt is **footage time**, never wall-clock. Offline replay and live differ by hours |
| **Acceleration** | Δvelocity / Δt | Doubly sensitive to frame drops; a dropped frame reads as a lurch |
| **Dwell** | Time within a zone | Must survive occlusion, so it is an `identity_id` question |
| **Interaction** | Proximity + overlap between identities | Two boxes overlapping is not two people interacting — needs depth or pose to disambiguate |
| **Occlusion recovery** | Existing re-entry linking | Already measured: P-9 soak recorded 104 occlusions survived |
| **Cross-camera** | Re-id embedding + topology | See §4 — the only item here that genuinely needs a new model |

⭐ **Normalised coordinates are not metric.** Velocity in "screen widths per second" is not speed, and
two cameras with different fields of view will disagree about the same walk. Anything sold as a speed
needs calibration (`coordinates.py` already defines a `CoordinateTransform` Protocol for exactly this
seam) — until then the honest unit is normalised-per-second, and it should be labelled that way in
every API that returns it.

## 3. ⛔ Persistent trajectory storage is deferred, on instruction

The Architect's instruction is explicit: *"Do not implement persistent trajectory storage yet."*
Recording why, so the deferral survives:

- One 33-second recording produced **285 detections and 24 persisted events** — persistence is
  already 8.4 % of what perception produces. Trajectories invert that ratio.
- Retention, tenancy and GDPR erasure all apply to a movement path in a way they do not to a count.
- The consumer does not exist yet. Storing a trajectory nothing reads is a migration nobody can undo.

**What is safe to build first:** derivation over the *in-memory* window, exposed on the existing
tracking endpoint. That validates every formula above against real footage without a schema.

## 4. Cross-camera — what it actually requires

Cross-camera identity is **not** a tracking improvement; it is a re-identification model plus a
topology. `Detection.embedding` is already a frozen field, so the contract is ready and the model is
not. ⚠️ Without a calibrated topology (which camera can a person reach from which, and how quickly),
embedding similarity alone will link two different people in similar jackets — and it will do so
confidently.

## 5. Verification these will need

Reused directly from P-9, which built the harness:

- **Run the footage twice** — offline replay never moves footage time, so anything keyed on
  camera + timestamp breaks on the second run.
- **A negative control** — `empty-room` produced 0 detections across 73 frames. A trajectory metric
  must have an equivalent: a stationary subject must produce ~0 velocity, not a small plausible one.
- ⛔ **Prove the metric can move before trusting a clean run.** A velocity that reads 0.0 because the
  history buffer was empty is indistinguishable from a person standing still.
