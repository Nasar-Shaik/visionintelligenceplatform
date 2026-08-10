# Evidence Integrity — engineering report

**Milestone:** Evidence Integrity (EI-1 … EI-7) · **Closed:** 2026-08-10 · **Branch:** `feature/v1`

> The platform's whole proposition is *explainable evidence*. This milestone existed because an
> investigation opened an hour after a run showed fewer facts than the same investigation opened
> immediately — and nothing on screen said anything had been lost.

---

## 1. The defect, as it presented

A completed analysis answered `{carried: 3, picked: 3, observed: 5}` at one minute and
`{observed: 2}` at ten. Same run, same query, fewer facts. No error, no warning, no field anywhere
saying evidence had gone.

⛔ **The reassuring failure.** An investigator reading the second answer concludes *nothing much
happened*. That is the one conclusion the platform must never produce by accident.

---

## 2. Root causes — four of them, each measured before it was fixed

### 2.1 Shutdown discarded open evidence *(EI-3)*

```
BEFORE restart   live_identities=3   records=5214   write_failures=0
⏻ docker restart vip-prod-inference-1
AFTER  restart   live_identities=0   records=5214   write_failures=0
                                     ▲▲▲▲▲▲▲▲▲▲▲▲ unchanged
```

`write_failures` stayed at zero **because nothing was ever attempted**. The runtime handled SIGTERM
gracefully — stopped the heartbeat, drained sessions, closed the HTTP server, inside a 20-second
`stop_grace_period` it never needed — and had never flushed track history. `retire_stream` and
`drain_pending` had both existed since ADR-0051; nothing called them when the process was asked to
stop.

⚠️ **A hypothesis was measured and discarded first.** "Retirement runs on the frame path, so a stream
that stops sending frames is never retired" was wrong: `retired` rose 101 → 151 and `records` rose
5164 → 5214 as a run ended, and all 50 were written.

### 2.2 One fact held at two precisions *(EI-3, the subtler half)*

Flushing made evidence *survive* a restart. It did not make it *identical*. Comparing every leaf
field of every graph node across a restart, exactly two moved, on exactly the three live→durable
identities:

```
person    directionDegrees       93.1173 →  93.1216
car       directionDegrees      100.3144 → 100.3131
          pathLengthNormalized   0.026627 → 0.026626
backpack  directionDegrees      309.1818 → 306.8699
          pathLengthNormalized   0.000006 → 0.000009
```

⭐ `samples` and `durationSeconds` were **identical**, which eliminated point loss, gain, reordering
and truncation in one observation. `HistoryPoint.to_dict()` had always rounded to six decimals on the
way to disk while the in-memory point kept full precision — so a live read and a durable read of the
*same observation* derived from different coordinates. On a near-stationary object whose entire
displacement is ~1e-5, a 1e-6 rounding is a ten-percent perturbation.

Rounding at the storage boundary is correct. **Holding one fact at two precisions is the defect.**
Fixed by rounding once, at observation, via a single named `STORED_PRECISION`.

### 2.3 Nothing closed a run when it ended *(EI-3b — the root cause above the others)*

```
BEFORE  live_identities=28  live_streams=12  records=5259  write_failures=0
⏻ docker kill -s KILL
AFTER   live_identities=0   live_streams=0   records=5259  write_failures=0
```

⛔ **28 identities across TWELVE finished analyses**, on a stack idle for 26 minutes. Nothing told
the runtime an analysis had ended: the worker delivered its last frame and stopped, and the
identities still in shot stayed in memory until the 300-second camera sweep happened to run — which
runs on the *frame* path, so a deployment that has gone quiet never ran it at all.

⚠️ **This is why the EI-3 shutdown fix was not enough, and could never have been.** SIGKILL, an OOM
kill, a lost host and an expired `stop_grace_period` never consult the process. The window between
"the run finished" and "something eventually retires it" is where every one of them does its damage.
The fix is not a better shutdown — it is **not holding finished evidence in memory at all**.

### 2.4 A torn write destroyed the record after it *(EI-3b)*

A record is one JSON line; a buffered writer flushes every 8192 bytes; a real record is bigger:

```
  1 point  →     421 bytes   one buffer
100 points →  22 093 bytes   ⛔ three flushes
512 points → 112 733 bytes   ⛔ fourteen flushes  (DEFAULT_MAX_POINTS)
```

So a kill mid-flush leaves an unterminated line — ordinary, not exotic: 100 points is a subject
tracked for under a minute at 2 fps. The next append landed on that line, and the pair parsed as
neither:

