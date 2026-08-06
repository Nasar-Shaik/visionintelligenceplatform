# KNOWN ISSUES

> Active problems, bugs, and gotchas discovered during implementation. Append as found; move to a "Resolved" row when fixed (with the commit/PR). Sign entries `[name · date]`. For deliberate shortcuts use [TECH_DEBT.md](TECH_DEBT.md) instead.

## Open

| ID        | Area               | Issue                                                                                                                                                                                                                                                                                                                                                   | Impact                                                                                                                                                                             | Workaround                                                                  | Sev  |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| **KI-01** | Runtime dashboard  | `runtime/dashboard.sh` fails on `Uptime="1h 31m"` — the check traces every number on the AI Runtime page to a value the deployment reported, and this one is **derived** (a duration rendered from a start time), so it matches nothing in the payload                                                                                                  | The stage is RED on a page that is telling the truth. ⚠️ Its real cost is that a **genuine** untraceable number would now be lost in a failure everyone expects                    | none — read the log, the other checks in the stage are meaningful           | med  |
| **KI-02** | Tracking           | `tracking-mutations.sh` — one of six mutations does not turn the verification red. The break is applied and `tracking.mjs` **stays green**, so that mutation currently proves nothing about the check it is aimed at                                                                                                                                    | ⚠️ **A vacuous mutation is worse than a missing one**: it reports 6/6 coverage while one check has never been shown to be able to fail. Same class as the two found in P-8 Phase 7 | 5/6 are sound; treat the walk check as unverified until this is retargeted  | high |
| **KI-03** | Publisher / bridge | `broker-resilience.sh` §4 — "no events published while the camera offered no frames" saw **163 → 165** during the idle phase. ⚠️ **Probably a settling-time defect in the CHECK, not a gate leak** — see the evidence below — but that is an inference from counters, not a measurement, and it is not being claimed as resolved                        | If the check: a false red on a platform behaving correctly. If a leak: an unassigned camera still produces events, which is the one thing P-8 Phase 6 must prevent                 | none — the other three sections of the stage pass                           | high |
| **KI-04** | Nightly framework  | A tracked file, `scripts.zip`, was **deleted during an unattended nightly run** and no stage in the run path references it. ⚠️ **The deleter was not identified.** The file itself was build detritus — a 432 KB zip of `scripts/` committed by accident in `f9a004b` — and has now been removed deliberately, so the symptom cannot recur on that file | ⚠️ Unknown. A run that can delete a tracked file without any stage naming it could delete a different one. The tree-drift check is what caught it and is the only guard            | `REQUIRE_CLEAN_TREE=true` plus the tree-drift report; read it every morning | med  |

### KI-03 — the evidence, and why it is not being called resolved

The publisher's own counters across the run's five phases (`metrics/broker-resilience.json`,
2026-08-06-2144):

| phase       | published | offered | activeCameras | inflight | queueDepth |
| ----------- | --------: | ------: | ------------: | -------: | ---------: |
| `recovered` |       148 |     204 |             0 |        0 |          0 |
| `idle`      |       164 |     223 |             0 |        0 |          0 |

Across the 20-second idle phase — after `POST /media/streams/:id/stop` — **19 results were offered to
the publisher and 16 were published**, and by the end of it `activeCameras`, `inflight` and
`queueDepth` had all settled to **0**.

⚠️ **That shape is consistent with teardown lag and inconsistent with a leaking gate.** A camera still
being analysed would hold `activeCameras` at 1 and keep offering at the full frame rate for the whole
window; instead everything quiesces. At 2 fps a 20-second window is ~40 frames and 19 were offered,
which is about half the window — a stream taking a few seconds to stop.

⚠️ **It is still not resolved, and the reason is the check's shape.** `beforeIdle` is sampled
_immediately before_ the stop request, so the assertion allows **zero** settling time. The honest
repair is to sample after the pipeline quiesces — but that is a P-8 Phase 5 verification change, and
it was not made during the P-8 Phase 7 freeze. **Confirming it needs a run with the offered count
sampled per second through the idle window**, which would distinguish "tailed off" from "continued".
Until that run exists this stays open, because an inference from five counters is not a measurement.

## Resolved

| ID           | Area | Issue | Fix | Date |
| ------------ | ---- | ----- | --- | ---- |
| _(none yet)_ |      |       |     |      |

---

## ⚠️ The first full nightly since the assignment gate shipped found four verifications measuring the gate

Recorded here rather than as four rows because it is **one cause**, found on 2026-08-06, and the
pattern is the thing to remember. P-8 Phase 6 made a camera with no assignment never analysed. Every
verification written before it had to say so — `_assign.mjs` exists for exactly that — and four
places had not been updated, because nothing had run them together since:

| What                                                                    | Symptom                                                                              | Fixed |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- |
| `inference.mjs` §7 ladder never assigned its cameras                    | ⛔ printed `16 cameras · 44 analysed` — **one** camera's throughput labelled sixteen | ✅    |
| `hardening.mjs`, `tracking-benchmark.mjs`, `event-bridge-benchmark.mjs` | 409 at the 8-camera rung — the declared capacity is 4                                | ✅    |

⛔ **The first one is the one worth remembering.** The ladder's numbers were not obviously wrong —
`16 cameras · 44 analysed · 65.2ms inference` reads perfectly plausibly. What caught it was §8's
**frame accounting invariant** (`offered == delivered + dropped + failed`), which stopped balancing
because `offered` scaled with the cameras and `delivered` did not. A check written to catch silent
frame loss caught a ladder measuring one stream, because it was written against an **invariant**
rather than against an expected value. Assertions about what must always be true survive changes that
assertions about expected numbers do not.

⚠️ **And the class was visible a day earlier and was not generalised.** The P-8 Phase 7 loitering
ladder hit the same 409 and the repair was made inside that one script. `raiseRuntimeCapacity` now
lives in `_assign.mjs` beside `assignCameras`, so the next ladder inherits it.
