/**
 * G-3.5 req #7 — Performance baseline (NOT an optimisation target). Establishes deterministic
 * throughput / latency numbers for the full in-process spine (event → rule → candidate → incident →
 * alert) at 100 / 1 000 / 10 000 events. Each event is given a distinct dedup identity (spaced
 * occurredAt + distinct camera) so it produces its own incident, exercising the whole fan-out.
 *
 * Latency = wall-clock to drive ONE event through the entire synchronous cascade. Queue depth is 0 by
 * construction here (the in-memory bus processes each message to completion before the next); in
 * production it is the NATS consumer backlog surfaced by the runtime's RuntimeMetrics.queueDepth (G-3).
 * Numbers are logged for the report; assertions only guard against pathological regressions.
 */
import { describe, expect, it } from 'vitest';
import type { DetectionResult } from '@vip/contracts';
import { PlatformHarness } from '../src/harness.js';

const TENANT = 'tnt_perf';
const BASE = Date.parse('2026-07-30T00:00:00.000Z');
const BUCKET_MS = 61_000; // > the 60 s candidate dedup window ⇒ every event is its own incident

function perfDetection(i: number): DetectionResult {
  const capturedAt = new Date(BASE + i * BUCKET_MS).toISOString();
  return {
    tenantId: TENANT,
    cameraId: `cam-${i}`,
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'stub',
    model: {
      name: 'stub',
      version: '1.0.0',
      task: 'object-detection',
      family: '*',
      accelerator: 'cpu',
    },
    frame: { seq: i, capturedAt },
    detections: [
      {
        label: 'person',
        confidence: 0.95,
        bbox: [0.1, 0.2, 0.3, 0.4],
        attributes: {},
        metadata: {},
      },
    ],
    inferenceMs: 1,
    correlationId: `perf-${i}`,
    at: capturedAt,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function baseline(
  n: number,
): Promise<{ n: number; throughput: number; avgMs: number; p95Ms: number }> {
  const h = new PlatformHarness();
  await h.start();
  await h.seedChannel(TENANT);
  await h.seedRule(TENANT, {
    name: 'person → medium',
    lifecycle: 'enabled',
    priority: 100,
    eventTypes: ['perception.person.detected'],
    categories: [],
    severity: 'medium',
    actions: [{ type: 'raise-incident' }],
  });

  const latencies: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await h.emitDetection(perfDetection(i));
    latencies.push(performance.now() - s);
  }
  const totalMs = performance.now() - t0;

  // Correctness at scale: every event produced its own event + incident + notification.
  expect(h.countPublished((sub) => sub.includes('.event.'))).toBe(n);
  expect(h.countPublished((sub) => sub.endsWith('.incident.raised'))).toBe(n);
  expect(h.countPublished((sub) => sub.endsWith('.notification.delivered'))).toBe(n);
  await h.stop();

  latencies.sort((a, b) => a - b);
  return {
    n,
    throughput: Math.round((n / totalMs) * 1000),
    avgMs: Number((latencies.reduce((a, b) => a + b, 0) / n).toFixed(4)),
    p95Ms: Number(percentile(latencies, 95).toFixed(4)),
  };
}

describe('performance baseline', () => {
  const table: Awaited<ReturnType<typeof baseline>>[] = [];

  it('100 events', async () => {
    const r = await baseline(100);
    table.push(r);
    expect(r.throughput).toBeGreaterThan(100);
  });

  it('1 000 events', async () => {
    const r = await baseline(1_000);
    table.push(r);
    expect(r.throughput).toBeGreaterThan(100);
  });

  it('10 000 events', async () => {
    const r = await baseline(10_000);
    table.push(r);
    expect(r.throughput).toBeGreaterThan(50);
    // eslint-disable-next-line no-console
    console.log('\nG-3.5 performance baseline (full spine, in-process):');
    for (const row of [...table].sort((a, b) => a.n - b.n)) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(row.n).padStart(6)} events  ·  throughput ${row.throughput}/s  ·  avg ${row.avgMs}ms  ·  p95 ${row.p95Ms}ms  ·  queueDepth 0`,
      );
    }
  }, 120_000);
});
