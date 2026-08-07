# Implementation Order — what to build next, and why in that order

**2026-08-07.** The sequencing decision across
[PRODUCT_READINESS](PRODUCT_READINESS.md) · [OFFLINE_VIDEO_PLAN](OFFLINE_VIDEO_PLAN.md) ·
[DEMO_MODE_PLAN](DEMO_MODE_PLAN.md) · [RETAIL_CAPABILITY_PACK](RETAIL_CAPABILITY_PACK.md), against the
existing [PRODUCT_ROADMAP](PRODUCT_ROADMAP.md) and [PHASE_8_PLAN](PHASE_8_PLAN.md).

**Optimised for, in this order:** maximum customer value · maximum reuse · minimum engineering effort ·
minimum technical debt. ⚠️ **Where those four disagree, customer value wins and the disagreement is
named.**

---

## 1 · ⭐ The recommendation

> ### Begin **P-8 Phase 8 · Offline Video Investigation** immediately.
>
> **Two weeks. Zero new services. Zero new inference. It closes C-21 and TD-9 G-2, pulls C-46 forward
> with a real consumer, and it is the only work on the board that makes every other capability
> verifiable.**

**Three reasons, in descending order of strength:**

1. ⭐ **It is the only way to validate anything before hardware arrives.** Every perception capability
   carries `⬜ unvalidated`, always for the same reason: no real footage has ever passed through the
   chain. An uploaded MP4 is real footage. This is the milestone that can start today and still be
   working when the purchase order is signed.
2. ⭐ **It is the instrument for everything after it.** The capability pack's own risk — _"a capability
   that is configurable and unverified"_ — is closed by running each template against footage a human
   labelled first. That is P-8's unmet exit criterion, and there is no other way to meet it.
3. **It is the customer's first-day workflow and it needs nothing installed.** _"Here is yesterday's
   footage — tell me what happened."_

⚠️ **And one reason to start it rather than something smaller:** it forces the platform to run its rule
engine on **non-wall-clock time** for the first time. That is where an unnoticed `Date.now()` lives, and
this platform's record on running existing code under a new condition is eleven defects in P-9 and nine
in P-5.8. **Finding those now is worth more than any feature in the pack.**

---

## 2 · Dependency graph

```
                          ┌──────────────────────────────────────────────┐
  ⚠️ TD-63 · cpu limit    │  ⛔ PROCUREMENT — not engineering, not ours  │
     0.5 d · independent  │      └─▶ P-9 Track B · 2 wk                  │
                          └──────────────────────────────────────────────┘
                                            (parallel, unblockable by us)

   ┌── @vip/JOBS ─────┐          ← Track A, justified by its first consumer
   │      2 d         │
   └────────┬─────────┘
            │
   ┌────────▼──────────────────┐
   │ ⭐ OFFLINE VIDEO   8 d    │────────────────┬──────────────────┬────────────────┐
   │    C-21 · TD-9 G-2        │                │                  │                │
   └────────┬──────────────────┘                │                  │                │
            │                                   │                  │                │
   ┌────────▼──────────┐            ┌───────────▼────────┐   ┌─────▼──────────┐    │
   │ REPORTS  C-47 8 d │            │ DEMO MODE    5.5 d │   │ ⭐ REAL-FOOTAGE│    │
   └────────┬──────────┘            │ (MP4 source free)  │   │  VERIFICATION  │    │
            │                       └────────────────────┘   │  for every row │    │
   ┌────────▼──────────┐                                     └─────┬──────────┘    │
   │ EXPORT   C-48 5 d │                                           │               │
   └───────────────────┘                                           │               │
                                                                    │               │
   ── RULES / CONTRACTS LANE ────────────────────────────────────────┼───────────────┘
                                                                    │
   ┌──────────────────┐   ┌──────────┐   ┌────────────┐   ┌─────────▼──┐   ┌──────────┐
   │ RCP-1 templates  │──▶│  COUNT   │──▶│  SCHEDULE  │──▶│    LINE    │──▶│ ABSENCE  │
   │      4 d         │   │  5–6 d   │   │   4–5 d    │   │   8–10 d   │   │   10 d   │
   │ +2 capabilities  │   │ +3 caps  │   │ +2 caps    │   │  +2 caps   │   │  +1 cap  │
   └──────────────────┘   └──────────┘   └────────────┘   └─────┬──────┘   └──────────┘
                                                                 │
                                                    ┌────────────▼──────────┐
                                                    │ people-count read     │
                                                    │ model  5 d  ⚠️ ← C-51 │
                                                    └───────────────────────┘

   ── NOTIFY LANE (fully independent) ──────────────────────────────────────────────
   ┌──────────────────────────────────────────────┐
   │ P-7 · ALERTING  10 d   C-43 · C-44 · TD-53   │   ⛔ blocker for a PAID deployment
   └──────────────────────────────────────────────┘

   ── OPTIONAL, HIGH DEMO VALUE ────────────────────────────────────────────────────
   ┌──────────────────────────────┐
   │ TD-15 · evidence snapshot 3 d│   ⭐ unblocked since P-8 Phase 2; nobody noticed
   └──────────────────────────────┘
```

