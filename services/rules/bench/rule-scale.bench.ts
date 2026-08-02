/**
 * Rule-engine scale benchmark (P-4.1, Architect rec 13).
 *
 * Measures how compilation and evaluation behave as a tenant's rule count grows — 100, 500, 1,000,
 * 5,000 — so that a future change which quietly turns a linear cost into a quadratic one is caught by
 * a number rather than by a customer.
 *
 * **What these numbers are, and are not.** They are a baseline for comparison on the machine that
 * produced them, recorded in `docs/architecture/RULE_ENGINE_BASELINE.md`. They are not thresholds, not
 * a capacity model, and not transferable between machines: an absolute millisecond figure from a
 * laptop says nothing about a production node. What *is* transferable is the **shape** — cost per rule
 * should stay flat as the count grows, and the regression gate in `scale.test.ts` asserts that shape
 * rather than any of these figures.
 *
 * Deterministic: fixed rule shapes, a fixed event sequence, no clock in the measured path, no I/O.
 *
 * Run: `pnpm --filter @vip/service-rules bench` (add `--json` for the machine-readable form).
 */
import { performance } from 'node:perf_hooks';
import type { EventEnvelope, Rule } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { RuleSetCache } from '../src/application/compiled-rules.js';
import { RuleStatsRegistry } from '../src/application/rule-stats.js';
import { evaluateRule } from '../src/domain/rule-evaluator.js';
import { matchesScope } from '../src/domain/scope.js';
import type { RuleStore } from '../src/application/ports.js';

const SCALES = [100, 500, 1_000, 5_000];
const EVENTS = 20_000;
const TENANT = 'tnt_bench';

/**
 * A realistic mix rather than 5,000 copies of one rule.
 *
 * A benchmark over identical rules measures the branch predictor. Every fourth rule is scoped to a
 * zone (so most events miss its scope, which is the common shape in a large estate), every third has a
 * nested condition, and the rest are tenant-wide — roughly what a mature tenant looks like.
 */
function buildRules(count: number): Rule[] {
  const rules: Rule[] = [];
  for (let i = 0; i < count; i += 1) {
    const scoped = i % 4 === 0;
    const deep = i % 3 === 0;
    rules.push({
      id: `rl_${i}`,
      tenantId: TENANT,
      name: `rule ${i}`,
      lifecycle: 'enabled',
      priority: 1000 - (i % 1000),
      version: 1,
      eventTypes: i % 2 === 0 ? ['perception.person.detected'] : [],
      categories: [],
      condition: deep
        ? {
            all: [
              { field: 'confidence', op: 'gte', value: 0.5 },
              {
                any: [
                  { field: 'subjects.0.class', op: 'eq', value: 'person' },
                  { field: 'subjects.0.attributes.color', op: 'eq', value: 'blue' },
                ],
              },
            ],
          }
        : { field: 'confidence', op: 'gte', value: 0.6 },
      severity: 'medium',
      actions: [{ type: 'raise-incident' }],
      scope: scoped ? { nodeIds: [`on_${i}`], cameraIds: [] } : { nodeIds: [], cameraIds: [] },
      ...(scoped
        ? {
            resolvedScope: {
              zoneIds: [`zone_${i}`, `zone_${i}_b`],
              cameraIds: [],
              tenantWide: false,
              resolvedAt: '2026-08-03T00:00:00.000Z',
            },
          }
        : {}),
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    });
  }
  return rules;
}

/** A fixed event sequence: most events land in a zone no scoped rule covers, some in one that is. */
function buildEvents(count: number, scaleCount: number): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    events.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      type: 'perception.person.detected',
      envelopeVersion: '1.0.0',
      category: 'perception',
      schemaVersion: '1.0.0',
      tenantId: TENANT,
      cameraId: `cam_${i % 50}`,
      zoneId: i % 10 === 0 ? `zone_${(i * 4) % scaleCount}` : `zone_unmatched_${i % 100}`,
      occurredAt: '2026-08-03T00:00:00.000Z',
      ingestedAt: '2026-08-03T00:00:00.100Z',
      producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
      confidence: 0.5 + (i % 50) / 100,
      subjects: [{ class: 'person', bbox: [0.1, 0.2, 0.3, 0.4], attributes: { color: 'red' } }],
      payload: {},
      evidenceRefs: [],
      priority: 'info',
    } as EventEnvelope);
  }
  return events;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

interface ScaleResult {
  rules: number;
  compileMs: number;
  evaluations: number;
  eventP50Micros: number;
  eventP95Micros: number;
  perRuleNanos: number;
  cacheHitRatio: number;
  heapMb: number;
}

async function runScale(count: number): Promise<ScaleResult> {
  const rules = buildRules(count);
  const events = buildEvents(EVENTS, count);
  const store = {
    async listEnabled() {
      return rules;
    },
  } as unknown as RuleStore;
  const stats = new RuleStatsRegistry();
  const cache = new RuleSetCache({ store, maxRulesPerEvent: 10_000, ttlMs: 3_600_000, stats });
  const scope = TenantScope.fromTenantId(TENANT);

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;

  const compileStart = performance.now();
  const compiled = await cache.get(scope);
  const compileMs = performance.now() - compileStart;

  // Warm the JIT before measuring, so the first few hundred events do not dominate the p95.
  for (const event of events.slice(0, 500)) {
    for (const { rule, scope: ruleScope } of compiled.rules) {
      if (matchesScope(ruleScope, event)) evaluateRule(rule, event);
    }
  }

  const samples: number[] = [];
  let evaluations = 0;
  for (const event of events) {
    const start = performance.now();
    const set = await cache.get(scope);
    for (const { rule, scope: ruleScope } of set.rules) {
      evaluations += 1;
      if (!matchesScope(ruleScope, event)) continue;
      evaluateRule(rule, event);
    }
    samples.push((performance.now() - start) * 1000);
  }

  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
  samples.sort((a, b) => a - b);

  return {
    rules: count,
    compileMs,
    evaluations,
    eventP50Micros: percentile(samples, 50),
    eventP95Micros: percentile(samples, 95),
    perRuleNanos: (percentile(samples, 50) * 1000) / count,
    cacheHitRatio: cache.statsFor(TENANT).hitRatio,
    heapMb,
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const results: ScaleResult[] = [];
  for (const count of SCALES) results.push(await runScale(count));

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ events: EVENTS, results }, null, 2)}\n`);
    return;
  }

  const rows = results.map((r) => ({
    rules: r.rules,
    'compile (ms)': r.compileMs.toFixed(2),
    'event p50 (µs)': r.eventP50Micros.toFixed(1),
    'event p95 (µs)': r.eventP95Micros.toFixed(1),
    'per rule (ns)': r.perRuleNanos.toFixed(1),
    'cache hit': `${(r.cacheHitRatio * 100).toFixed(2)}%`,
    'heap (MB)': r.heapMb.toFixed(1),
  }));
  process.stdout.write(`\n${EVENTS.toLocaleString()} events per scale\n`);
  // eslint-disable-next-line no-console
  console.table(rows);
  process.stdout.write(
    '\nThese are a baseline for comparison on this machine, not thresholds. The shape — per-rule cost\n' +
      'staying flat as the count grows — is what matters and is what the regression gate asserts.\n\n',
  );
}

await main();
