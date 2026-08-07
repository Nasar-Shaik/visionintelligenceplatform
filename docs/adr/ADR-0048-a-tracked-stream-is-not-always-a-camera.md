# ADR-0048 — A tracked stream is not always a camera

- **Status:** Accepted
- **Date:** 2026-08-07
- **Milestone:** P-8.5 (Product Validation) — finding **V-2**
- **Scope:** **AI Runtime v1.0**, which is frozen. See [Why this is not a thaw](#why-this-is-not-a-thaw)
- **Extends:** [ADR-0047](ADR-0047-an-analysis-run-is-part-of-an-events-identity.md) — the same
  decision, one layer deeper
- **Related:** [ADR-0038](ADR-0038-track-identity-across-gaps.md),
  [ADR-0041](ADR-0041-identity-travels-with-the-subject.md),
  [L-62](../project/KNOWN_LIMITATIONS.md)

## Context

ADR-0047 established that an analysis run is part of an event's identity, because offline analysis
stamps **footage time** and footage time does not advance between runs. It fixed three mechanisms
that identified a stream as `(tenant, camera)` plus a forward-moving number:

1. the event publisher's ordering gate,
2. the events service's dedup key,
3. JetStream's `msgId`.

⛔ **There was a fourth, and it was the one nobody looked at, because it lives inside the frozen
runtime.**

`RuntimeTracker.run()` skips any frame whose capture time is older than the last one it accepted —
correct and necessary, because media runs four requests in flight and tracking backwards would make
every duration, speed and heading derived from the history silently wrong. That guard reads
`last_capture_seconds` from state held per `(tenant_id, camera_id)`.

An offline analysis replays footage instants. A second analysis on the same camera — a rerun, or
simply the *next* recording from the same camera — is therefore entirely "older" than the first, and
every frame of it is skipped.

⛔ Measured on the deployed stack during P-8.5, after eight analyses on one camera:

```
framesTracked     : 906
outOfOrderFrames  : 1244        ← more frames rejected than tracked
```

Two identical reruns raised `outOfOrderFrames` by **exactly 120** — the whole of both runs — while
`framesTracked` did not move. Five of eight validation clips finished with **zero tracks**.

### What it looked like from the product

Nothing said anything was wrong. The session reported `succeeded` with the correct frame and
detection counts, because media had done its job. Downstream:

- no `tracking_id` on any detection, so
- the events dedup key fell back to the subject **class**, so
- eight people in one frame collapsed into **one event per bucket** — `crowd` produced 3 events and
  0 tracks, identical to a single person walking (finding **V-3**), and
- no dwell, therefore no loitering incident, on footage that plainly contained one.

⚠️ The sharper edge: an analysis of footage dated **ahead** of now would poison the gate for the
**live** camera and silently stop tracking it.

## Decision

**Tracking state is keyed by the stream, not by the camera.**

```python
key = (tenant_id, camera_id, stream_id)      # stream_id = FrameContext.correlation_id
```

`correlation_id` is already on `FrameContext` and already parsed from the request. Media attaches
`correlationId` **only** to frames carrying stored-media provenance
(`http-frame-sink.ts`), so:

- a **live** frame arrives with `stream_id = None`, the key is `(tenant, camera, None)`, and the
  gate, the state and the minted track ids are **byte-identical** to before;
- an **offline** frame carries its `analysisSessionId`, and each run gets its own tracker.

The stream also enters the state's session id, so two analyses of one recording mint **different**
track ids — without which ADR-0047's promise that runs are independently queryable would hold for
events and quietly fail for identities.

## Why this is not a thaw

AI Runtime v1.0 is closed. This decision is recorded because it touches that boundary, and it is
accepted because it does not move it:

| | |
| --- | --- |
| **No contract change** | `correlation_id` was already on `FrameContext` and already populated. Nothing new crosses the wire |
| **No new capability** | The runtime learns nothing it was not already told |
| **Live behaviour is provably unchanged** | Asserted by `test_a_live_camera_is_unchanged_when_no_run_is_named`, which passes both with and without the change |
| **No offline-specific logic** | There is still one tracker, one associator, one set of options. The identity of a *stream* was simply wrong, and is now right |

⛔ **It is a defect fix, not a feature.** The runtime was making a claim about what a stream is that
was true when only live cameras existed and became false when stored media was added. Freezing an
interface does not freeze a mistake behind it.

## Consequences

### Good

- ⭐ Offline analysis tracks correctly. `crowd`: **24 events and 8 tracks**, from 3 and 0.
- ⭐ **[L-62] closed as a side effect.** The timeline's track lane was sparse because dedup keeps the
  earliest observation in a bucket and the earliest was systematically untracked. The real cause was
  one level down: *no* observation was tracked. Measured after the fix: **0 of 8 spans are
  zero-width**, each running the full length of the footage.
- Live and offline on one camera no longer interfere in either direction.
- Ten concurrent analyses produce ten identical results.

### ⚠️ Costs, stated

- **State cardinality grows.** One entry per live camera *plus* one per running analysis, against
  `MAX_CAMERAS = 64` with LRU eviction and a 300 s idle sweep. With `maxConcurrent: 1` ([L-41]) the
  practical addition is one, and finished runs are swept. ⚠️ A future deployment that raises
  `maxConcurrent` substantially should revisit the bound rather than assume it.
- **`camerasTracked` now counts streams.** A camera under analysis reports more than one. The
  per-camera live view sums across a camera's streams rather than taking the last one — which was a
  real bug introduced and caught while making this change: `live[cam] = {...}` reported whichever
  stream happened to be iterated last, so an operator watching a camera during an investigation
  would have seen a count flickering between two truths.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Send a distinct `cameraId` per session | Corrupts identity everywhere downstream — zones, rules, incidents and every existing query are keyed on the real camera |
| Stamp wall-clock time on offline frames | Destroys reproducibility, which is the milestone's central acceptance criterion, to work around a gate |
| Reset the gate on a large backwards jump | A heuristic with a threshold to tune, and it cannot distinguish a rerun from a redelivery — both replay *identical* instants. ⛔ No amount of comparing timestamps separates "a stale redelivery" from "a legitimate second look" |
| Accept it and document the limitation | The product promise is "analyse recorded video". Silently producing no identities on the second recording is not a limitation, it is the feature not working |

## Verification

| | |
| --- | --- |
| **Unit** | 4 tests in `ai/inference/tests/test_runtime_tracking.py`. Three fail without the change; the fourth (live unchanged) passes both ways, which is the point of it |
| **Suite** | 1 057 Python tests, same 6 pre-existing environmental failures before and after |
| **Deployed** | Three identical reruns → `framesTracked 180`, `outOfOrderFrames 0`, 3 tracks created. Before: 906 / 1244 |
| **Product** | `crowd` 24 events / 8 tracks; 10 concurrent analyses → one distinct result tuple |
