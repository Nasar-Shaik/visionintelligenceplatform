# AI-5d — Health Monitoring, Auto-Recovery & Model Lifecycle

> **Milestone:** Production Readiness **AI-5d** (fourth slice of AI-5) · **Status:** ✅ code + tests complete, ⏳ awaiting Architect review
> **Scope:** health as a **decomposed score and a trend**, failure as something the runtime **recovers
> from within a budget**, and model change as a **staged, zero-downtime transition**.
> **In `ai/inference`, no new service; the five frozen v1.0 contracts untouched.**
> **North star (Architect):** _Baseline → Optimization → Benchmark → Regression comparison → Accept or reject._
> Reference: [ED-0043](../project/ENGINEERING_DECISION_LOG.md) · [PRODUCTION_COMPATIBILITY](../architecture/future/PRODUCTION_COMPATIBILITY.md). **Author:** Claude · _2026-08-01_

---

## 1. The gap AI-5d closes

AI-5b made a session survive its **camera**. AI-5c made a session survive its **neighbours**. Neither
makes a session survive **itself over time**.

| Before AI-5d                                              | After AI-5d                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `healthy` while the heartbeat is fresh                    | **0–100 score across five subsystems**, with a trend and a projection |
| A failed session stays failed until an operator notices   | **Auto-recovery within a configured budget**, every attempt recorded  |
| Recovery restores _rungs_                                 | **Restoration stack** — exactly what was taken, given back in reverse |
| `activate()` flips the model under eight running sessions | **warm → validate → switch → drain → complete**, rollback on failure  |
| Four separate operational stores to correlate by hand     | **One journal + an ordered timeline** per session                     |
| Steady-load simulation only                               | **Ten production-condition scenarios** with asserted invariants       |

## 2. Ownership — supervision of existing stages, not a new layer

```
HealthMonitor        produces EVIDENCE          (scores; decides nothing)
ResourceGovernor     makes DEGRADATION decisions (unchanged owner, AI-5c)
AutoRecovery         executes RECOVERY policy    (decides; does not act)
ModelLifecycleMgr    manages MODEL transitions   (behind the ModelAdapter seam)
SessionRunner        ORCHESTRATES                (reports up, applies down — never owns policy)
```

**The narrowest seam in AI-5d is the health one.** Health never degrades anything. It produces a
`predicted_decline` flag that becomes one more pressure reason on the governor's existing path. Two
components able to degrade a session independently is how you get an oscillation nobody can debug.

Symmetrically, `AutoRecovery` **decides** and the runner **supplies the executor** — the same
"report up, apply down" split AI-5c established, which is what lets a hospital and a retail store run
identical code.

## 3. Health scoring (recs 1 + 2)

Five components, each the weighted mean of indicators derived from measurements the runtime
**already produces**. AI-5d adds no new instrumentation; it interprets what is there.

| Component      | Indicators                                                     |
| -------------- | -------------------------------------------------------------- |
| **connection** | stream availability · reconnect frequency                      |
| **inference**  | inference latency · event latency                              |
| **scheduler**  | queue growth · frame loss · SLA attainment · degradation level |
| **resources**  | CPU utilization · memory utilization                           |
| **recovery**   | recovery attempts · restart frequency                          |

Three rules the tests enforce:

- **Every component is required in the output.** A health report that silently omits a subsystem is
  exactly the report that sends someone looking in the wrong place.
- **An absent reading is not a bad one.** A box with no GPU probe scores `resources: 100`, not `0`.
- **`frame-loss` is `framesDropped` only.** Counting sampled-away frames would report a correctly
  tuned 0.5-fps camera as sick, and operators would raise the FPS to make the number look good.

**Projection** (rec 1): each indicator carries a `Trend`, so the monitor reports where health is
_heading_. `predictedDecline` fires only when the **projection** crosses a threshold the **current
score has not** — otherwise the governor would be told about something already visible to it.

**State always wins.** A stopped session is `down` at any score. The score explains _why_ a session
is unwell; it never claims a stopped session is healthy.

