# AI-4 — Advanced Behavior Analytics & Retail Pilot (Composite Behaviors + Profiles)

> **Milestone:** AI Processing Phase **AI-4** · **Status:** ✅ **ACCEPTED** (Architect review 2026-07-31) — AI Runtime Architecture **v1.0** declared; contracts frozen (additive-only); AI-5 = production readiness
> **Scope:** a **CompositeBehavior** tier (consumes BehaviorResults, produces higher-order
> BehaviorResults), **BehaviorProfiles** (declarative deployment config), two generic primitives
> (crowd/occupancy), and the **retail pilot delivered entirely as configuration** — **in `ai/inference`,
> no new service, no industry-specific code**.
> **North star (Architect):** _optimize for the CompositeBehavior contract; retail is a profile, not a class._
> Reference: [AI_EXECUTION_ARCHITECTURE](../architecture/future/AI_EXECUTION_ARCHITECTURE.md) · [ED-0038](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. The fifth platform contract — CompositeBehavior

```
DetectionResult → Track → BehaviorResult → CompositeBehavior → EventEnvelope
                            (primitives)      (compositions)       (existing spine)
```

Execution is a deterministic two-pass flow (Architect rec 6):

```
Primitive Behaviors → Composite Pass → Translator → EventEnvelope
```

- A **`CompositeBehaviorAnalyzer`** ([composite.py](../../ai/inference/composite.py)) consumes ONLY
  `BehaviorResult`s (never Detections / Tracks / ZoneEngine internals — rec 5), via a `CompositeContext`
  carrying the **active** primitive behaviors + a plain zone-id→role map. It produces higher-order
  `BehaviorResult`s referencing contributors through `relatedBehaviorIds`.
- The generic **`RuleCompositeAnalyzer`** evaluates a declarative rule — _"these behavior types co-occur
  on the same subject/zone, optionally in a zone of role X, with dwell ≥ N"_ — so a customer defines new
  composites in **config, not code** (rec 11). The composition engine is **domain-neutral** (rec 1).
- **`CompositeRegistry`** ([composite_registry.py](../../ai/inference/composite_registry.py)) orchestrates
  the pass, rejects **circular composite graphs** at startup (`validate_acyclic`, rec 5), and records
  match/miss/latency/confidence metrics (refinement 8).
- A composite is still a `BehaviorResult` → the single `BehaviorResultTranslator` maps it to an event
  (its target `eventType` is config-driven), so **the whole downstream platform is unchanged**.

## 2. Contract additions (`@vip/contracts/behavior`, +2 → 65 schemas)

- **`CompositeBehavior`** — a `BehaviorResult` with **required** `composite` metadata (the fifth contract, rec 12).
- **`CompositeMetadata`** (rec 2): `contributingBehaviorCount · evaluationWindow? · evaluationStrategy? · compositionVersion?`.
- **Behavior relationships** (rec 2): optional `parentBehaviorId · followsBehaviorId · relatedBehaviorIds` on every `BehaviorResult`.
- **`BehaviorEvidence`** (rec 3, reserved): `contributingTracks · contributingZones` populated; `supportingFrames · supportingDetections` **reserved** for the Evidence milestone.
- **`BehaviorProfile`** (rec 3/4) — declarative deployment config: `analyzers` (generic only), `composites` (rules incl. `confidenceStrategy`), `zoneRoles`, reserved `createdAt`/`author`/`version` (refinement 4). **Portable** — no tenant/camera/zone ids (rec 7).
- **`ZoneRole`** enum (rec 4) — documents common roles; analyzers never depend on the names in code.
- **`RuntimeMetrics`** extended additively (rec 8 + refinement 8): `analyzerQueueDepth · behaviorWindowCount · averageWindowDuration · activeTemporalWindows · compositeBehaviorCount · behaviorCorrelationCount · compositeEvaluations · compositeMatches · compositeMisses · averageCompositeLatency · averageCompositeConfidence · compositeExecutionTime · profileLoads · profileValidationFailures · activeProfiles · behaviorRelationshipCount`.
- **Event catalog:** added `analytics.crowd.density` (additive); composites reuse existing types via config (`behavior.theft.suspected` for the cash pilot).

## 3. Generic analyzers (reusable everywhere — recs 5/9/11)

Two new **generic** primitives ([behaviors/](../../ai/inference/behaviors/)): **`CrowdAnalyzer`** (density
over a `crowd`-flagged zone) and **`OccupancyAnalyzer`** (level over an `occupancy`-flagged zone). No
retail classes exist — cash-counter / checkout / staff / customer-dwell monitoring are **compositions of
generic analyzers keyed by zone roles**, expressed in the profile.

## 4. The Retail Pilot — pure configuration ([profiles/retail.json](../../ai/inference/profiles/retail.json))

The reference 4-camera layout ([AI_EXECUTION_ARCHITECTURE §8](../architecture/future/AI_EXECUTION_ARCHITECTURE.md))
as a `BehaviorProfile` + generic zone attributes:

| Camera       | Zone role / attribute | Capability (all generic)                                      |
| ------------ | --------------------- | ------------------------------------------------------------- |
| Entrance     | `entrance`            | entry/exit counting (AI-2)                                    |
| Shop floor   | `queue`, `crowd`      | queue (AI-3) + crowd (AI-4)                                   |
| Cash counter | `cash` + `loitering`  | `cash_counter_anomaly` composite → `behavior.theft.suspected` |
| Exit         | `occupancy`           | occupancy validation (AI-4)                                   |

Validation **fails fast** (rec 3) on unknown analyzers/types/roles, embedded ids (rec 7), or circular
composites (rec 5).

## 5. Recommendations — 12 authorization + 10 refinements = 22, all folded in

| Theme                                                  | Where                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| CompositeBehavior generic (not retail)                 | `RuleCompositeAnalyzer` + config-only retail                   |
| Composite metadata / relationships / evidence          | contract + `composite.py`                                      |
| Behavior profiles standardized + portable              | `profiles.py` (+ portability guard)                            |
| Zone roles as config only                              | `Zone.attributes.role`; analyzers key on generic flags         |
| Composite independence                                 | consumes only `BehaviorResult`s (`CompositeContext`)           |
| Composite execution graph / ordering                   | documented; two-pass; playground `executionOrder`              |
| Playground composite graph / relationships / trace     | `behaviors_timeline.json` compositeGraph/dependencyGraph/trace |
| Observability                                          | additive RuntimeMetrics + per-composite metrics                |
| Customer neutrality / customer-defined behaviors       | profiles + config-driven `RuleCompositeAnalyzer`               |
| Composite confidence strategy                          | `min/max/mean/weighted` (config, replaceable)                  |
| Profile validation (analyzers/composites/roles/schema) | `validate_profile` fail-fast                                   |
| Config versioning                                      | `version/createdAt/author` reserved                            |
| Cycle protection                                       | `CompositeRegistry.validate_acyclic`                           |
| Composite metrics (match/miss/latency)                 | `composite_registry.aggregate_metrics`                         |
| Behavior graph documentation                           | playground `dependencyGraph`                                   |
| Rule separation (perception only)                      | composites answer "what was observed?"; no schedules/POS       |

## 6. Playground (recs 7/9 + refinement 1/9)

`behaviors_timeline.json` gains **`compositeGraph`** (composite → contributors + trace), **`dependencyGraph`**
(behaviorType edges), **`executionOrder`** (primitive → composite → translator → event), and the active
**`profile`**. CLI: `--profile <name|path>` runs a deployment profile; `--no-composites`. Engineering-only.

## 7. Tests (deterministic, stdlib)

| Suite                        |       Count | Covers                                                                                                                         |
| ---------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------------------------ |
| contracts `behavior.test.ts` | 12 (of 148) | +CompositeBehavior/CompositeMetadata/BehaviorProfile/evidence                                                                  |
| Python `test_composite.py`   |          12 | confidence strategies, RuleComposite (all_of/zone-role/dwell), independence, registry cycle-detection + match/miss + lifecycle |
| Python `test_profiles.py`    |          10 | validation (unknown analyzer/type/role, portability), build (enable/cycle), **retail pilot end-to-end**, long-duration window  |

**Contracts 148 · Python 157** (+34). All repo gates green (typecheck 28, import-graph 19-pkg 0-viol,
contracts **65**, lint, build, format).

## 8. Definition of Done

- [x] `CompositeBehaviorAnalyzer` + generic `RuleCompositeAnalyzer` + `CompositeRegistry` (cycle-safe) — composites config-driven, consume only BehaviorResults.
- [x] Contracts `CompositeBehavior`/`BehaviorProfile`/`BehaviorEvidence`/`CompositeMetadata` (+2 → 65); relationships/evidence/composite on BehaviorResult; RuntimeMetrics additive.
- [x] Generic Crowd/Occupancy analyzers; `profiles.py` fail-fast validation + portability + cycle rejection; retail pilot as pure config.
- [x] Composite pass integrated after primitives; playground composite graph + execution order + profile; runtime boundary held (events only, perception only).
- [x] Deterministic tests green; no frozen doc (01–28) change; no new service.
- [x] **Architect review of AI-4** ✅ **ACCEPTED** (2026-07-31) — CompositeBehavior confirmed the fifth foundational contract. Closing docs delivered: [Capability Maturity](../architecture/future/CAPABILITY_MATURITY.md), contract **freeze** (additive-only) + **AI Runtime Architecture v1.0** ([ED-0039](../project/ENGINEERING_DECISION_LOG.md)). **AI-5 = production readiness** (architecture is frozen; effort shifts to models/latency/GPU/RTSP/multi-camera/edge/benchmarking/monitoring).
