# ADR-0049 · Per-frame perception data is not persisted

- **Status:** Accepted — deliberate deferral, recorded so it is a decision rather than an oversight
- **Date:** 2026-08-07
- **Milestone:** P-8.6 Product Surface
- **Supersedes / relates to:** [ADR-0047](ADR-0047-an-analysis-run-is-part-of-an-events-identity.md), [ADR-0048](ADR-0048-a-tracked-stream-is-not-always-a-camera.md), [L-57], [TD-69]

## Context

The P-8.5 capability audit measured what one analysis run keeps, on a real 33-second recording:

```
   67 frames analysed
  285 detections returned by the runtime
   24 events persisted            ← 8.4 %
    9 distinct footage offsets    ← 13 % of analysed frames
```

Event identity is `tenant | type | camera | zone | track | floor(occurredAt / 10s)`, so **one event
survives per track per ten-second bucket** ([L-57]). Two further findings:

1. **The runtime computes a full trajectory and throws it away.** Each track carries `history[]` —
   per-frame `frameIndex`, `bbox` and `centroid` — plus `age`, `hits` and `quality`. It lives in the
   inference process's memory, capped at `historyMax: 50` frames, and is evicted as tracks retire.
   Measured during the audit: the Architect's run was already gone from
   `/perception/tracking/tracks` while the audit was being written. **No `tracks` collection exists
   in any database.**
2. **The 261 detections that lose the dedup race are never written anywhere.** They are not stored
   at lower fidelity, not summarised, not counted per frame. `counts.detections` is the only trace.

P-8.6 was asked to expose the existing pipeline, and it did — the timeline now carries `bbox` on
every persisted entry, and the console draws them. That makes the boundary visible for the first
time: the overlay can only outline a subject at **9 moments** in a 33-second recording, and the
player has to say so in words.

The obvious next request is "draw the path" or "step through every detection". Both need data that
is currently discarded, and the Architect explicitly deferred them.

## Decision

**Per-frame perception data — trajectories and non-surviving detections — is not persisted, and no
part of the product may imply that it is.**

Concretely:

1. The timeline's `entries`, `tracks` and `density` lanes describe **persisted events**, never
   detections. The density lane is labelled *persisted events* on screen.
2. `AnalysisTrackSpan.observations` is the count of events that survived dedup. It is **not** the
   number of frames the subject was tracked in, and the UI says so beside it.
3. The overlay draws a box only within ±half a sample interval of an analysed instant. It does not
   interpolate, hold, or extrapolate between stored frames.
4. `/perception/tracking/tracks` remains a **live** view of runtime memory. It is not scoped to an
   analysis, it is not a history, and no product feature may be built on its durability.

## Why not persist it now

**Volume is the whole argument.** 285 detections from 33 seconds of one camera at 2 fps extrapolates
to roughly **8.5 million rows per camera-day at 25 fps**, before tracking history. At the platform's
declared capacity ([L-41]: 2 cameras per host at 2 fps) that is already ~50 k rows/camera-day, and
the capacity target is orders of magnitude above that.

That makes this a **retention, cost and schema decision**, not a screen:

- **What granularity?** Every detection, every *n*th, or a per-track polyline with a distance
  threshold? Each answers a different question and has a different cost.
- **What retention?** Detection rows are personal data — a record of where identifiable people
  walked. They need a retention policy, a deletion path and a legal basis, none of which exist.
  Evidence already has custody and retention ([TD-15]); detections would need the same or a
  documented reason they do not.
- **Whose store?** Events is a time-series collection with a dedup contract built into its identity.
  Writing 12× more rows through it would change the meaning of every existing index.
- **Which clock?** Offline runs stamp footage time. A trajectory store keyed on `(camera, time)`
  would reproduce exactly the collision class ADR-0047 and ADR-0048 have now fixed **five** times.

⛔ **Doing it badly is worse than not doing it.** A half-retained trajectory — say the last 50 frames,
matching the runtime's buffer — would draw a path that stops mid-recording for reasons no operator
could explain, on the screen they use to decide whether to call the police.

## Consequences

**Accepted:**

- "Show me this person's path" cannot be answered for a completed analysis. Neither can "step through
  every detection". Both are recorded as future work rather than gaps.
- Track lifetime shown in the product is a **lower bound**. A track the tracker followed for 56
  frames may display as 2 observations.
- Re-running an analysis is the only way to see a run's tracking state live, and even then it is the
  runtime's in-memory view, not a record.

**Required of anything built on top:**

- Any feature that needs continuous per-frame data must open this ADR first and supersede it with a
  schema, a retention policy and a measured cost — not extend a UI.
- ⚠️ Nothing may interpolate between stored detections and present the result as measurement. A drawn
  line between two boxes ten seconds apart is a **claim about where a person walked**, and the
  platform has no evidence for it.

## What would change this

A milestone that answers, with numbers rather than intent: granularity, retention period, storage
tier, deletion path, per-camera-day cost at the target capacity, and the identity key (which must
not be `(tenant, camera, time)`). Until then the product surface stays honest about what it kept.

## Related

- [AI_PIPELINE_CAPABILITY_AUDIT](../project/AI_PIPELINE_CAPABILITY_AUDIT.md) — the measurements above
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — [L-57], [L-41]
- [tracking/TECH-DEBT.md](../../tracking/TECH-DEBT.md) — [TD-15] evidence custody