## 4. Auto-recovery (recs 1, 4, 6)

Recovery **executes the frozen AI-5b taxonomy** rather than adding judgement:

| Category        | Action                | Retried?                     |
| --------------- | --------------------- | ---------------------------- |
| `connection`    | restart session       | yes, bounded                 |
| `model`         | rebind model          | yes, bounded                 |
| `inference`     | skip frame            | yes, in-band (no budget)     |
| `pipeline`      | skip frame            | yes, in-band (no budget)     |
| `configuration` | operator intervention | **never** — enforced in code |

The `configuration` rule is a **code-level invariant, not a default**: `RecoveryPolicy` _rejects_ a
profile that lists it. A wrong RTSP URL does not become right on the four-thousandth attempt, and
retrying it buries the one log line that would have told someone what to fix.

**Budgets are external configuration** (rec 4) — the Architect's four archetypes, all expressible
without a code change, and all shipped:

| Archetype  | Profiles               | Policy                                             |
| ---------- | ---------------------- | -------------------------------------------------- |
| Retail     | `retail`, `office`     | 3 restarts / hour                                  |
| Factory    | `factory`, `warehouse` | 10 restarts / hour                                 |
| Bank       | `school`               | unlimited restarts, 30 s → 15 min cooldown         |
| Healthcare | `hospital`             | **never auto-restart**; operator approval required |

**`RecoveryReason`** (rec 1) records trigger · subsystem · severity · retry count · correlation id ·
failure category · failure code. **Every refusal is recorded too** — a recovery that did _not_ happen
is exactly as interesting to an operator as one that did.

### Anti-oscillation (rec 6)

Two guards, at two levels:

- **`AutoRecovery`** defers a restart inside `stabilizationSeconds` of the last successful one.
- **`ResourceGovernor`** requires `stabilization_samples` observations before a **direction reversal**.

The second is deliberately direction-aware. The oscillation to prevent is
`recover → immediately degrade → recover`; **two escalations in a row are not oscillation**, they are
the ladder doing its job under sustained pressure, and delaying them would leave a drowning session at
a rung that cannot save it. Suppression is **edge-triggered** — announced once, then counted — because
a decision per observation would flood the log the guard exists to protect.

## 5. Progressive restoration (rec 4)

A rung says **where** a session is; it does not say **what was taken from it**. `reduced-behaviors`
disabled _specific_ analyzers, and re-enabling a different set is the same rung count and the wrong
outcome. So each degradation **pushes a `RestoreStep`** recording exactly what it removed, and each
recovery **pops it**:

```
degrade:  none → reduced-fps → reduced-resolution → reduced-behaviors[crowd]
stack:    [fps 5→2.5]  [scale 0.5]  [disabled: crowd]
recover:                                    ← pop [crowd]  ← pop [scale]  ← pop [fps]
```

Exact-reverse restoration becomes **structural rather than intended**, and the test asserts the
restoration _sequence_ is the literal reverse of the degradation sequence — not merely the same depth.

## 6. Model lifecycle (rec 3)

```
active(vN) → warming → validating → switching → draining → active(vN+1)
                            └── validation failed ──→ rolled-back(vN)
```

Zero downtime rests on one indirection: the analyzer holds a **`ModelSlot`** and reads
`slot.adapter` **per frame**. Promotion is an attribute assignment — no session stops, no queue
drains, no frame is lost. `draining` keeps the outgoing model warm so a frame that entered under vN
finishes under vN; swapping under an in-flight frame produces a result belonging to neither version,
which looks like data rather than a bug.

**Operational validation, explicitly not accuracy validation.** Without labelled footage a runtime
cannot certify recall, and a `validated` flag implying otherwise is worse than no flag because someone
will trust it. The five checks — `artifact-loads`, `inference-runs`, `output-structure`,
`latency-budget`, `detection-comparability` — catch a corrupt artifact, a wrong input shape, a 10×
latency regression, and a model that silently detects nothing. Accuracy belongs to **AI-5e**.

