# P-8 Phase 8 · Slice 3 — Pipeline execution using the existing runtime

**Status** Delivered · **Verified on the deployed stack** 2026-08-07 · **Blocked at the event layer** (see §6)

Offline recordings now execute through the **live production runtime**. There is no second inference
engine, no second tracker, no second rule engine and no second event path — a frame decoded from an
uploaded MP4 reaches `/infer` through the same request, the same assignment gate, the same zone
capture and the same publisher as a frame from a camera.

---

## 1 · What was built

| Piece                                | Why it exists                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StoredMediaFrameSource`             | The `FrameSource` slice 2 was written for. Real ffmpeg over a presigned object URL, chunked with an **input-side** `-ss`, MJPEG to a pipe          |
| `FrameProvenance` on `Frame`         | Frame number, footage offset, container PTS, source id, analysis id, session id, chunk id, frame rate and decoder version — carried with the frame |
| `FrameSink.deliver()`                | ⭐ The lossless, strictly-ordered admission policy. One delivery path, two admission policies — see §3                                             |
| `Pacer` (`analysis-pacing.ts`)       | Replay speed as a first-class, testable thing. Changes *when* an answer arrives, never *what* it is                                                |
| `AnalysisRunner`                     | Makes a queued session actually run, in-process, bounded to one at a time (L-41)                                                                   |
| Read-time lease repair               | A session orphaned by a restart becomes `retrying` or `expired` when read — tenant-scoped, no cross-tenant sweeper                                 |
| `ObjectStore.presignInternalGet()`   | ⛔ Server-side signed URLs. Closes a defect that made slice 1's confirm step fail in **every** deployment — see §5                                 |

---

## 2 · Frozen contracts: none changed

| Pressure                                            | Resolution                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A stored file is not a `CameraProtocol`              | `FrameSource` stays an **application port**. `Decoder` is unchanged and still drives every camera                                   |
| The runtime must know which analysis a frame is from | ⭐ `frame.correlationId` — the one field the **frozen** AI Runtime v1.0 echoes. It already flows to `EventEnvelope.correlationId`, which is indexed and queryable. Nothing widened |
| Nine session states vs five `JobState` values        | Unchanged from slice 2: the session carries the operational vocabulary and maps **down** through one function                        |

⚠️ Live behaviour is byte-identical. A live frame carries no provenance, so it sends no
`correlationId`, so its ordering key and its publisher-stamped correlation id are exactly what they
were. A test asserts the two request bodies are equal.

---

## 3 · ⭐ One delivery path, two admission policies

`push` and `deliver` reach the runtime through the *same* request builder. They differ only at the
door, and the two answers are opposites for good reasons:

- **`push` drops.** A live frame is perishable and back-pressure would reach the process writing MP4
  segments — a slow runtime would become missing evidence.
- **`deliver` waits.** ⛔ There is no such thing as a stale frame in a *recording*. Every frame is
  evidence a customer uploaded, and a dropped one is a hole in an investigation no counter can fill.

⭐ **Ordering is the less obvious half.** The runtime's tracker *skips* a frame older than the last
one it saw. The live path keeps four requests in flight, so under concurrency **which** frames get
skipped depends on scheduling — two runs of one file would disagree. Awaiting each frame in turn
makes the offline path strictly ordered, and strict ordering is what turns "the same file twice" into
the same answer twice.

A worker given a sink that can only `push` **fails the session** with an operator-facing reason
rather than silently degrading.

---

## 4 · Verification

### 4.1 Unit — 256 media tests, 48/48 repo gate

`analysis-parity.test.ts` compares two whole runs frame by frame: sequence, event time, media offset,
PTS, chunk id, session id and the **bytes** of every frame, for all 600 frames, in order. Plus the
chunk-seam test (no repeat, no gap) and the pacer's self-correction.

### 4.2 ⭐ Deployed — the real stack

Real ffmpeg, real MinIO, real AI runtime (`yolox-nano` / `CPUExecutionProvider` / `0.1.0`), real
events service. 30 s of genuine people footage at 2 fps, run at **1×** and at **8×**.

| Measured                          | 1×                                | 8×                                | Identical |
| --------------------------------- | --------------------------------- | --------------------------------- | --------- |
| Frames decoded / analysed / dropped | 60 / 60 / 0                       | 60 / 60 / 0                       | ✅        |
| Detections                        | 120                               | 120                               | ✅        |
| Provenance (runtime, model, EP)   | `0.1.0` / `yolox-nano` / CPU      | same                              | ✅        |
| Events persisted                  | 6                                 | 6                                 | ✅        |
| Event streams (whole envelopes)   | —                                 | —                                 | ✅ byte-identical |
| Footage timestamps                | `18:30:00.000` … `18:30:20.000`   | same                              | ✅ **exact**, not within tolerance |
| Track identities (ADR-0041)       | `…_1`, `…_2`                      | `…_1`, `…_2`                      | ✅        |
| Confidence / bbox (6 dp)          | `0.861777` / `0.874177` / …       | same                              | ✅        |
| Findings                          | none                              | none                              | ✅        |
| **Replay speed** (what *should* differ) | `speedFactor 1.01`, 30 s wall | `speedFactor 7.86`, 4 s wall      | ⭐ differs by design |

⚠️ **One stated normalisation: the camera id.** The two runs had to use different cameras, because
running them on one camera is deduplicated to nothing (§6). Track ids embed the camera name and were
normalised by the same substitution; nothing else was touched.

⚠️ **Rule evaluations and incidents are 0 on both sides and that is *not* evidence of parity** — no
enabled rule covers these cameras, so nothing could have been raised. Recorded as an absence, not as
a pass.

---

## 5 · Defects found and fixed

| #   | Defect                                                                                                                                                          | How it was found                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | ⛔ **Raw NUL bytes in five source files.** A composite-key separator written as a literal `\0` byte rather than the escape. `file` reported them as `data`, so **`grep` silently skipped them** — including the media hot path. One feeds a sha1 that derives recording ids | Tried to grep `http-frame-sink.ts` and got nothing back |
| 2   | ⛔ **`confirmUpload` presigned a browser URL for ffprobe.** `Connection to tcp://localhost:443 failed: Connection refused`. Slice 1's confirm step had **never worked in a deployment**; its tests used a fake probe whose double returned one URL shape for both audiences | First deployed upload                      |
| 3   | ⛔ **The event publisher's ordering gate dropped every rerun.** Keyed on `(tenant, camera)`; its restart heuristic needs capture time to move *forward*, but a rerun replays **identical** footage timestamps. Measured `published: 60, droppedOutOfOrder: 60, sessionResets: 0` | The 1×/8× parity run                       |
| 4   | ⚠️ **The parity harness measured nothing.** A virtual sleeper returned instantly while the pacer read the real clock, so 300 s of footage reported 25 hours of sleep. The pacer was right; nothing was measuring it | The assertion failed with an absurd number |
| 5   | ⚠️ **`buildArgs` asserted `-f` absent.** `-f image2pipe` is required; the assertion passed only by accident of ordering | Writing the test                           |

