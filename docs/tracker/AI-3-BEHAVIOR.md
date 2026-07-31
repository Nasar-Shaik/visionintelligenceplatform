# AI-3 — Behavior Analysis (loitering · queue · intrusion · fire/smoke)

> **Milestone:** AI Processing Phase **AI-3** · **Status:** ✅ **ACCEPTED** (Architect review 2026-07-31) — AI-4 authorized
> **Scope:** add a platform-owned **behavioral intelligence** layer over the AI-2 tracks/zones — a
> generic `BehaviorAnalyzer` seam + registry, an immutable `BehaviorContext`, a reusable `TemporalWindow`,
> and four analyzers — **in `ai/inference`, no new service**.
> **North star (Architect):** _optimize for the BehaviorResult contract, not the behavior algorithm._
> Reference: [AI_EXECUTION_ARCHITECTURE](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0037](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. Architecture — the behavior is replaceable; the contract is the product

```
Detection → Track → [BehaviorAnalyzer(s) via Registry] → BehaviorResult → [Event Translator] → EventEnvelope
              (AI-2)        (stateless, pluggable)          (platform)        (single bridge)      (existing spine)
```

The same decoupling that made the tracker swappable in AI-2, applied to behaviors — a heuristic today,
an ML/LLM reasoner tomorrow, with **zero downstream impact**:

- **`BehaviorAnalyzer`** ([behavior.py](../../ai/inference/behavior.py)) is a Protocol that consumes the
  immutable **`BehaviorContext`** and returns pure **`BehaviorObservation`**s — no lifecycle, no events,
  no mutable state (Architect refinement 3). The internals are the analyzer's private business.
- **`BehaviorLifecycleStore`** owns lifecycle (`started → updated → ongoing → ended → expired`), stable
  `behaviorId`s, correlation ids, and cooldown — so analyzers stay stateless and replay-deterministic.
- **`TemporalWindow` / `TemporalWindowStore`** ([temporal_window.py](../../ai/inference/temporal_window.py))
  is the ONE place time-based state lives (rec 4/6) — loiter dwell, queue averages, and every future
  timed behavior reuse it; none implement timing independently.
- **`BehaviorRegistry`** ([behavior_registry.py](../../ai/inference/behavior_registry.py)) discovers,
  enables/disables/configures analyzers and **orchestrates** them (rec 2/13). Analyzers never call one
  another (rec 4/6); the pipeline owns execution order.
- **`BehaviorResultTranslator`** ([behavior_translator.py](../../ai/inference/behavior_translator.py))
  is the SINGLE bridge `BehaviorResult → EventEnvelope` (rec 3/11). Analyzers never emit envelopes.

Only the platform-owned **`BehaviorResult`** ([`@vip/contracts/behavior`](../../packages/contracts/src/behavior/behavior.ts))
crosses the boundary — consumed by rules/incident/evidence/dashboard, none of which know the analyzer.

## 2. Platform primitives (contract-first, +4 → 63 schemas)

- **`BehaviorResult`** — the SOLE analyzer output: `behaviorId · behaviorType · category · tenantId ·
cameraId · sessionId? · zoneId? · subjects[] · state · confidence · metrics · firstObserved ·
lastObserved · frameIndex · windowMs? · producer? · behaviorVersion? · severity? · correlationId? ·
attributes`.
- **`BehaviorState`** lifecycle (rec 2): `detected → started → ongoing → updated → ended → expired`.
- **`BehaviorCategory`** (rec 5): `security · safety · operational · retail · crowd · compliance` —
  coarse grouping ORTHOGONAL to `behaviorType`.
- **`TrackSnapshot`** (rec 5) — the immutable Track view analyzers receive.
- **`BehaviorConfig`** (refinement 2) — one shared config shape (`enabled · confidenceThreshold ·
cooldownSeconds · windowSeconds · customParameters`) so a future UI has a single form.
- **`BehaviorAnalyzerMetrics`** (refinement 7) — per-analyzer breakdown.
- **`RuntimeMetrics`** extended additively (rec 8): `activeBehaviors · completedBehaviors ·
averageBehaviorDuration · averageBehaviorConfidence · analyzerExecutionTime · analyzerInvocationCount ·
behaviorLatency · behaviorsPerMinute`.
- **Reserved (refinements 1/4/5):** `behaviorVersion`, `correlationId`, `severity` — optional, so
  populating them later is non-breaking. **Severity is NOT computed by the runtime** — it's the Rule
  Engine's, reserved only.
- **Event catalog:** reused `behavior.loitering.detected`, `analytics.queue.length`,
  `perception.fire.detected`/`perception.smoke.detected`; **added `security.intrusion.detected`**
  (additive, category `security`) — a perception primitive distinct from `spatial.zone.entered`.

## 3. The four AI-3 analyzers ([behaviors/](../../ai/inference/behaviors/))

| Analyzer       | Fires when                                                                                                 | Category    | Event                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- |
| **Loitering**  | confirmed track dwells in a `loitering`-flagged area zone > threshold (via `TemporalWindow`)               | security    | `behavior.loitering.detected`                            |
| **Queue**      | ≥ `minQueue` confirmed tracks in a `queue`-flagged zone (emits `updated` as length changes)                | operational | `analytics.queue.length`                                 |
| **Intrusion**  | confirmed track present in a `restricted`-flagged zone (perception primitive — rules decide "after-hours") | security    | `security.intrusion.detected`                            |
| **Fire/Smoke** | a track carries a `fire`/`smoke` label (**detector-independent** — reads labels only)                      | safety      | `perception.fire.detected` / `perception.smoke.detected` |

Zone opt-in is **configuration** (a generic `attributes` flag), not business meaning — the Rule Engine
still decides significance. Thresholds (dwell/queue/confidence) are detection **sensitivity**, not
business rules (Architect rec 12). Deferred to AI-4 but drop-in via the same seam: abandoned-object,
tailgating, crowd density, running, slip/fall, vehicle analytics, PPE compliance, custom behaviors.

## 4. Recommendations — where each landed (13 authorization + 8 refinements = 21)

| Theme                                     | Recommendation                                  | Where                                                |
| ----------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| BehaviorAnalyzer abstraction              | generic interface                               | `behavior.py` Protocol                               |
| Behavior Registry                         | discovery/enable/disable/configure              | `behavior_registry.py`                               |
| BehaviorResult contract                   | analyzers never emit events                     | `@vip/contracts/behavior` + translator               |
| BehaviorContext                           | shared immutable input                          | `behavior.py` frozen dataclass                       |
| Behavior lifecycle                        | started…expired                                 | `BehaviorState` + `BehaviorLifecycleStore`           |
| Behavior categories                       | reusable grouping                               | `BehaviorCategory`                                   |
| Temporal Window                           | one generic timing primitive                    | `temporal_window.py`                                 |
| TrackSnapshot                             | immutable analyzer input                        | `behavior_contracts.py`                              |
| Analyzer independence                     | never call one another                          | registry orchestration; stateless analyzers          |
| Detector independence                     | labels only                                     | fire analyzer reads labels; no engine coupling       |
| Event translation isolated                | one bridge                                      | `BehaviorResultTranslator`                           |
| AI observability                          | additive RuntimeMetrics + per-analyzer          | registry `aggregate_metrics` / `analyzer_metrics`    |
| Composite behaviors                       | independent results, future composition         | correlationId + independent analyzers                |
| Boundaries                                | perception only                                 | emits only EventEnvelopes; severity reserved not set |
| Behavior version / correlation / severity | reserved optional fields                        | `BehaviorResult` (refinements 1/4/5)                 |
| Analyzer config                           | one shared shape                                | `BehaviorConfig` (refinement 2)                      |
| Playground replay                         | behaviors_timeline.json                         | `playground.py` `_behaviors_doc`                     |
| Replay determinism                        | reproducible from snapshots+zones+window+config | stateless analyzers + injected clock/ids             |

## 5. Pipeline placement (deliberate deviation from rec 9)

Behavior Analysis runs **after** Zone/Counting (not between Tracking and Zone): loitering/queue/intrusion
consume zone membership + counts, so analyzers see the full spatial state. Each stage stays
independently replaceable and testable (documented in [video_analyzer.py](../../ai/inference/video_analyzer.py)).

## 6. AI Playground (rec 7) — Behavior Replay

`POST /playground/analyze` + the CLI now return/emit `behaviors` + `behaviorStats`. New artifact
**`behaviors_timeline.json`** (Behavior Replay): per-behavior lifecycle transitions, confidence
evolution, window statistics, associated tracks/zones, and the per-analyzer metrics. CLI:
`--no-behaviors`, `--loiter-seconds`, `--queue-min`, and `--diagnostics` overlays (behavior labels +
confidence + loiter/queue timers). Engineering-only.

## 7. Tests (deterministic, stdlib — no OpenCV/GPU/model)

| Suite                        |      Count | Covers                                                                                                                                                                                                         |
| ---------------------------- | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts `behavior.test.ts` | 7 (of 143) | BehaviorResult/TrackSnapshot/lifecycle/category shapes                                                                                                                                                         |
| Python `test_behavior.py`    |         27 | temporal window, immutable snapshot, registry+config, the 4 analyzers, lifecycle (started/updated/ended/expired), translator, analyzer independence, replay determinism, end-to-end integration + multi-camera |

**Contracts 143 · Python 135** (108 + 27). All repo gates green (typecheck 28, import-graph 19-pkg
0-viol, contracts **63**, lint, build, format).

## 8. Definition of Done

- [x] `BehaviorAnalyzer` + `BehaviorRegistry` + `BehaviorContext` + `BehaviorLifecycleStore` — behaviors fully swappable, stateless, independent.
- [x] Platform `BehaviorResult`/`TrackSnapshot`/`BehaviorConfig` contracts (+4 → 63); RuntimeMetrics additive behavior fields; reserved version/correlation/severity.
- [x] Four analyzers (loitering/queue/intrusion/fire-smoke); generic `TemporalWindow`; single `BehaviorResultTranslator`; `security.intrusion.detected` added.
- [x] Playground `behaviors_timeline.json` + diagnostics overlays; runtime boundary held (events only, severity reserved not set).
- [x] Deterministic tests green; no frozen doc (01–28) change; no new service.
- [x] **Architect review of AI-3** ✅ **ACCEPTED** (2026-07-31) — "completes the foundational perception architecture"; AI-4 (Advanced Behavior Analytics & Retail Pilot) authorized with 12 recommendations.