```
wrote id_a, id_b, id_c   ⏻ killed mid-id_c   then wrote id_after
records() → ['id_a','id_b']        stats()['records'] → 3
```

⛔ `id_after` was written **in full, afterwards, by a healthy process** — and it was gone. One
interruption cost two records, and the second was never at risk.

⚠️ **The EI-3 fix made this more likely, not less**: `retire_all` writes every open identity in one
burst at exactly the moment the process is being torn down.

---

## 3. Why these happened

They share one shape: **a duty nobody owned at the moment it mattered.**

| Defect | The duty | Who was assumed to hold it | Who actually did |
| --- | --- | --- | --- |
| Shutdown | flush open evidence | the shutdown handler | nobody |
| Two precisions | round once | `to_dict` *and* the in-memory point | both, differently |
| No end-of-run close | close a finished run | the camera sweep | nobody, on a quiet stack |
| Torn write | terminate a record | the writer's buffer | the kernel, sometimes |

⚠️ **Every one was invisible to unit tests**, because every unit test constructs its own state and
tears it down cleanly. What found them was measuring the deployed stack across a lifecycle event —
which is the only place a lifecycle defect exists.

⭐ And every one produced a **plausible number**: `records=5259` twice, `write_failures=0`,
`directionDegrees=93.1216`, `records()` returning 2. Nothing looked broken.

---

## 4. Architectural analysis

**Nothing was redesigned.** The single pipeline, the behaviour layer, the graph, the reasoning engine
and the console are unchanged. The frozen foundations were not touched, and no ADR was superseded.

What was added, and why each is not a second pipeline:

| Change | Why it is inside the existing architecture |
| --- | --- |
| `retire_all()` at shutdown | drives `retire_stream` + `drain_pending`, which the camera sweep already called |
| `POST /tracking/streams/close` | a lifecycle message on the **existing** media→runtime seam; boundary §A still finds exactly one caller |
| `STORED_PRECISION` | one constant replacing two independent roundings |
| single-syscall write + boundary repair | the same store, the same file, the same format |
| `IntegrityReport` | returned by the read that already parses; no new scan |
| six-state evidence model | a pure function over facts the read already had |

⛔ **Explicitly not built:** no second persistence pipeline, no secondary storage service, no
background synchroniser, no recovery daemon, no duplicate runtime.

⚠️ **Tracker state is deliberately untouched by the close.** Retiring an identity's history is not
the same act as forgetting how to track it; `_CameraState` is still released by the sweep on its own
schedule. Conflating them would have changed tracking behaviour to fix a storage bug.

### The one decision split across two layers, and why it is not duplication

`EXPIRED` cannot be decided in the runtime. The runtime holds **records**, not **runs**: asked about
a stream it has none for, it cannot tell "this analysis never existed" from "this analysis is older
than retention" — both are silence, and inventing the difference from a tenant-wide purge counter
would be a guess dressed as a fact.

So the runtime publishes `retentionHorizonAt`; media holds `finishedAt`; a run that finished before
the horizon **cannot** have surviving records. ⭐ A proof, not an inference — and the decision is
made **once**, in the only place both facts exist. The same seam later resolved `LOST`, for the same
reason: a restarted runtime has no memory of what the killed one was holding, and the session
outlives the restart.

---

## 5. The six-state evidence model *(EI-4)*

Measured before it existed — every one of these was the empty list:

```
a stream that never existed        →  []
a run still three seconds in       →  []
a run whose durable write failed   →  []
a file with a truncated record     →  []
a run past its retention           →  []
```

Five facts, one answer, and the answer is the reassuring one.

| State | Means | Decided from |
| --- | --- | --- |
| `present` | here and closed | records found, none open |
| `notYetAvailable` | still being produced; durations are lower bounds | live records > 0 |
| `absent` | none, and none was lost | nothing found, nothing wrong |
| `lost` | existed, and the platform failed to keep it | failed write, or the session recorded a loss |
| `corrupted` | on disk and unreadable | the read could not parse a line |
| `expired` | retention removed it, as promised | finished before the horizon |

⭐ **The precedence is the specification**, not a convention: damage is checked before emptiness, loss
before emptiness, expiry only ever upgrades `absent`. `CORRUPTED` outranks `PRESENT` because four
readable records out of five render exactly like four out of four.

⚠️ Enforced at the boundary by **§L, checked both ways**: a state the contract rejects breaks the
read, and a state nothing produces is a console branch that can never render — which is how a
carefully-written banner sits dead in a codebase for three milestones.

---

## 6. Replay verification

Acceptance was raised mid-milestone from "no evidence lost" to **byte-identical**.

