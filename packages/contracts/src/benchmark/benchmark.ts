/**
 * Benchmark + performance-governance contracts (AI-5a, Production Readiness). These are **operational
 * governance** shapes — NOT perception contracts and NOT new architecture. They make the platform's
 * performance measurable and its acceptance criteria explicit, so every optimization is evidence-driven
 * (benchmark before optimizing) and every deployment is validated against documented budgets/SLOs.
 *
 * They do NOT touch the five frozen AI Runtime v1.0 contracts (DetectionResult/Track/BehaviorResult/
 * CompositeBehavior/EventEnvelope) — AI-5 evolves OPERATIONAL behavior only (ED-0039/ED-0040).
 *
 * Grounds: docs/architecture/future/PRODUCTION_KPIS.md, AI_EXECUTION_ARCHITECTURE §11; the runtime
 * mirrors these in ai/inference/benchmark.py; JSON Schema is generated from here.
 */
import { z } from 'zod';
import { IsoDateTime, SemVer } from '../common/primitives.js';

/**
 * A reference deployment class (Architect AI-5 rec 2). The benchmark framework is hardware-NEUTRAL but
 * reports hardware-SPECIFIC results tagged with the class it ran on. Open-ended by intent (edge devices
 * vary); this enum documents the standard reference set.
 */
export const DeploymentClass = z.enum(['dev-laptop', 'mini-pc-i5', 'rtx-desktop', 'edge-device']);
export type DeploymentClass = z.infer<typeof DeploymentClass>;

/**
 * A benchmark workload (Architect AI-5 rec 7) — a realistic scenario to measure, not a synthetic peak.
 * Camera count + resolution + frame rate + duration define operational realism (1/4/8 cameras, mixed
 * resolutions/fps, long-duration continuous runs).
 */
export const BenchmarkWorkload = z.object({
  name: z.string().min(1),
  /** Concurrent cameras in this workload. */
  cameras: z.number().int().positive(),
  /** Resolution label (e.g. `720p`, `1080p`, `mixed`). Descriptive; the harness is resolution-agnostic. */
  resolution: z.string().min(1).default('synthetic'),
  /** Target sampling FPS per camera. */
  targetFps: z.number().positive().default(5),
  /** Frames processed per camera in the run. */
  frames: z.number().int().positive(),
  /** Wall-clock duration for a continuous run, when time-bounded rather than frame-bounded. */
  durationSeconds: z.number().nonnegative().optional(),
  description: z.string().max(500).optional(),
});
export type BenchmarkWorkload = z.infer<typeof BenchmarkWorkload>;

/**
 * A performance budget / SLO set (Architect AI-5 rec 3 + performance-budgets addendum) — the documented
 * production ACCEPTANCE CRITERIA a deployment class must meet. A benchmark passes when its KPIs are
 * within these ceilings/floors. All thresholds optional so a class can constrain only what it cares about.
 */
export const PerformanceBudget = z.object({
  deploymentClass: DeploymentClass,
  /** Floor: minimum sustained FPS per camera (e.g. 5 for behaviour analysis on edge). */
  minSustainedFps: z.number().nonnegative().optional(),
  /** Ceiling: end-to-end event latency (ms) — e.g. 200 ms target. */
  maxEventLatencyMs: z.number().nonnegative().optional(),
  /** Ceiling: inference latency p95 (ms). */
  maxInferenceLatencyMs: z.number().nonnegative().optional(),
  /** Ceiling: acceptable frame loss (percent). */
  maxFrameLossPercent: z.number().min(0).max(100).optional(),
  /** Ceiling: camera/pipeline startup time (ms). */
  maxStartupMs: z.number().nonnegative().optional(),
  /** Ceiling: automatic recovery time after a disconnect (seconds). */
  maxRecoverySeconds: z.number().nonnegative().optional(),
  /** Ceilings for the deployment class's resource envelope. */
  cpuCeilingPercent: z.number().min(0).max(100).optional(),
  memoryCeilingMb: z.number().nonnegative().optional(),
  gpuCeilingPercent: z.number().min(0).max(100).optional(),
});
export type PerformanceBudget = z.infer<typeof PerformanceBudget>;

/**
 * The measured KPIs of a benchmark run (Architect AI-5 rec 1) — the official performance baseline the
 * platform compares every future optimization against. Deterministically computable from counters + a
 * latency sample; GPU/CPU/memory optional (reported where measurable).
 */
export const BenchmarkKpis = z.object({
  /** Sustained frames/sec across the run (per camera when normalized). */
  fps: z.number().nonnegative(),
  inferenceLatencyP50Ms: z.number().nonnegative(),
  inferenceLatencyP95Ms: z.number().nonnegative(),
  /** End-to-end latency (ms) from frame to emitted EventEnvelope. */
  eventLatencyMs: z.number().nonnegative(),
  /** Events emitted per second. */
  eventThroughput: z.number().nonnegative(),
  droppedFramePercent: z.number().min(0).max(100),
  framesProcessed: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  cpuPercent: z.number().nonnegative().optional(),
  gpuPercent: z.number().nonnegative().optional(),
  memoryMb: z.number().nonnegative().optional(),
});
export type BenchmarkKpis = z.infer<typeof BenchmarkKpis>;

/**
 * Per-criterion budget verdict (Architect AI-5a refinement 9): `pass` · `warning` (within margin of the
 * limit) · `fail` · `na` (budget did not constrain this KPI). Evaluation is **informational** in AI-5a —
 * it never changes runtime behavior.
 */
