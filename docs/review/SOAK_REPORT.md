# Platform Soak Report — 2026-08-07

**Status: ⚠️ INTERRUPTED.** 67 of 78 samples. **5.51 hours of measured platform operation** against a
6.5-hour target, over 6.87 hours of wall clock.

> ⚠️ **The interruption is not the important finding.** The platform ran for five and a half hours
> without a single defect: memory flat to 0.0 %, FPS stable to 0.5 %, frame accounting balancing
> exactly, zero container restarts, zero file-descriptor growth. **The important finding is that my
> own instrument went half-blind seventeen minutes in and reported the blindness as zeros.**

Evidence: [`soak/2026-08-07-samples.json`](soak/2026-08-07-samples.json) (67 samples, flushed per
sample) · [`soak/2026-08-07-run.log`](soak/2026-08-07-run.log)
Harness: [`platform-soak.mjs`](platform-soak.mjs) · [`soak-profiles.mjs`](soak-profiles.mjs)

---

## 1 · Recovery audit

| #   | Question                             | Answer                                                                                                          |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1   | Completed or interrupted?            | **Interrupted.** 67/78 samples, `aborted: null` — it was still running when stopped                             |
| 2   | Exact interruption time              | **System sleep 2026-08-07T03:25:29Z → 04:39:47Z** (08:55–10:09 IST), 4458 s where 300 s was due                 |
| 3   | Stage executing                      | The sampling loop, between sample 65 and 66. No setup, teardown or analysis was in flight                       |
| 4   | Was SOAK_REPORT.md produced?         | **No** — the run never reached its analysis phase. This document is written from the preserved samples          |
| 5   | Partial evidence preserved?          | ✅ **Fully.** 483 KB, all 67 samples, because evidence is flushed after **every** sample rather than at the end |
| 6   | Deployment integrity still green?    | ✅ **Green** — byte-for-byte at `f367db01`, verified after the interruption                                     |
| 7   | Working tree still clean?            | ✅ Clean, and it was clean at **all 67 samples** (the continuous probe checked every one)                       |
| 8   | Docker/services restarted correctly? | ✅ **Nothing restarted.** All 17 containers healthy; restart counts unchanged 21 → 21 across the run            |
| 9   | Corruption?                          | ✅ **None.** JSON parses, counters monotonic, queues drained to 0, disk unchanged, max clock drift 1 s          |
| 10  | Resume or restart?                   | ⛔ **Restart** — and the reason is §3, not the sleep                                                            |

### ⚠️ The premise was wrong, and correcting it matters

**The Mac did not shut down.** `kern.boottime` is 2026-07-26 — twelve days of uptime, no reboot in
`last`. The battery drained to 8 % and macOS **force-slept** the machine for 74 minutes.

`caffeinate -i` holds `PreventUserIdleSystemSleep`, which prevents _idle_ sleep. It does not prevent
low-battery sleep, and it was still holding its assertion when the machine went down.

**Proof it was sleep and not a restart**, from the platform's own counters: the AI runtime's uptime
advanced **316 seconds across a 4458-second wall-clock gap**. The container's clock was frozen and
resumed; it did not reset. Container restart counts are identical either side.

**The platform survived the suspend/resume cleanly.** Sample 67 returned to 3.93 fps at 1.99
detections per frame, both cameras `healthy connected` with ~41,000 frames received and **0 reconnect
attempts**. The control plane re-placed two cameras (`place-failed` → recovered), which is the
failover path doing its job.

---

## 2 · Results over 5.51 measured hours

**Commit `f367db01` · deployment `f367db01` (byte-verified before and after) · profile
`retail-loitering` · 2 cameras (supported sizing) · 5-minute cadence.**
Environment: macOS, 17 production containers, synthetic RTSP, `yolox-nano` on CPU, host also running
unrelated dev stacks.

### Everything the Prometheus half measured — and it is uniformly good