| Condition | Provenance differences | Evidence |
| --- | ---: | --- |
| Immediately, same process | 3 | ⭐ byte-identical |
| After a **service** restart (media) | 3 | ⭐ byte-identical |
| After a **runtime** restart | 3 | ⭐ byte-identical |
| After a **deployment** restart (`--force-recreate`) | 3 | ⭐ byte-identical |
| After an **ungraceful SIGKILL** | 3 | ⭐ byte-identical |
| After **one hour** | 6 | ⭐ byte-identical |
| After a **host reboot** | — | not performed; see § 9 |

⭐ At one hour the count is 6 rather than 3: the same three `retentionHorizonAt` fields, plus three
recorder counters — `identitiesRetired 0 → 278`, `pointsObserved 0 → 14 972`, `store.records
5616 → 5894`. ⚠️ Those moved because **other analyses ran on the same runtime during the hour**,
which is precisely why they are provenance: they describe the process, not this run.

⭐ **That makes the +1 h result stronger than an idle hour would have been.** This stream's evidence
was byte-identical across sixty-one minutes in which 278 other identities were retired and 278
records appended to the same store, through a media restart, a runtime restart, a deployment
`--force-recreate` and a `SIGKILL`. A quiet hour would have proven far less.

The three constant ones are `evidence.retentionHorizonAt` on the timeline, graph and primitives views — `now −
72 h`, which moves by exactly the time between reads. **Documented and justified in the tool, not
ignored**, and scoped to that one field: `state`, `records`, `durable`, `live`, `damagedRecords` and
`lostIdentities` all still fail the diff, because a read silently changing from `present` to `absent`
is the single thing this milestone exists to catch.

⚠️ The replay tool **found that field itself** — three differences after a media restart on a run
whose evidence had not moved. The tool was right and the field was new.

⭐ Before the end-of-run close, a restart produced **14** provenance differences as records moved
from live to durable. It now produces **3**, because nothing is live at the first read.

---

## 7. Regression tests added

All written to **fail against the implementation that shipped Phase 2**, and each from a measurement
taken first.

| Suite | Tests | What fails without the fix |
| --- | ---: | --- |
| `test_evidence_durability.py` · shutdown | 7 | open identities discarded at SIGTERM |
| `test_evidence_durability.py` · precision | 4 | live and durable reads disagree in the 7th decimal |
| `test_evidence_durability.py` · torn writes | 6 | a tear destroys the next record; damage is silent |
| `test_evidence_durability.py` · lost identities | 3 | a failed write names nothing |
| `test_stream_close.py` | 10 | the runtime is never told a run ended |
| `test_evidence_state.py` | 18 | five silences render identically |
| `analysis-worker.test.ts` | 17 | terminal runs do not close; `absent` hides `lost`/`expired` |
| `behaviour-surface.test.tsx` | 6 | the operator never sees a state word |

**Totals:** Python 1503 → **1540**; media 366 → **384**; console 630 → **636**. Gate **70/70**.

---

## 8. Stress verification *(EI-5b)*

24 analyses, concurrency 4–6, cancellations throughout, on built images.

| | With one ungraceful SIGKILL mid-run | Control — no restart |
| --- | --- | --- |
| Runs that detected something | 14 | 21 |
| …that read all of it back | **13** | ⭐ **21 of 21** |
| Loss, reported as `lost` not `absent` | 1 | 0 |
| Corrupted reads | 0 | 0 |
| Durable write failures | 0 | 0 |
| Live identities after the last run | 0 | 0 |
| Live buffer drain time | 0 s | 0 s |

⭐ **The pair is the point.** With a kill, evidence held in memory by the killed process is genuinely
unrecoverable and the requirement is that the read *says so*; with no kill, the requirement is that
nothing is lost at all. Either result alone proves nothing.

⚠️ **The harness's own first version was wrong**, and it is worth recording: it reported "9 of 23
runs read back nothing" when none had lost anything — they had run while the runtime was deliberately
dead and correctly found nothing. The instrument could not tell *saw nothing* from *saw something and
lost it* — the exact confusion the milestone is about, reproduced in the thing measuring it. Every
assertion is now conditioned on `counts.detections`.

⛔ **This is how the `LOST`-as-`ABSENT` defect was found**: one run with 69 detections, SIGKILLed
mid-flight, reading `absent`. The session had recorded the loss twice; the behaviour read had not.

**120 analyses × 2 runs with three kills** is registered as the nightly `evidence` stage in the same
commit — past the 15 minutes a milestone gate may spend, and scale is exactly where these defects
live (28 identities across 12 runs, accumulated in 26 minutes of ordinary use).

---

## 9. Remaining limitations

