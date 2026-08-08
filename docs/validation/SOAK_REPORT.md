# Release Soak — Report

**2026-08-07 20:03:02 UTC → 2026-08-08 02:33:41 UTC · 6.51 hours, uninterrupted, never restarted.**
Commit `9b5a672` at launch, clean working tree. Deployed production stack, single host, no GPU.

---

## Verdict

# ⭐ GO — for the workload exercised, with one finding to schedule

The platform ran a representative customer workload for six and a half hours without a single failed
operation, a single dropped frame, a single container restart, or a single consumer falling behind.
**4 903 timed operations, 0 failed.** The pre-soak and post-soak deployment verifications are both
39/39 green.

⛔ **What this does not say.** See [Scope](#what-this-result-does-not-cover) — this is a synthetic
corpus plus one real phone recording, on one host, for one night. It is not a substitute for real
CCTV, for a GPU deployment, or for multi-day operation, and it must not be quoted as one.

---

## 1 · Headline numbers

| | |
| --- | ---: |
| Duration | **6.51 h** |
| Cycles | **728** |
| Analyses reaching `succeeded` | **644** |
| Frames analysed | **87 378** |
| Detections | **73 693** |
| **Frames dropped** | **0** |
| Timed operations | **4 903** |
| **Failed operations** | **0** (100.00 %) |
| Corrupt files correctly refused | **84** |
| Re-analysis runs of earlier recordings | **161**, 0 failed |
| Parallel uploads | **150**, 0 failed |
| Container restarts | **0** |
| Runtime queue depth, max ever | **0** |
| JetStream max consumer pending, ever | **0** |
| Disk consumed | **0.7 GB** |

---

## 2 · Workload

33 fixtures plus one real portrait recording, rotating. Each finished analysis then exercised
timeline, report/export, playback URL, **a ranged fetch of that URL from the object store**, snapshot
capture and an events query.

| Scene | Runs | Frames | Detections | Det/frame |
| --- | ---: | ---: | ---: | ---: |
| crowded | 44 | 2 640 | 15 840 | **6.00** |
| multi-person | 22 | 1 320 | 2 552 | 1.93 |
| partial visibility | 21 | 1 260 | 1 260 | 1.00 |
| dwell / loitering | 22 | 2 640 | 2 618 | 0.99 |
| fast movement | 21 | 1 260 | 1 113 | 0.88 |
| one person · blur · codecs · resolution ladder | 22 each | 1 320 each | 1 056 each | 0.80 |
| night | 22 | 1 320 | 1 034 | 0.78 |
| rain | 22 | 1 320 | 990 | 0.75 |
| large (5–10 min) | 42 | 37 800 | 22 995 | 0.61 |
| occlusion | 22 | 1 320 | 682 | 0.52 |
| ⭐ **empty scene** | 21 | 1 260 | **0** | **0.00** |

⭐ **Detection density tracks scene content across two orders of magnitude** — 6.00 per frame on a
crowd, 0.00 on an empty room, monotonically sensible in between. The empty-scene row is the negative
control and it is the most important number in the table: earlier the same session, a **fake adapter**
reported a person on 38 of 38 frames of footage that is visibly an empty wall. This is what a real
model does.

⚠️ Detection rate degrades gracefully but measurably in bad conditions — rain 0.75 and occlusion 0.52
against 0.80 for the same content in clear conditions. That is a model characteristic, not a fault,
and it is the kind of number a customer should be shown before they choose camera positions.

---

## 3 · Throughput and latency

**API latency is quoted from a standalone benchmark, not from the in-run series** — see [S-4]: the
in-run probe measured its own contention with a `docker exec` in the same sampler and produced
plausible 77–107 ms outliers that correlated with nothing in the product.

| Query (host quiet, at end-of-run collection size) | p50 | p95 |
| --- | ---: | ---: |
| `analyses?limit=5` | **7 ms** | 9 ms |
| `analyses?limit=50` | 8 ms | 12 ms |
| `analyses?limit=200` | 17 ms | 25 ms |
| `incidents?limit=50` | 32 ms | 45 ms |

No degradation with collection growth. Read operations during the soak:

| Operation | Count | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| `timeline` | 644 | 20 ms | 25 ms | 86 ms |
| `report` (export) | 644 | 20 ms | 25 ms | 110 ms |
| `playback` (signed URL) | 644 | 9 ms | 12 ms | 38 ms |
| `playback-fetch` (object store, ranged) | 644 | 3 ms | 5 ms | 14 ms |
| `snapshot` (real ffmpeg seek + decode) | 644 | 70 ms | 126 ms | 298 ms |
| `events-query` | 644 | 8 ms | 11 ms | **2 639 ms** |

⚠️ The single 2 639 ms `events-query` — 1 in 644, 0.16 % — landed concurrently with a 33-second
analysis of a large recording. Every other read operation stayed under 150 ms except `snapshot`,
which decodes a frame and is expected to.

**Runtime:** fps p50 **19.7**, max 24.1 · inference p95 latency 61.6–99.6 ms · **queue depth 0
throughout**. ⚠️ The `fps` **gauge** dipped to 0.27 twice; neither was a stall ([S-2]) — it is an
instantaneous rate and the workload is bursty. `framesProcessed` rose monotonically and
`droppedFrames` never left 0.

---

## 4 · Stability

**Total resident across seventeen containers: 1 864 MB → 1 999 MB (+7 %) over 6.51 hours.**

| Container | Start | End | Δ | Peak | Peak CPU % |
| --- | ---: | ---: | ---: | ---: | ---: |
| minio | 251.6 | 521.2 | **+269.6** | 604.1 | 11.6 |
| mongodb | 270.4 | 302.2 | +31.8 | 454.4 | 42.1 |
| nats | 79.8 | 104.2 | +24.4 | 141.3 | 3.9 |
| rules | 106.6 | 112.1 | +5.5 | 117.7 | 4.4 |
| workflow | 107.5 | 110.9 | +3.4 | 113.7 | 2.3 |
| inference | 101.5 | 104.2 | +2.7 | 117.5 | **856** |
| media | 167.3 | 145.7 | **−21.6** | 288.7 | 262.5 |
| *(others)* | | | −7.8 … +1.2 | | ≤ 16.5 |

- ⭐ **MinIO is a cache, not a leak.** It peaked at 604 MB and **returned to 310 MB** at 4.5 hours —
  22+ decreases across the run, largest single drop **−226 MB**, a clear sawtooth. ⚠️ At the 2-hour
  mark this looked like unbounded growth at 163 MB/h and was written up as a production risk; the
  later releases retired that reading. The mid-run conclusion was wrong and the correction is
  recorded in [SOAK_FINDINGS](SOAK_FINDINGS.md).
- **MongoDB is flat.** It sat at exactly 292 MB for 18 consecutive samples, touched 454 MB for a
  single sample, and was back at 294 MB on the next — WiredTiger checkpointing.
- **`media` ended 21.6 MB *below* baseline** after 644 analyses. Peak CPU 262 % and inference 856 %
  are multi-core saturation during decode and inference, which is the work being done.
- **File descriptors are flat**: media 37–50, gateway 35–45, events 35–41, workflow 35–40,
  inference 14–21. No growth trend in any service.
- **No container restarted** — every count identical to baseline, verified by `docker inspect` after
  the run. ⛔ Not by the harness, which was measuring nothing: see [S-10].

---

## 5 · Correctness under load

- ⭐ **Perception is deterministic.** Every fixture analysed more than once produced **identical**
  frame and detection counts every time. Zero fixtures varied, across 644 analyses.
- ⭐ **161 re-analysis runs, 0 failed.** ADR-0047's promise — two runs of one recording persisted
  independently — held continuously rather than in a single spot check. This is the property
  [L-61]/V-4 found broken.
- **150 parallel uploads, 0 failed.**
- **84 corrupt files refused, 84 times correctly.** Zero corrupt files were accepted.
- **Export contents agree with their timelines.** 8 exports cross-checked field by field: 0
  disagreements. The downloaded artefact carries full provenance and its own caveat that footage
  start time was assumed from file metadata.
- **UI verified at 0 h, 3 h and 5 h**: playback, detection overlay, marker strip, all four timeline
  lanes, and an export download through the button. JS heap 16 MB after 3 hours.

### The three defects fixed immediately before the soak, holding under it

| | |
| --- | --- |
| **V-15** | `crowd.mp4` — 8 tracks → **8 incidents**. Pre-fix this 30 s clip produced **1**: every subject fell inside one 60 s dedup bucket |
| **V-16** | "Play from here" plays and scrolls the player into view, verified in Chrome |
| **V-17** | All five stored boxes paint for the full **0.48 s** (was 0.25–0.27 s and nondeterministic) |

---

## 6 · Findings

**One product finding. Zero failures.** Full detail in [SOAK_FINDINGS](SOAK_FINDINGS.md).

| # | Severity | Finding |
| --- | --- | --- |
| **S-9** | real, minor | One continuous appearance raises **two** incidents when the footage crosses a wall-clock minute. Pre-existing; **not** introduced by V-15 |
| S-1 | minor UX | A refused upload is indistinguishable from an un-analysed one — no reason shown |
| S-5 | design note | "Play from here" now plays past the detection it seeked to (the ⏮⏭ controls hold it) |
| S-2 | observability | The runtime `fps` gauge reads near-zero when idle and cannot be used as a health signal |
| **S-4, S-10, +1** | ⛔ harness | Three measuring instruments read "fine" when they were reading **nothing** |

### ⛔ S-9 deserves the Architect's attention because of its shape

The non-dwell candidate dedup bucket is an **absolute wall-clock division**:

```
soak res-720p.mp4 · footage starts 00:03:50.432 · ONE track
  incident @1.5s  → 00:03:51.932 → minute bucket 29769123
  incident @10s   → 00:04:00.432 → minute bucket 29769124
```

The **dwell** branch already solves exactly this — it keys on `firstObservedAtMs` with a comment
saying why: *"Two candidates for the same visit are the same candidate however far apart they fall."*
The bucketed branch was given a clock division instead. **That is now twice** — V-15 was the subject,
this is the bucket origin — **that careful reasoning about this one key was applied to one of its two
branches.**

### ⛔ And three instruments were broken, one of them all night

`/proc/1/fd` returned a flat `3`; the snapshot probe hit a 404 route; and `restartCounts()` returned
`{}` for **all 392 samples** because one container has no healthcheck and a single `try` swallowed
the failure for all seventeen. **An empty object compares equal to an empty object**, so "no
container restarted" was two absences agreeing — and it was reported mid-run as though measured. It
was true, confirmed afterwards by `docker inspect`. That is what makes the shape dangerous: a broken
check that agrees with reality is indistinguishable from a working one until the day it does not.

---

## 7 · Production risks

| Risk | Assessment |
| --- | --- |
| Incident counts inflated by clock-minute straddling (**S-9**) | **Real.** Affects any recording crossing a minute boundary. Schedule before a customer counts incidents for an SLA |
| Alert volume after V-15 ([L-69]) | **Real, intended.** One incident per subject rather than per rule. A busy entrance can raise tens per minute where it raised one. `RULES_CANDIDATE_DEDUP_WINDOW_MS` is the knob |
| Dedup keeps the *first* observation, not the strongest ([L-70]) | **Real, and it changes rule outcomes** — 51 % stored where the model peaked at 93 %, against a rule requiring 75 % |
| COCO false positives persisted as findings ([L-71]) | **Real.** A clothes rail was stored as `tie` on 20 of 38 frames of the Architect's own recording |
| Memory growth | **Not a risk at this duration.** +7 % total over 6.51 h, MinIO demonstrably bounded |
| Throughput / queueing | **Not a risk.** Queue depth and consumer lag were 0 for the entire run |
| Disk | **Not a risk.** 0.7 GB for 644 analyses; 296 GB free |

---

## 8 · Recommended actions

1. **Schedule S-9.** Bucket relative to `footageStartedAt`, or key on the track's first-observed
   instant as the dwell branch already does. It is a design decision, not a bug fix.
2. **Decide on [L-70]** — keeping the strongest observation in a bucket rather than the first. It is
   the highest-value correctness change available and it belongs with [ADR-0049].
3. **Give MinIO an explicit container memory limit** before a long-lived deployment. Not a risk at
   6.5 hours; a 6.5-hour window cannot characterise a month.
4. **Fix S-1** — say why a refused upload was refused.
5. **Run this soak again after S-9**, and on a GPU host, and against real CCTV ([L-64]).

---

## What this result does not cover

⛔ **The result applies only to the workload exercised and does not replace future real-CCTV or
production-environment validation.**

- **No real CCTV.** Synthetic fixtures plus one phone recording. No RTSP, no IP camera, no ONVIF, no
  multi-day continuous stream ([L-64]).
- **No GPU.** Every throughput figure is `CPUExecutionProvider`.
- **One host, one tenant.** No cross-tenant contention, no multi-node behaviour, no network partition.
- **No multi-gigabyte upload** ([L-66]). Largest file 15.25 MB; longest recording 10 minutes.
- **6.5 hours is not a month.** Bounded-cache behaviour observed here does not characterise 30 days.
- **The corpus is uniform in ways reality is not.** Every generated fixture is exactly 30.000 s — the
  property that hid V-11 from 37 clips ([L-63]). One real recording was added deliberately; one is
  not many.

---

## Related

- [SOAK_BASELINE](SOAK_BASELINE.md) · [SOAK_METRICS](SOAK_METRICS.md) · [SOAK_FINDINGS](SOAK_FINDINGS.md)
- [SOAK_TIMELINE](SOAK_TIMELINE.md) · [SOAK_REGRESSION_TESTS](SOAK_REGRESSION_TESTS.md)
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — L-69, L-70, L-71 added by this session