**Reading it:** four lanes touch four different services and share nothing. `@vip/jobs` is the only
node with more than one dependent, which is why it is 2 days and first.

---

## 3 · Critical path

**To a demonstrable, self-validating product:**

```
JOBS (2 d) ──▶ OFFLINE VIDEO (8 d) ──▶ RCP-1 templates (4 d)          = 14 days ≈ 3 weeks
                                        ▲
                     first real-footage verification in the project's life
```

**To a deployment a customer can pay for** — the five blockers in
[PRODUCT_READINESS](PRODUCT_READINESS.md) §8.3:

```
JOBS ─▶ OFFLINE VIDEO ─▶ REPORTS (C-47) ─▶ EXPORT (C-48)              = 23 days ≈ 4.5 weeks
                    ║
        P-7 ALERTING (10 d, parallel lane) ═══════════════════════════╣
                    ║
        TD-39 rate limiting (2 d, P-14, must precede internet exposure)╣
                    ║
        ⛔ P-9 TRACK B (2 wk) ── gated on a purchase order ═══════════╝
```

⭐ **The software critical path is 4.5 weeks. The real critical path is procurement**, and it is the
one item on this page that no engineering decision can shorten. **Order the hardware today**
([P9_TRACK_A_CLOSEOUT](P9_TRACK_A_CLOSEOUT.md) §7); the day it arrives, Track B pre-empts everything
else on this page, because it is the only work that cannot be done later.

---

## 4 · Parallel work

### 4.1 With four engineers

| Lane  | Owner service      | Work                                                  | Weeks |
| ----- | ------------------ | ----------------------------------------------------- | ----- |
| **1** | media, `@vip/jobs` | JOBS → Offline Video → Reports → Export               | 4.5   |
| **2** | rules, contracts   | RCP-1 → COUNT → SCHEDULE → LINE                       | 5     |
| **3** | notify             | P-7 alerting: transports, policies, escalation, retry | 2     |
| **4** | console            | Demo Mode (after lane 1 week 2), TD-15 snapshot       | 2     |

⚠️ **Lanes 1 and 2 converge in week 3** and must: every capability lane 2 produces is verified with
lane 1's offline analysis. Scheduling them independently to the end wastes the whole point.

### 4.2 ⚠️ With one engineer — the realistic case

Sequenced by value per day, with the interrupt rule stated:

| #   | Work                                    | Days | Cumulative | Why here                                                                                                          |
| --- | --------------------------------------- | ---- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 0   | ⚠️ **TD-63 — `cpus:` on inference**     | 0.5  | 0.5        | **high** severity, half a day. Inference measured at 797 % CPU; nothing stops it taking the cores recording needs |
| 1   | ⭐ **JOBS + Offline Video**             | 10   | 10.5       | §1                                                                                                                |
| 2   | **RCP-1 — Restricted Area, Queue Wait** | 4    | 14.5       | 1 → 3 capabilities, and the first ones ever verified on real footage                                              |
| 3   | **P-7 — Alerting**                      | 10   | 24.5       | ⛔ The largest single blocker to a paid deployment                                                                |
| 4   | ⭐ **COUNT**                            | 6    | 30.5       | +3 retail, +5 other verticals. Highest leverage primitive                                                         |
| 5   | **Demo Mode**                           | 5.5  | 36         | Worth far more now — the demo is "upload your own footage"                                                        |
| 6   | **SCHEDULE**                            | 5    | 41         | Corrects a false ✅ and unlocks the timed variants                                                                |
| 7   | **Reports + Export**                    | 13   | 54         | Blocker #3. Cheap now — the job runner is 5 weeks old and proven                                                  |
| 8   | **LINE + DIRECTION**                    | 10   | 64         | Expensive; tests the "flip one flag" design claim                                                                 |
| 9   | **ABSENCE**                             | 10   | 74         | ⛔ Architectural, needs an ADR, lowest confidence. Last, or on demand                                             |

⛔ **The interrupt rule: the day the hardware arrives, stop and run P-9 Track B.** Everything above
survives a two-week pause. A camera sitting in a box does not become easier to validate later, and
every `⬜ unvalidated` cell on the matrix is waiting on it.

---

## 5 · Expected milestone durations

| Milestone                          | Days   | Confidence | ⚠️ Where it slips                                                      |
| ---------------------------------- | ------ | ---------- | ---------------------------------------------------------------------- |
| TD-63 cpu limit                    | 0.5    | high       | —                                                                      |
| `@vip/jobs` + worker               | 2      | high       | The restart-safety test is the slice; the loop is an evening           |
| ⭐ **Offline Video Investigation** | **8**  | ⚠️ medium  | Frame-rate drift on a VFR source; the 1×-vs-8× parity run              |
| RCP-1 (2 templates)                | 4      | high       | —                                                                      |
| P-7 Alerting                       | 10     | ⚠️ medium  | Escalation timers and the retry/idempotency interaction (TD-53)        |
| COUNT                              | 5–6    | high       | The dedup-collapse trap is already named, which is why it is high      |
| Demo Mode                          | 5.5    | high       | 8 if TD-15 is included                                                 |
| SCHEDULE                           | 4–5    | ⚠️ medium  | ⭐ The **timezone** — nothing in the platform carries one — and DST    |
| Reports + Export                   | 13     | ⚠️ medium  | The custody-boundary ADR is a real decision, not a formality           |
| LINE + DIRECTION                   | 8–10   | ⚠️ low     | Hysteresis on a subject standing on the line; editor work              |
| People-count read model            | 5      | ⚠️ low     | Needs the C-51 dashboard contract, which is **not frozen**             |
| ABSENCE                            | 10     | ⛔ lowest  | Architectural; couples rules to camera health; an ADR first            |
| ⛔ **P-9 Track B**                 | **10** | ⚠️ medium  | ⛔ **Gated on procurement**, and every estimate assumes devices behave |

⚠️ **Every estimate includes its eight verification deliverables and assumes the work finds something.**
An estimate for switching something on that assumes nothing breaks is not an estimate — it is a hope
with a number attached.

---

## 6 · What was reordered, and why