⚠️ **Stated as gaps, not as passes.**

- **The +1 hour replay** was launched and its result is recorded separately. Structurally the concern
  it tested — "live records expire between reads" — no longer exists, because a run holds nothing
  live once it ends. That is an argument, not a measurement, until the check reports.
- **Host reboot: not performed.** It needs the developer machine restarted. What it would add over
  the deployment restart already proven is the page cache being lost — which matters only because
  `write()` is **not `fsync`ed** (below).
- ⛔ **Writes are not power-safe.** `write()` returns once the data is with the kernel, not once it is
  on the platter. A host that loses power can lose acknowledged records. Making every write
  `fsync` was **not** done: it was not measured, and the cost lands on `retire_all`, which writes a
  burst at shutdown. This is a real, stated gap — the platform survives process death, not power
  death.
- **A cancelled run keeping what it saw is unproven on real footage.** Every cancelled run in the
  stress suite detected nothing before stopping, because the clip is short and analysis is fast. The
  unit tests cover the path; the end-to-end evidence does not exist yet. **PENDING FOOTAGE.**
- **A pre-existing narrow race, found and not fixed** (out of scope, recorded rather than silently
  carried): a cancellation landing before the first frame of a chunk leaves the offset unadvanced, and
  the worker's "a chunk that did not advance ends the run" guard then reports `succeeded` rather than
  `cancelled`. No evidence is lost; the state word is wrong.
- **Damaged lines cannot be attributed to a stream.** Attributing one would need the parse that just
  failed. A scoped read therefore reports *this tenant's history is damaged*, never *this analysis
  lost a record*.
- **`stats()['records']` is a line count, not a parse.** Making it authoritative was measured and
  rejected: 251.7 ms against 13.8 ms at the retention cap, on an endpoint scraped every 15 s. The
  difference between it and a read is published as `damagedRecordsSeen`.

---

## 10. Production readiness

| | State |
| --- | --- |
| Repository gate | ⭐ **70/70** |
| Python suite | ⭐ **1540** |
| Contracts | ⭐ 70 schemas · perception boundary **§A–§L** |
| Deployment | ⭐ 17/17 containers, verified via `prod.sh`, never `pnpm dev` |
| Replay | ⭐ byte-identical across service, runtime, deployment and SIGKILL |
| Stress | ⭐ control clean; loss under kills reported, never silent |
| Browser | ⭐ **212 passed · 0 failed** · chromium 58 · edge 58 · firefox 48 · webkit 48 |
| Power-loss durability | ⚠️ **not provided** — no `fsync` (§ 9) |

⭐ **A completed run's evidence no longer changes after the run completes.** That was the milestone's
one-sentence acceptance criterion, and it holds across every lifecycle event that can be tested
without cutting power to the host.

⛔ **What is genuinely different now** is not only that less is lost. It is that when something *is*
lost, the platform says which of six things happened — and `LOST` can no longer wear the costume of
`ABSENT`, which is the disguise that makes a missing person look like a quiet afternoon.

---

## 11. Browser certification

Full matrix against the deployed stack, 19.8 minutes:

| Engine | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| chromium | 58 | 0 | **0** |
| edge | 58 | 0 | **0** |
| firefox | 48 | 10 | **0** |
| webkit | 48 | 10 | **0** |

| Spec | Passed | Skipped |
| --- | ---: | ---: |
| `security.spec.ts` | 36 | 0 |
| `behaviour.spec.ts` | 32 | 0 |
| `performance.spec.ts` | 28 | 0 |
| `association.spec.ts` | 20 | 0 |
| `journey.spec.ts` | 16 | 0 |
| `crossline.spec.ts` | 12 | 0 |
| `surface.spec.ts` | 50 | 2 |
| `livecam.spec.ts` | 18 | 18 |

⚠️ The 18 `livecam` skips are firefox and webkit: a fake camera device is a Chromium-family
capability, so live capture is certified on chromium and edge only. That is the standing pattern, not
a regression — and the physical-camera crossing remains a manual UAT step whatever the engine.

---

## 12. Verification log

Every number in this report came from the deployed stack on built images. Commits, in order:

```
d225266  EI-1..EI-3   the evidence loss, root-caused by measurement and fixed at shutdown
b2374ca  EI-3         replay is byte-identical — the second, subtler half of the loss
08eef4c  EI-1b/EI-3b  a torn write must not destroy the record after it
894367a  EI-3b        the run tells the runtime when it ends — the root cause, one level up
4ed2fe0  EI-4         six evidence states, because five silences used to look the same
9b5cc68  EI-5b        evidence under load — and a lost run that read as absent
```