| Signal                     | Result                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Memory — AI runtime**    | avg **186.2 MB**, peak 186.2 MB, trend **+0.0 %** ⭐                                           |
| **Memory — service heaps** | media +1.2 % · rules −0.1 % · events −0.4 % · camera +0.7 % · workflow +0.2 % · gateway +1.2 % |
| **CPU — AI runtime**       | avg **118.7 %**, peak 229.5 %                                                                  |
| **CPU — services**         | media 5.3 % · camera 1.1 % · events 0.9 % · **rules 0.5 %**                                    |
| **FPS**                    | mean **3.99**, range 3.93–4.02, **CV 0.5 %** ⭐                                                |
| **Frames**                 | offered **81,624** · delivered 80,919 · dropped 680 (**0.83 %**) · failed 4                    |
| **Frame accounting**       | **81,624 == 81,624** — balances exactly ⭐                                                     |
| **Detection consistency**  | **1.99–2.00 per frame** for five and a half hours ⭐                                           |
| **Queues**                 | perception **peak 0** · publisher **peak 0** · runtime **peak 0**                              |
| **Inference p95**          | avg 104.0 ms, peak 124.5 ms, trend **−3.5 %**                                                  |
| **Rule evaluation**        | avg **1.61 ms**, peak 2.04 ms, trend −6.3 %                                                    |
| **Candidate latency**      | avg 77.0 ms, peak 85.2 ms, trend −3.0 %                                                        |
| **Event ingest**           | avg 1.93 ms, peak 2.07 ms, trend −1.3 %                                                        |
| **File descriptors**       | media 31→31 · rules 25→25 · events 24→24 · camera 42→42 · gateway 21→21 ⭐                     |
| **Event loop**             | never starved on any service                                                                   |
| **Broker**                 | connected at **every** sample · 0 redelivered · 0 dead-lettered                                |
| **Container restarts**     | **0**                                                                                          |
| **Disk growth**            | **0 MB**                                                                                       |
| **Clock drift**            | max **1 s**                                                                                    |
| **Exceptions**             | **5 log lines**, all at the wake, all `place-failed` assignment events                         |
| **Warnings**               | 3                                                                                              |

⭐ **All four latency trends are negative.** Nothing crept. The rule engine held 0.5 % CPU and 1.61 ms
evaluation for the whole run — consistent with the P-8.7 benchmark's finding that rule evaluation is
nowhere near the bottleneck.

⭐ **Zero file-descriptor growth on every service** is the single most valuable result here, because it
is the class of failure a ladder structurally cannot see and this is the first run long enough to
look.

### ⚠️ Three observations that are not failures but are not nothing

| Observation                            | Measured                   | Assessment                                                                                                                                                                                               |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Publisher out-of-order: 9,567**      | 13.4 % of 71,347 published | ⚠️ **Unexplained and recorded as such.** Two cameras publish concurrently; ADR-0042 makes ordering a non-guarantee, but the magnitude has never been characterised. **Do not dismiss without measuring** |
| **Assignment: 4 changes, 2 failovers** | all at the wake            | Consistent with re-placement after the sleep; the plan never diverged from the enforcement point (0 divergent samples)                                                                                   |
| **Session resets: 1**                  | at the wake                | One publisher session reset across 5.5 h, at the suspend/resume boundary                                                                                                                                 |

---

## 3 · ⛔ Why this run cannot be certified, and it is not the sleep

**The harness authenticates once and never refreshes. `JWT_ACCESS_TTL` is 15 minutes.**

At sample 3 — **17.6 minutes in** — every API-derived signal went to zero and stayed there for the
remaining 64 samples:

| Signal                | Samples 1–2 | Samples 3–67 |
| --------------------- | ----------- | ------------ |
| streams healthy/total | 2/2         | **0/0**      |
| cameras recording     | 2           | **0**        |
| dwell timers          | 2           | **0**        |
| dwell state entries   | 4           | **0**        |
| incidents raised      | 4           | **0**        |
| new recordings        | present     | **0**        |

⛔ **Every one of those zeros was false.** Cleanup at the end of the run resolved **58 incidents**
raised by this run's own rule. The dwell rule had been firing correctly all night. The harness simply
could not see it after minute 17, and **reported "cannot see" as "zero"**.

⚠️ **This is a direct violation of ADR-0039 in my own instrument** — _absent is reported as
unavailable, never as zero_ — and it is the exact class the platform has a standing architectural
decision about. A 401 became a `0`, a `0` became a plausible reading, and a plausible reading would
have gone into a report.

