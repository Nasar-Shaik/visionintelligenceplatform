# Release Soak — Findings

Everything the soak surfaced, including the items that turned out to be nothing. **The ones that
turned out to be nothing are here on purpose**: a soak that reports only confirmed defects gives no
account of what was examined, and "we looked at MinIO's memory and it was fine" is a different
statement from "we did not look".

Nothing here was fixed while the soak was running. Changing the product mid-run would mean the
baseline no longer described what was deployed, and the run would have to start again.

---

## Product findings

### S-9 · One continuous appearance raises two incidents when the footage crosses a wall-clock minute

**Severity: real, minor · pre-existing · not introduced by V-15**

The non-dwell candidate dedup bucket is `Math.floor(Date.parse(occurredAt) / 60000)` — an
**absolute wall-clock division**. Confirmed on the deployed stack:

```
soak res-720p.mp4 · footage starts 00:03:50.432 · ONE track
  incident @1.5s  → 00:03:51.932 → minute bucket 29769123
  incident @10s   → 00:04:00.432 → minute bucket 29769124
```

One person, one unbroken appearance, two incidents — decided by **where the recording happened to
sit relative to a clock minute**, and by nothing about the footage or the subject. Re-running the
same recording ten seconds earlier would produce one.

#### ⛔ It is the same class as V-15, which is what makes it worth the Architect's time

The **dwell** branch already solves exactly this. It keys on
`dwell.outcome.record.firstObservedAtMs` — the moment the visit started — with a comment saying why:
*"Two candidates for the same visit are the same candidate however far apart they fall."* The
bucketed branch was given an absolute clock division instead.

That is now **twice** that careful reasoning about this key was written down and applied to one of
its two branches. V-15 was the subject; this is the bucket origin.

**Not fixed.** The remedy is a design decision: bucket relative to `footageStartedAt`, or key on the
track's first-observed instant as dwell does. Both change live behaviour and belong to the Architect.

---

## Product observations

### S-1 · A refused upload is indistinguishable from an un-analysed one

**Severity: minor UX**

`corrupt-not-a-video.mp4` was correctly refused at confirm; the record remains at `state: draft`.
The Investigation page then reads *"This recording has not been analysed yet — Run the analysis to
push it through the same runtime…"* with both action buttons disabled and **no reason given**.

⚠️ The rejection was right. The *account* of it never reaches the operator, who sees a recording that
looks merely un-analysed and a button that does nothing when clicked. 36 refusals were honoured
correctly during the soak, so the behaviour is consistent — it is the explanation that is missing.

### S-5 · "Play from here" now plays past the detection it seeked to

**Severity: design note, introduced by V-16**

Clicking a stored moment seeks, scrolls the player into view and plays. 900 ms later the playhead has
moved past the box's ±0.25 s window and the badge reads *"nearest stored frame 00:02 · 0.7 s back"*.

That is correct — a box owns only the interval it was measured in — but it means the one-click path
from a timeline row to a detection shows it briefly. ⭐ The paused path exists and is separate: the
transport's ⏮ ⏭ controls step between analysed frames **without** playing, holding the box. Two
intents, two controls. Worth the Architect's judgement on whether a timeline row should pause instead.

---

## Examined and found sound

### S-6 · MinIO memory — cache, not a leak

Rose from 252 MB to a peak of 603 MB and **returned to 310 MB** at 4.5 hours. Classified on the
evidence that it releases: **22+ decreases across the run, largest single drop −226 MB**, in a clear
sawtooth. ⚠️ At the 2-hour mark this looked like unbounded growth at 163 MB/h and was written up as a
production risk; the later releases retired that reading. **Recorded because the mid-run conclusion
was wrong and the correction is the useful part.**

### MongoDB memory — flat, with checkpoint spikes

270 → ~296 MB across the run. Sat at **exactly 292 MB for 18 consecutive samples**, touched 453 MB
for a single sample, and was back at 294 MB on the next. Single-sample spikes that release
immediately are WiredTiger checkpointing, not growth.

### S-2 · The runtime `fps` gauge cannot be used as a health signal

Two samples reported **1.179** and **0.274** fps. Neither was a stall: `framesProcessed` rose
monotonically through both, and every analysis completing in the surrounding window did 60/60 frames
with 0 dropped. The gauge is an *instantaneous* rate and the soak's 20 s inter-cycle gap leaves the
runtime idle at sampling time. ⚠️ On a bursty workload the reliable signals are the `framesProcessed`
delta and `droppedFrames`.

### S-3 · Negative control holds

