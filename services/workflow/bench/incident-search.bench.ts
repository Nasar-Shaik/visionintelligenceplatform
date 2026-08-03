/**
 * Incident search scale benchmark (P-5.0 entry criterion G-4, Architect rec 5).
 *
 * Measures how the incident search behaves as a tenant's incident count grows — 100, 1,000, 10,000,
 * 100,000 — so a change that turns a bounded page into a full walk is caught by a number.
 *
 * ⚠️ **Read this before quoting a figure from it.** This benchmark runs against the **in-memory
 * store**. It does not start MongoDB, does not consult a query planner, and therefore says nothing
 * about index behaviour — the thing G-4 is actually about. Presenting it as a database benchmark
 * would be the fabricated-signal failure CONSTRAINTS §52–55 exist to prevent.
 *
 * What it does measure, and what it is for:
 *
 * - The **shape** of filter + sort + page cost as the collection grows. The in-memory adapter is
 *   what every unit test and local run uses, so a regression here is a regression developers hit.
 * - A **latency floor**: whatever Mongo costs, it costs at least this much work to assemble.
 *
 * Where index behaviour is actually verified:
 *
 * - `test/index-coverage.test.ts` — the query-shape → index model, which fails if a filter has no
 *   narrowing index. Runs everywhere, every time.
 * - `test/mongo-integration.test.ts` — `explain()` against a real MongoDB, asserting the planner
 *   picks the declared index and does no in-memory sort. Runs only when a database is reachable.
 *
 * Deterministic: fixed incidents, fixed queries, no clock in the measured path, no I/O.
 *
 * Run: `pnpm --filter @vip/service-workflow bench` (add `--json` for the machine-readable form).
 */
import { performance } from 'node:perf_hooks';
import type { Incident, IncidentQuery } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';

const SCALES = [100, 1_000, 10_000, 100_000];
const REPEATS = 50;
const TENANT = 'tnt_bench';
const scope = TenantScope.fromTenantId(TENANT);

const CAMERAS = 200;
const ZONES = 40;
const RULES = 25;
const STATUSES = ['raised', 'acknowledged', 'investigating', 'escalated', 'resolved'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * A realistic spread rather than N copies of one incident: a filter that matches everything and a
 * filter that matches nothing both measure the wrong thing. Roughly 1 in 200 incidents belongs to a
 * given camera, which is what a mid-size estate looks like.
 */
function buildIncident(index: number): Incident {
  const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  return {
    id: `inc_${String(index).padStart(7, '0')}`,
    tenantId: TENANT,
    status: STATUSES[index % STATUSES.length]!,
    severity: SEVERITIES[index % SEVERITIES.length]!,
    title: `incident ${index}`,
    category: 'perception',
    source: {
      ruleId: `rule_${index % RULES}`,
      ruleVersion: 1,
      ruleName: `rule ${index % RULES}`,
      candidateId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      dedupKey: `dedup_${index}`,
    },
    triggeredBy: {
      eventId: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`,
      eventType: 'perception.person.detected',
      cameraId: `cam_${index % CAMERAS}`,
      zoneId: `zone_${index % ZONES}`,
      occurredAt: at,
    },
    matchedCount: 1,
    version: 1,
    correlationId: `corr_${index % (RULES * 4)}`,
    causationId: `00000000-0000-4000-a000-${String(index).padStart(12, '0')}`,
    history: [{ from: null, to: 'raised', at }],
    assignments: [],
    notes: [],
    raisedAt: at,
    updatedAt: at,
  };
}

const QUERIES: { name: string; query: Partial<IncidentQuery> }[] = [
  { name: 'unfiltered page', query: {} },
  { name: 'by status', query: { status: 'raised' } },
  { name: 'by camera', query: { cameraId: 'cam_7' } },
  { name: 'by rule', query: { ruleId: 'rule_3' } },
  { name: 'by correlation', query: { correlationId: 'corr_11' } },
  { name: 'status + severity', query: { status: 'raised', severity: 'critical' } },
  {
    name: 'camera + window',
    query: { cameraId: 'cam_7', from: '2026-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
  },
];

interface Row {
  scale: number;
  query: string;
  medianMs: number;
  items: number;
}

async function measure(
  store: InMemoryIncidentStore,
  query: IncidentQuery,
): Promise<[number, number]> {
  // One warm run so the first measurement is not paying for lazily-built shapes.
  await store.list(scope, query);
  const samples: number[] = [];
  let items = 0;
  for (let run = 0; run < REPEATS; run += 1) {
    const started = performance.now();
    const page = await store.list(scope, query);
    samples.push(performance.now() - started);
    items = page.items.length;
  }
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(samples.length / 2)]!, items];
}

/**
 * Seed the store directly rather than through `insert`.
 *
 * `insert` scans the whole collection twice per row to enforce id and dedup-key uniqueness — a
 * correct in-memory stand-in for two unique indexes, and quadratic. At 100,000 rows that is ten
 * billion comparisons of setup to measure a query that takes microseconds. The fixture is unique by
 * construction, so nothing is being skipped except the check that proves it.
 */
function seed(scale: number): InMemoryIncidentStore {
  const store = new InMemoryIncidentStore();
  const rows = (store as unknown as { incidents: Incident[] }).incidents;
  for (let index = 0; index < scale; index += 1) rows.push(buildIncident(index));
  return store;
}

async function main(): Promise<void> {
  const rows: Row[] = [];

  for (const scale of SCALES) {
    const store = seed(scale);
    for (const { name, query } of QUERIES) {
      const [medianMs, items] = await measure(store, { limit: 50, ...query } as IncidentQuery);
      rows.push({ scale, query: name, medianMs, items });
    }
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  process.stdout.write('\nIncident search — in-memory store (NOT a MongoDB benchmark)\n');
  process.stdout.write(`${'-'.repeat(72)}\n`);
  process.stdout.write(`${'query'.padEnd(20)}${SCALES.map((s) => `${s}`.padStart(13)).join('')}\n`);
  for (const { name } of QUERIES) {
    const cells = SCALES.map((scale) => {
      const row = rows.find((r) => r.scale === scale && r.query === name)!;
      return `${row.medianMs.toFixed(3)} ms`.padStart(13);
    });
    process.stdout.write(`${name.padEnd(20)}${cells.join('')}\n`);
  }
  process.stdout.write(
    '\nIndex behaviour is verified in test/index-coverage.test.ts (always) and by explain()\n' +
      'in test/mongo-integration.test.ts (only when a MongoDB is reachable).\n\n',
  );
}

await main();
