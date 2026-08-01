/**
 * Benchmark / performance-governance contract tests (AI-5a). Prove the operational shapes that make the
 * platform measurable: workloads, performance budgets/SLOs, measured KPIs, and the benchmark report with
 * its per-KPI budget verdicts. These are operational contracts — they never touch the frozen five.
 */
import { describe, expect, it } from 'vitest';
import {
  BenchmarkReport,
  BenchmarkWorkload,
  PerformanceBudget,
  BenchmarkKpis,
  DeploymentClass,
  BudgetVerdict,
  EnvironmentFingerprint,
} from '../src/benchmark/benchmark.js';

describe('BenchmarkWorkload', () => {
  it('parses a workload with defaults', () => {
    const w = BenchmarkWorkload.parse({ name: 'four-cam', cameras: 4, frames: 300 });
    expect(w.cameras).toBe(4);
    expect(w.targetFps).toBe(5);
    expect(w.resolution).toBe('synthetic');
  });

  it('rejects a non-positive camera count', () => {
    expect(() => BenchmarkWorkload.parse({ name: 'x', cameras: 0, frames: 10 })).toThrow();
  });
});

describe('PerformanceBudget (SLOs / acceptance criteria)', () => {
  it('parses an edge budget with the addendum targets', () => {
    const b = PerformanceBudget.parse({
      deploymentClass: 'edge-device',
      minSustainedFps: 5,
      maxEventLatencyMs: 200,
      maxFrameLossPercent: 5,
    });
    expect(b.deploymentClass).toBe('edge-device');
    expect(b.minSustainedFps).toBe(5);
  });

  it('enumerates the reference deployment classes', () => {
    expect(DeploymentClass.options).toEqual([
      'dev-laptop',
      'mini-pc-i5',
      'rtx-desktop',
      'edge-device',
    ]);
  });
});

describe('BenchmarkReport', () => {
  const kpis = {
    fps: 6.2,
    inferenceLatencyP50Ms: 8,
    inferenceLatencyP95Ms: 15,
    eventLatencyMs: 120,
    eventThroughput: 30,
    droppedFramePercent: 1.2,
    framesProcessed: 300,
    durationSeconds: 48,
  };

  it('parses a full report with per-KPI verdicts', () => {
    const r = BenchmarkReport.parse({
      id: 'bench_1',
      deploymentClass: 'edge-device',
      runtimeVersion: '0.1.0',
      workload: { name: 'four-cam', cameras: 4, frames: 300 },
      kpis,
      budget: { deploymentClass: 'edge-device', minSustainedFps: 5, maxEventLatencyMs: 200 },
      budgetStatus: { fps: 'pass', eventLatencyMs: 'pass' },
      passed: true,
      recordedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(r.kpis.fps).toBe(6.2);
    expect(r.budgetStatus.eventLatencyMs).toBe('pass');
    expect(r.passed).toBe(true);
  });

  it('defaults passed/version/configuration when omitted (reproducibility metadata)', () => {
    const r = BenchmarkReport.parse({
      id: 'bench_2',
      deploymentClass: 'dev-laptop',
      runtimeVersion: '0.1.0',
      workload: { name: 'one-cam', cameras: 1, frames: 100 },
      kpis: BenchmarkKpis.parse(kpis),
      recordedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(r.passed).toBeNull();
    expect(r.budgetStatus).toEqual({});
    expect(r.benchmarkVersion).toBe('1.0.0');
    expect(r.configuration).toEqual({});
  });

  it('supports environment fingerprint + warning verdict', () => {
    expect(BudgetVerdict.options).toEqual(['pass', 'warning', 'fail', 'na']);
    const env = EnvironmentFingerprint.parse({
      os: 'Linux',
      arch: 'x86_64',
      pythonVersion: '3.12.0',
      logicalCores: 8,
    });
    expect(env.logicalCores).toBe(8);
  });

  it('records the five reproducibility anchors (AI-5b refinement 5)', () => {
    const r = BenchmarkReport.parse({
      id: 'bench_1',
      benchmarkVersion: '1.1.0',
      deploymentClass: 'dev-laptop',
      runtimeVersion: '0.2.0',
      workload: { name: 'multi-camera-live', cameras: 4, frames: 60 },
      kpis,
      environment: { os: 'Darwin', arch: 'arm64', pythonVersion: '3.12.0' },
      configuration: { frames: 60, cameras: 4, mode: 'deterministic-synthetic' },
      configurationFingerprint: 'cfg_9f2a1c4e',
      hardwareFingerprint: 'hw_3b7d0e11',
      recordedAt: '2026-07-31T10:00:00.000Z',
    });
    // runtime version · benchmark version · deployment class · config fingerprint · hardware fingerprint
    expect(r.runtimeVersion).toBe('0.2.0');
    expect(r.benchmarkVersion).toBe('1.1.0');
    expect(r.deploymentClass).toBe('dev-laptop');
    expect(r.configurationFingerprint).toBe('cfg_9f2a1c4e');
    expect(r.hardwareFingerprint).toBe('hw_3b7d0e11');
    // Additive: an AI-5a report without fingerprints still parses (baseline stays comparable).
    const legacy = BenchmarkReport.parse({
      id: 'bench_0',
      deploymentClass: 'dev-laptop',
      runtimeVersion: '0.1.0',
      workload: { name: 'single-camera', cameras: 1, frames: 60 },
      kpis,
      recordedAt: '2026-07-31T10:00:00.000Z',
    });
    expect(legacy.configurationFingerprint).toBeUndefined();
  });

  it('rejects a bad deployment class', () => {
    expect(() =>
      BenchmarkReport.parse({
        id: 'b',
        deploymentClass: 'mainframe',
        runtimeVersion: '0.1.0',
        workload: { name: 'x', cameras: 1, frames: 1 },
        kpis,
        recordedAt: '2026-07-31T10:00:00.000Z',
      }),
    ).toThrow();
  });
});