⭐ **Fix 1's second-order payoff:** with the files greppable, a conclusion drawn earlier in this slice
turned out to be wrong — the event publisher *does* stamp `correlationId`, and preserves one the
result already carries. That is what made the whole session-correlation design possible.

⭐ **Fix 3 is the class, not the instance.** The gate is now keyed by the **stream**, and an analysis
session is its own stream. Live is unchanged (no `correlationId` ⇒ same key); ordering is still
enforced strictly *within* a run; `release()` sweeps the prefix; the map is bounded.

---

## 6 · ⛔ Blocked: event identity does not include the analysis session

**A second analysis of the same footage on the same camera produces no events at all.** Recorded as
[L-61](../project/KNOWN_LIMITATIONS.md). Measured: 120 detections offered, `deduped +120`,
`persisted +0`, while the session reported `succeeded / 120 detections`.

The events service dedups on `tenant + type + camera + zone + track + time-bucket`. An offline
analysis stamps `occurredAt` in **footage** time, so a rerun reproduces all six fields exactly — and
because footage time never moves, the collision is **permanent** rather than windowed.

⚠️ **It cannot be fixed inside media.** `correlationId` is unusable as a dedup input because the live
path stamps it **per frame**, so including it would disable deduplication for every live camera.

The fix is for event identity to carry the analysis session — an additive field on the frozen
`EventEnvelope` (ADR-0040) plus a change to `dedupKey`. That is the same `analysisSessionId` ADR-0047
already proposes for `IncidentCandidate`/`Incident`, needed one layer earlier. **Architect decision
required** (frozen contract + ADR), which is a declared stop condition.

Until then: a **first** analysis of a piece of footage on a camera behaves correctly end to end.

---

## 7 · Related

- [OFFLINE_VIDEO_PLAN](../project/OFFLINE_VIDEO_PLAN.md) — the milestone plan
- [MASTER_PROGRESS](MASTER_PROGRESS.md)
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — L-41, L-54, L-57, **L-61**