`empty-scene.mp4` analysed 60/60 frames and returned **0 detections**. Stated explicitly because a
fake adapter checked earlier the same session reported a person on 38 of 38 frames *including frames
that are visibly an empty wall*. This is what a real model does on an empty scene.

### S-8 · Perception is deterministic

**Zero** fixtures analysed more than once showed any variation in frames or detections. 136
re-analysis runs of previously uploaded recordings, 0 failed — ADR-0047's promise holding
continuously rather than in a single spot check, which is the property [L-61]/V-4 found broken.

### Export contents agree with their timelines

8 exports cross-checked field by field against the timelines they summarise: **0 disagreements**. The
downloaded artefact carries full provenance (capability, pipeline version, runtime version, model id,
execution provider, frame rate), source metadata, per-incident rule id/name/version and triggering
event — and its own caveat that the footage start time was assumed from file metadata. ⭐ That caveat
travelling with the artefact is what makes it usable as evidence rather than a claim.

### One slow read in 548

`events-query` returned once at **2 639 ms** against a p95 of 11 ms, concurrent with a 33-second
analysis of a large recording. 1 outlier in 548 (0.18 %). No other read operation exceeded 150 ms
except `snapshot` (22 of 547), which performs a real ffmpeg seek and decode.

---

## Findings in the measuring instrument

⛔ Three harness defects, all found before or during the run. They are listed with the product
findings because **a broken instrument reads as a healthy product**, which is the more dangerous
failure.

| # | Defect | Why it mattered |
| --- | --- | --- |
| — | `/proc/1/fd` reported a flat `3` for every service | A metric that cannot move reads as "no fd leak" for six hours and would have done so through one. Fixed to count every PID; now moves (14–50) |
| — | The snapshot probe used `/analyses/{id}/snapshot`; the route is `/snapshots` | Recorded a 404 as a failed operation instead of exercising evidence generation at all |
| **S-4** | The API latency probe ran concurrently with a `docker exec … python` in the same sampler | Produced plausible **77–107 ms** outliers that correlated with nothing in the product — two of three spikes had no analysis in flight, while many 10–17 ms samples did. Probed standalone with the host quiet: **p50 7 ms / p95 9 ms** at the same collection size |
| **S-10** | `restartCounts()` returned `{}` for the entire run | ⛔ **The worst of the three, and it survived the whole soak.** See below |

### ⛔ S-10 · The restart metric never worked, and I reported its silence as evidence

The inspect template was `{{.State.Health.Status}}`. `vip-prod-proxy-1` has **no healthcheck**, so
`.State.Health` is nil, `docker inspect` fails on that one container, and a `try` wrapped around the
whole loop swallowed it and returned an empty object **for all seventeen**.

⚠️ **An empty object compares equal to an empty object.** So the generated report's *"No container
restarted — counts identical at first and last sample"* was derived from two absences, and I repeated
that conclusion to the Architect at the 60- and 120-minute marks as though it were measured.

It was true. `docker inspect` afterwards shows every count identical to baseline (mongodb 9, minio 13,
all others 0, all healthy). ⛔ **That is exactly what makes this shape dangerous** — a broken check
that happens to agree with reality is indistinguishable from a working one until the day it does not,
and the day it does not is the day a container is crash-looping.

Two fixes, the second mattering more than the first: `{{if .State.Health}}…{{end}}` so a container
without a healthcheck is handled rather than fatal, and a **per-container** try so one awkward
container can never blank the metric for the rest. A container that cannot be inspected is now
recorded as `uninspectable` rather than omitted — a gap the report can see beats a gap it cannot.

⭐ Same class as the `/proc/1/fd` bug found before the run started, and the same class as
[absence-hides-defects]: **when a check reports an absence, ask what else produces that absence.**
Three instruments, three ways of reading "fine" when they were reading nothing.

⚠️ **S-4 was not corrected mid-run.** The fix is in the file for future soaks; restarting a healthy
run to repair a measurement bug would have discarded valid product data. The report therefore quotes
the standalone benchmark for latency and treats the in-run series as indicative only.

---

## Related

- [SOAK_REPORT](SOAK_REPORT-2026-08-08.md) — the verdict · [SOAK_METRICS](SOAK_METRICS-2026-08-08.md) — the series
- [SOAK_BASELINE](SOAK_BASELINE-2026-08-08.md) · [SOAK_REGRESSION_TESTS](SOAK_REGRESSION_TESTS-2026-08-08.md)
- [KNOWN_LIMITATIONS](../project/KNOWN_LIMITATIONS.md) — L-69, L-70, L-71