| Change                                                                                            | Reason                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⭐ **Offline Video before the capability pack** (swaps [PHASE_8_PLAN](PHASE_8_PLAN.md) §4.1/§4.2) | §4.1 warns that packaging risks _"a capability that is configurable and unverified"_. Offline Video is the thing that verifies them. Packaging first ships five of exactly the problem §4.1 names  |
| ⭐ **C-46 background jobs moves from P-11 to now**                                                | P-11 would build it speculatively. Here it has a demanded consumer on day one, which is the Track-A admission test in [PHASE_8_PLAN](PHASE_8_PLAN.md) §2. **P-11 gets shorter, not longer**        |
| **Demo Mode after Offline Video, not before**                                                     | Its two headline features — recorded MP4 and export — come free or become honest only afterwards. Built first, it is a second implementation of the product                                        |
| **P-7 Alerting stays where the roadmap put it**                                                   | ⭐ **Not reordered, and it was checked.** It is the largest blocker to a _paid_ deployment, but it competes for nothing and blocks nothing. Run it in parallel; sequence it third for one engineer |
| **TD-63 promoted to first**                                                                       | Half a day, **high** severity, and it protects the contractual obligation (recording) from the optional one (perception). It should not have waited this long                                      |
| **ABSENCE demoted to last**                                                                       | It looked like the cheapest row in the retail pack and is the only one that touches the engine's architecture — [RETAIL_CAPABILITY_PACK](RETAIL_CAPABILITY_PACK.md) §3.6                           |
| **Nothing else moved**                                                                            | P-10 pilot, P-11 reporting, P-12 search, P-13 dashboards, P-14 GA keep their order and their reasons                                                                                               |

---

## 7 · Debt this sequence pays, and the debt it takes on

**Paid:**

| Item                | How                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| **TD-9 G-2**        | Offline video upload → analyse, the last open item of the P2-1 set                                        |
| **C-21**            | ⛔ → ✅                                                                                                   |
| **C-46**            | Built with a consumer instead of speculatively                                                            |
| **TD-63** (high)    | The cpu limit, half a day                                                                                 |
| **TD-53** (high)    | Delivery retry, inside P-7                                                                                |
| **TD-64 / TD-68**   | ⭐ Not closed — **unblocked.** Analysed footage with a human's labels is the corpus both were waiting for |
| **VERTICALS ✅ ×5** | The schedule claim, corrected in this commit                                                              |

**Taken on, deliberately and recorded:**

| New debt                                          | Why it is acceptable                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The job runner is **in-process per service**      | P-11 prescribes exactly this; a central job service would violate [CONSTRAINTS §5](CONSTRAINTS.md)      |
| `analysisId` is a **second provenance dimension** | ADR-0047. The alternative — offline incidents indistinguishable from live — is not a trade-off          |
| ⚠️ Analysis and live share the **dwell LRU**      | Namespaced and budgeted, not separated. A true separation needs a `DwellStateStore` change (L-59's fix) |
| **No re-analysis** with a changed rule            | `analysis.offline` is reserved and stays reserved. The most-requested follow-on, deliberately deferred  |

---

## 8 · The decision, in one table

| Question                                  | Answer                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **What to start now**                     | ⭐ **P-8 Phase 8 · Offline Video Investigation** — preceded by half a day on TD-63                                                                                                                           |
| **How long**                              | 2 weeks: 2 days `@vip/jobs`, 8 days the milestone                                                                                                                                                            |
| **What it needs from you**                | Nothing. No hardware, no decision, no purchase                                                                                                                                                               |
| **What it unblocks**                      | Real-footage verification for **every** capability; the demo's best feature; the corpus for TD-64/TD-68; P-11                                                                                                |
| **What runs beside it**                   | P-7 alerting (notify), TD-15 snapshot (evidence), and ⛔ **procurement**                                                                                                                                     |
| **What decision is genuinely yours**      | ⛔ **The hardware order**, and whether TD-15's evidence snapshot is pulled forward for the demo                                                                                                              |
| **What would change this recommendation** | A signed customer with a date. Then P-7 and P-9 Track B move ahead of it, because a customer who cannot be alerted and whose cameras are uncertified is a pilot that fails for reasons perception cannot fix |