One correction the tests forced: the latency-regression bound is **not applied when both models
measure under 1 ms/frame**. Gating a deployment on a 25% difference between two sub-microsecond
readings is gating on timer noise — the opposite of what an evidence gate is for.

**History is append-only** (rec 3). `versionPath: ['v1','v2','v1','v3','v4']` reads as "v2 was tried
and rolled back" at a glance. Returning to a previous version after a completed rollout is a **new**
transition, never a mutation of the old record.

## 7. Journal + timeline (rec 5)

One bounded, tenant-scoped stream per session, merging admission · scheduling · degradation ·
recovery · restart · model transitions · failures. It is a **sink on the `OperationalLog` the session
already writes to** — adding a second emitter would recreate the problem it solves.

```
10:02:14  Connected
10:11:02  Governor degraded the session (reason queue-pressure)
10:13:44  Health stabilized (score 86)
10:22:07  Model upgrade started (toVersion 1.3.0)
10:23:11  Validation passed
10:24:00  Switch complete (sessionsAffected 4)
```

The journal is newest-first and machine-queryable; the timeline is **oldest-first** and read by eye,
carrying at most one number per line. Both are released on teardown — history that no one can reach is
a leak, not a diagnostic.

## 8. Production simulations (rec 7)

Ten scenarios, each with **asserted invariants** rather than "it did not crash". The load is
synthetic; every decision is production code.

| Scenario                   | Invariant                                                        |
| -------------------------- | ---------------------------------------------------------------- |
| `prolonged-operation`      | every per-session store stays bounded over 3000 ticks            |
| `intermittent-disconnects` | disconnects are recovered within budget; the fleet keeps serving |
| `burst-reconnects`         | a critical camera still gets in after the herd (reserve holds)   |
| `varying-frame-rates`      | an 8× demand spread starves nobody                               |
| `heterogeneous-hardware`   | work spreads across CPU + CUDA + NPU with no vendor branch       |
| `mixed-priorities`         | priority shapes the share; nothing starves                       |
| `degraded-hardware`        | losing an accelerator degrades, never collapses                  |
| `repeated-model-failures`  | 20 consecutive failures produce exactly 3 restarts, then stop    |
| `simultaneous-recoveries`  | 16 simultaneous failures each spend their **own** budget         |
| `recovery-storm`           | a flapping camera is bounded by the stabilization window         |

Both of the load-bearing invariants were **negative-controlled**: with the stabilization window
removed the storm scenario restarts on all 30 flaps, and with the reserve removed the burst scenario
refuses the critical camera. They fail when the mechanism is absent, which is the only thing that
makes a passing invariant meaningful.

## 8b. Follow-up refinements (accepted AI-5d review)

Eight further recommendations, folded in without new layers:

| #   | Refinement            | Where it landed                                                                 |
| --- | --------------------- | ------------------------------------------------------------------------------- |
| 1   | **Recovery history**  | `RecoveryHistory` — permanent, tenant-scoped, **survives session teardown**     |
| 2   | **Health trends**     | `componentTrends` + `sparkline()` / `render_components()` on `HealthScore`      |
| 3   | **Model history**     | `export_history()` / `import_history()` — durable JSON, no database, no service |
| 4   | **Recovery profiles** | `profiles/recovery/*.json` — a customer adds a **file**, not code               |
| 5   | **Failure analytics** | `RecoveryHistory.analytics()` — reporting only, read by no runtime path         |
| 6   | **Oscillation**       | direction-aware guard documented in §4 and in the governor's own docstring      |
| 7   | **More simulations**  | seven new scenarios → **17 total**                                              |
| 8   | **Freeze**            | +2 schemas (`RecoveryRecord`, `FailureAnalytics`) + 1 additive field            |

Two distinctions worth naming, because both are easy to get wrong:

- **`RecoveryLedger` vs `RecoveryHistory`.** The ledger is _budget accounting_ and is cleared on
  teardown; the history is the _operational record_ and is not. Forgetting the history when a session
  stops would erase the pattern exactly when it becomes interesting.
- **Analytics never feed the runtime.** Nothing in the scheduler, governor or recovery path reads
  them. Feeding last week's averages into a live control loop is how a system starts reacting to
  history instead of to conditions.

**The seven new scenarios** (rec 7): `partial-gpu-failure` (a GPU that gets _slow_, not absent — capacity
must shrink beneath live allocations without stranding them), `mixed-hardware-cluster` (five resources
across three nodes; the scheduler already cannot tell it is not distributed), `network-partition` (the
whole fleet fails and recovers together), `rtsp-credential-failure` (**0 restarts, 0 budget spent, every
attempt escalated** — the most important negative scenario in the suite), `gradual-resource-exhaustion`
(degrades on the trend, before saturation), `overnight-continuous` (10,000 ticks with **no drift** in
throughput or fairness), and `rolling-model-deployment` (a failed rollout **never leaves a split fleet**).

Two findings from writing them: the partition scenario initially asserted against _requested_ rather
than _admitted_ cameras (it was testing the reserve, not the partition), and `versionPath` silently
dropped a rollback when the incumbent version was unknown — which made the path read as though nothing
had been attempted. The path now always records a return.

## 9. Benchmark governance (rec 6)

The existing `--baseline` gate is unchanged: **Baseline → Optimize → Benchmark → Compare →
Accept/Reject**, exiting non-zero on regression.

AI-5d adds `--scenarios`, folding the ten production conditions into the **same** gate. A change can
hold every performance KPI and still break the runtime under conditions a benchmark never creates.
Benchmarks measure speed; the scenario suite measures whether the operational logic still holds, and
**both must pass**.

Deliberately _not_ added: "recovery time" and "health stability" KPIs. The harness runs offline and
live workloads, not fault injection, so those numbers would be invented rather than measured.

## 10. Guardrails held

| Guardrail             | How                                                           |
| --------------------- | ------------------------------------------------------------- |
| No new service        | Everything in `ai/inference`                                  |
| Five frozen contracts | Untouched — every addition is operational                     |
| Additive only         | +14 schemas → **102**; absent config = exactly AI-5c behavior |
| Deterministic CI      | Injected clocks, simulated sources, no network/threads/sleeps |
| Benchmark-driven      | `--baseline` regression gate + `--scenarios` operational gate |
| Events-only boundary  | No new emission path; the journal is a sink                   |
| DVR/NVR compatibility | No transport change; declared-type dispatch untouched         |
| Architecture frozen   | Supervision of existing stages; no new stage, no new layer    |

## 11. Verification

| Gate                     | Result                                  |
| ------------------------ | --------------------------------------- |
| Contracts                | **208 passed** (was 181)                |
| Generated schemas        | **102** (was 88)                        |
| Python (`ai/inference`)  | **506 passed** (was 355, +151)          |
| Production scenarios     | **10 / 10 pass**                        |
| Typecheck · lint · build | 28 · 20 · 19 — all pass                 |
| Import graph             | 19 packages, 0 violations               |
| AI-5a baseline suite     | **PASS, 0.00% dropped** — no regression |

## 12. Deliberate limits (for review)

1. **Per-session CPU/memory/GPU remain attributed estimates**, unchanged from AI-5c — one process has
   no per-session kernel accounting. Health consumes them as estimates and says so.
2. **Model validation is operational only.** No accuracy claim is made anywhere in the contract or the
   code; that requires labelled footage and is AI-5e's job.
3. **The drain window is a policy value, not a completion signal.** `drainMs` says how long to hold
   the outgoing model, not that every in-flight frame provably finished — the runtime does not track
   individual frames across the pipeline, and pretending otherwise would be false precision.
4. **`recover()` is driven by the supervisor's sweep or an operator call**, not by a background timer.
   Adding a scheduler thread would be an architectural addition; the sweep is where the existing
   control loop already runs.
