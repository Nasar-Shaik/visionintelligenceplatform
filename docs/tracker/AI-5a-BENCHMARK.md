# AI-5a — Production KPIs + Benchmark Harness

> **Milestone:** Production Readiness **AI-5a** (first slice of AI-5) · **Status:** ✅ code + tests complete · ⏳ **Architect review pending**
> **Scope:** establish the platform's **official performance baseline** + measurable acceptance criteria
> — a deterministic **benchmark harness**, per-deployment-class **budgets/SLOs**, and the **KPI
> governance** doc. **In `ai/inference`, no new service; operational only — no perception capability,
> no change to the five frozen v1.0 contracts.**
> **North star (Architect):** _benchmark before optimizing; measurement is engineering governance._
> Reference: [PRODUCTION_KPIS](../architecture/future/PRODUCTION_KPIS.md) · [ED-0040](../project/ENGINEERING_DECISION_LOG.md). **Author:** Claude · _2026-07-31_

---

## 1. What AI-5a delivers

AI-5 is a **production-engineering** milestone, not architecture. AI-5a is its first slice: **make v1.0
measurable** so every later optimization (AI-5b…e) is evidence-driven.

- **Benchmark contracts** ([`@vip/contracts/benchmark`](../../packages/contracts/src/benchmark/benchmark.ts),
  +5 → **70 schemas**): `BenchmarkWorkload`, `PerformanceBudget` (SLOs), `BenchmarkKpis`,
  `EnvironmentFingerprint`, `BenchmarkReport` (+ `DeploymentClass`/`BudgetVerdict` enums). Operational
  governance shapes — they do **not** touch `DetectionResult`/`Track`/`BehaviorResult`/`CompositeBehavior`/
  `EventEnvelope`. `RuntimeMetrics` extended additively (`sessionCount`/`eventLatencyMs`/`eventThroughput`/
  `benchmarkRunCount`).
- **Harness** ([benchmark.py](../../ai/inference/benchmark.py)): pure, unit-tested KPI math (`percentile`,
  `evaluate_budget`, `build_report`) + `run_benchmark` over the **real pipeline** (stub adapter, synthetic
  frames — deterministic by default; real cameras/GPU are AI-5b+). **Warm-up is separated from
  measurement.** Multi-camera workloads (1/4/8) aggregate per-camera runs.
- **Budgets/SLOs** ([benchmarks/budgets.json](../../ai/inference/benchmarks/budgets.json)): per
  deployment class (dev-laptop · mini-pc-i5 · rtx-desktop · edge-device), encoding the Architect's
  performance-budget addendum (edge: ≥ 5 FPS, ≤ 200 ms event latency, bounded recovery).
- **CLI** ([benchmark_cli.py](../../ai/inference/benchmark_cli.py)): `--deployment <class> --suite` writes
  the **5-file artifact bundle** (`benchmark.json · summary.txt · runtime_metrics.json · environment.json
· configuration.json`); **exits non-zero on a budget FAIL** (CI-gateable). Warnings never fail.
- **Governance doc** ([PRODUCTION_KPIS](../architecture/future/PRODUCTION_KPIS.md)): KPIs, SLOs, budgets,
  deployment classes, realistic workloads, and the "benchmark before optimizing" rule.

## 2. Recommendations — 12 authorization + 10 refinements = 22, all folded in

| Theme                                                                   | Where                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| AI-5a = official baseline; benchmark before optimizing                  | harness + PRODUCTION_KPIS §5                                                         |
| Benchmark multiple deployment classes (hw-neutral, hw-specific results) | `DeploymentClass` + budgets.json + env fingerprint                                   |
| Define SLOs / acceptance criteria                                       | `PerformanceBudget` + budgets.json                                                   |
| Validate failure scenarios                                              | reserved for AI-5d; harness structure ready                                          |
| Scheduler policy-driven                                                 | AI-5c (noted; not in 5a)                                                             |
| Operational diagnostics                                                 | `runtime_metrics.json` bundle + additive metrics                                     |
| Realistic workloads (1/4/8/continuous/stress)                           | `standard_suite` + extensible `BenchmarkWorkload`                                    |
| Validate resource limits / graceful degradation                         | AI-5c/e (noted)                                                                      |
| Expand observability (additive)                                         | RuntimeMetrics `sessionCount`/`eventLatencyMs`/`eventThroughput`/`benchmarkRunCount` |
| Preserve architecture freeze                                            | operational contracts only; frozen five untouched                                    |
| Production readiness documentation                                      | PRODUCTION_KPIS (checklist proper = AI-5e)                                           |
| Maintain capability maturity                                            | promotion needs benchmark evidence (CAPABILITY_MATURITY)                             |
| **Reproducibility metadata** (refinement 1)                             | `benchmarkVersion`/`runtimeVersion`/`environment`/`configuration` on the report      |
| **Environment fingerprint** (refinement 2)                              | `EnvironmentFingerprint` + `environment.json`                                        |
| **Comparison support** (refinement 3)                                   | reserved `baselineId` (no regression logic yet)                                      |
| **Warm-up separation** (refinement 4)                                   | untimed warm-up pass in `run_benchmark`                                              |
| **Scenarios extensible** (refinement 5)                                 | `standard_suite` + `BenchmarkWorkload`                                               |
| **Deterministic default** (refinement 6)                                | stub adapter + synthetic frames                                                      |
| **Artifact bundle** (refinement 7)                                      | 5-file bundle from the CLI                                                           |
| **Production neutrality** (refinement 8)                                | generic person-detection pipeline; no profile/industry assumptions                   |
| **PASS/WARNING/FAIL** (refinement 9)                                    | `BudgetVerdict` + 10% warn margin; informational only                                |
| **Freeze respected** (refinement 10)                                    | no perception contract change; no new layer                                          |

## 3. Tests (deterministic, stdlib)

| Suite                         |      Count | Covers                                                                                                                                                         |
| ----------------------------- | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| contracts `benchmark.test.ts` | 8 (of 156) | workload/budget/KPIs/report shapes, verdict enum, env fingerprint, defaults                                                                                    |
| Python `test_benchmark.py`    |         10 | percentile math, budget PASS/WARNING/FAIL/na (informational), report reproducibility metadata, env fingerprint, warm-up separation, multi-camera harness smoke |

**Contracts 156 · Python 167** (+18). All gates green (typecheck 28, import-graph 19-pkg 0-viol,
contracts **70**, lint, build, format). CLI verified: 1/4/8-camera suite → PASS, 5-file bundle written.

## 4. Definition of Done

- [x] Benchmark contracts (+5 → 70) + additive `RuntimeMetrics`; operational only, frozen five untouched.
- [x] Deterministic harness (pure KPI math + real-pipeline runner) with warm-up separation + multi-camera.
- [x] Per-deployment-class budgets/SLOs; CLI 5-file bundle; CI-gateable (non-zero on FAIL).
- [x] KPI/SLO/budget governance doc; reproducibility metadata + environment fingerprint; PASS/WARNING/FAIL.
- [x] Deterministic tests green; no new service; no frozen-doc (01–28) change; no contract-freeze violation.
- [ ] **Architect review of AI-5a** ⏳ — the official baseline. Then **AI-5b** (RTSP live ingestion + multi-camera sessions).