⚠️ **And the assertions would have made it worse, not better.** With `streamsTotal: 0`, the check
"no stream of this run's own cameras was ever reported down" passes **vacuously** — zero of zero
streams were down. That is the `[].every()` trap of rule 4, reached by a different road.

**Consequence for this run:** the Prometheus half (§2) is sound and stands — it is scraped over
`docker exec` and never touched the API. The API half is **void from sample 3**. Roughly a third of
the signals this soak exists to collect were not collected.

---

## 4 · Fixes applied during the soak

None to the platform — it produced no defect. All five fixes were to the instrument, during the
smoke-test phase before the run:

| #   | Defect                                                                                                                        | Fix                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Fixture paths cycled, so camera 3 duplicated camera 1's stream URL (409) — while the comment above claimed they were distinct | Distinct path per camera; also gives each its own encoder       |
| 2   | Two measurements counted a **page cap** and called it a total (incidents, recordings)                                         | Shared `collectSince()` walking keyset pages by timestamp       |
| 3   | Stream health asserted across streams the run does not own                                                                    | Scoped to this run's cameras; tenant-wide recorded as a finding |
| 4   | Global rule counters attributed a **seeded** rule's work to this run                                                          | Per-rule attribution via `/rules/rules/live`                    |
| 5   | `WHOLE_FRAME` inset to 0.02–0.98 put the subject's **feet** outside the zone — dwell never evaluated                          | Full unit square                                                |

---

## 5 · Remaining known limitations

Unchanged by this run: **L-1** (no physical camera) · **L-57** (~10 s dedup floor) · **L-58** (zone
geometry never met a lens) · **L-59** (dwell state in memory) · **KI-01** dashboard · **KI-02**
vacuous tracking mutation · **KI-03** broker-resilience · **KI-04** unidentified deleter.

New, from this run:

- ⛔ **SOAK-1 · The harness does not refresh its token.** §3. Fixed before tonight's rerun.
- ⚠️ **SOAK-2 · The harness reports API unavailability as zero.** The deeper form of SOAK-1, and the
  one that would recur in a different guise. ADR-0039 applies to instruments too.
- ⚠️ **SOAK-3 · A suspended sample is treated as a normal sample.** Sample 66 divides real counter
  deltas by 4458 s of wall clock and reports 0.26 fps. Excluded by hand here; the harness should
  detect and mark it.
- ⚠️ **SOAK-4 · Publisher out-of-order at 13.4 % is uncharacterised.** Recorded, not explained.
- ⚠️ **SOAK-5 · `caffeinate -i` does not prevent low-battery sleep**, and the run had no power
  precondition. Tonight's run needs AC and `caffeinate -is`.

---

## 6 · Go / No-Go

# ⚠️ NO-GO for certifying stability on this run — and the platform is not the reason.

**What can be claimed from this run, and defended:**

✅ Over **5.51 hours** at supported sizing the platform showed **no memory growth** (runtime RSS
+0.0 %, every heap within ±1.2 %), **no file-descriptor growth on any service**, **stable FPS**
(CV 0.5 %), **exact frame accounting**, **no queue build-up**, **no latency drift in any of four
measures**, **no container restart**, **no broker disconnection**, **no dead-lettered event**, and
**no loss of detection consistency** (1.99–2.00 per frame throughout). It also **survived a
74-minute forced suspend and resumed correctly**, which was not a planned test.

⛔ **What cannot be claimed:** anything that depends on the API half — camera health, recording
continuity, dwell liveness, incident throughput and incident latency were **not measured** after
minute 17. A soak that collected two thirds of its signals is not a certification, and the honest
word for the other third is _unknown_, not _zero_.

**Recommendation: RESTART, not resume.** Resuming would append 11 samples to a run whose API half has
been void since sample 3. The Prometheus evidence above is preserved and stands on its own as a
strong five-hour result; tonight's run should be a clean 6.5 hours with the token defect fixed, on AC
power.

⚠️ **The freeze at `647a96e` is unaffected.** This soak was never a freeze gate — it is new
verification capability being established. Nothing it found changes P-8 Phase 7's status.