export const BudgetVerdict = z.enum(['pass', 'warning', 'fail', 'na']);
export type BudgetVerdict = z.infer<typeof BudgetVerdict>;

/**
 * A lightweight environment fingerprint (Architect AI-5a refinement 2) so benchmark results can be
 * compared across machines. Descriptive metadata only — nothing is required, nothing affects behavior.
 */
export const EnvironmentFingerprint = z.object({
  os: z.string().min(1),
  arch: z.string().min(1),
  pythonVersion: z.string().min(1),
  cpuModel: z.string().max(200).optional(),
  logicalCores: z.number().int().positive().optional(),
  totalMemoryMb: z.number().nonnegative().optional(),
  gpu: z.string().max(200).optional(),
});
export type EnvironmentFingerprint = z.infer<typeof EnvironmentFingerprint>;

/**
 * A complete benchmark report — workload + measured KPIs + (optional) budget evaluation. This is the
 * governance artifact: the recorded baseline and the pass/fail against production acceptance criteria.
 */
export const BenchmarkReport = z.object({
  id: z.string().min(1),
  /** Harness/algorithm version (Architect AI-5a refinement 1) — reproducibility across harness changes. */
  benchmarkVersion: SemVer.default('1.0.0'),
  deploymentClass: DeploymentClass,
  runtimeVersion: SemVer,
  workload: BenchmarkWorkload,
  kpis: BenchmarkKpis,
  budget: PerformanceBudget.optional(),
  /** Per-KPI verdicts against the budget (keys are KPI names). */
  budgetStatus: z.record(z.string(), BudgetVerdict).default({}),
  /** Overall pass = every constrained KPI passed (a `warning` does not fail). Null when no budget applied. */
  passed: z.boolean().nullable().default(null),
  /** The environment the run executed on (refinement 2) — enables cross-machine comparison. */
  environment: EnvironmentFingerprint.optional(),
  /** Echo of the run configuration (refinement 1) — frames, warmupFrames, targetFps, deterministic, … */
  configuration: z.record(z.string(), z.unknown()).default({}),
  /**
   * Stable digests of the two things that invalidate a comparison (Architect AI-5b refinement 5).
   * Two reports are directly comparable **only** when both fingerprints match; when they differ, the
   * delta is explained by config or hardware, not by the runtime change under test. Derived
   * deterministically from `configuration` / `environment`, so they never carry new information —
   * they make an existing invariant checkable at a glance.
   */
  configurationFingerprint: z.string().min(1).max(64).optional(),
  hardwareFingerprint: z.string().min(1).max(64).optional(),
  /** Reserved (refinement 3): a prior report id this run should be compared against. No regression logic in AI-5a. */
  baselineId: z.string().min(1).optional(),
  recordedAt: IsoDateTime,
  /** Free-form host summary — descriptive, never a business signal. */
  host: z.string().max(500).optional(),
  notes: z.string().max(1000).optional(),
});
export type BenchmarkReport = z.infer<typeof BenchmarkReport>;

// ---------------------------------------------------------------------------
// Baseline comparison (AI-5c) — evidence-driven optimization
// ---------------------------------------------------------------------------

/**
 * How a candidate KPI moved against the baseline. `improved`/`regressed` are only claimed once the
 * change exceeds a noise threshold — a 0.4% "improvement" on a wall-clock benchmark is measurement
 * jitter, and treating it as a result is how unjustified optimizations get merged.
 */
export const ComparisonVerdict = z.enum(['improved', 'unchanged', 'regressed', 'na']);
export type ComparisonVerdict = z.infer<typeof ComparisonVerdict>;

/** One KPI's movement between two runs. */
export const KpiDelta = z.object({
  kpi: z.string().min(1),
  baseline: z.number(),
  candidate: z.number(),
  /** candidate − baseline (raw units). */
  delta: z.number(),
  /** Percentage change relative to the baseline. */
  deltaPercent: z.number(),
  /** Whether higher is better for this KPI (fps) or worse (latency, drops). */
  higherIsBetter: z.boolean(),
  verdict: ComparisonVerdict,
});
export type KpiDelta = z.infer<typeof KpiDelta>;

/**
 * The governance artifact for the Architect's optimization workflow (AI-5b rec 7):
 * **Baseline → Optimization → Re-benchmark → Compare → Accept or reject.**
 *
 * `accepted` is the gate: an optimization is accepted only when it shows a measurable improvement and
 * no regression beyond threshold. `comparable` guards the whole thing — two reports with different
 * configuration or hardware fingerprints are NOT comparable, and a comparison that ignores that would
 * launder a hardware upgrade as a code improvement.
 */
export const BenchmarkComparison = z.object({
  baselineId: z.string().min(1),
  candidateId: z.string().min(1),
  workload: z.string().min(1),
  deploymentClass: DeploymentClass,
  /** False when configuration/hardware fingerprints differ — the deltas are then informational only. */
  comparable: z.boolean().default(true),
  /** Why the runs are not comparable, when they are not. */
  incomparableReason: z.string().max(500).optional(),
  deltas: z.array(KpiDelta).default([]),
  improved: z.array(z.string()).default([]),
  regressed: z.array(z.string()).default([]),
  /** Noise threshold (%) below which a change is `unchanged`. */
  thresholdPercent: z.number().nonnegative().default(5),
  /** Overall: a measurable improvement with no regression → accept the optimization. */
  accepted: z.boolean().default(false),
  summary: z.string().max(1000).optional(),
  recordedAt: IsoDateTime,
});
export type BenchmarkComparison = z.infer<typeof BenchmarkComparison>;
