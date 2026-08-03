/**
 * Evidence search scale benchmark (P-5.1, TD-25 — Architect rec 2: "benchmark").
 *
 * ⚠️ **This one runs against a real MongoDB, and that is deliberate.** The incident benchmark
 * measures the in-memory store because that is the only thing it can measure without a database.
 * Here the finding *is* the planner: TD-25 was never a slow function, it was an index examining 500
 * documents to return 1. An in-memory benchmark would have measured something true and irrelevant.
 *
 * What it reports, per query and per scale:
 *
 * - **`examined / returned`** — the ratio TD-25 is about. It must stay flat as the collection grows.
 *   A ratio that tracks the collection size is the defect returning, whatever the milliseconds say.
 * - **median latency** — useful, machine-specific, and the weaker of the two signals.
 *
 * Skips with a clear message when no MongoDB is reachable. A benchmark that silently measures
 * nothing is worse than one that says it did not run (CONSTRAINTS §44).
 *
 * Run: `pnpm --filter @vip/service-evidence bench` (add `--json` for the machine-readable form).
 */
import { performance } from 'node:perf_hooks';
import { MongoClient, type Collection } from 'mongodb';
import { MongoEvidenceStore } from '../src/adapters/mongo-evidence-store.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_evidence_bench?authSource=admin';
const DB = 'vip_evidence_bench';

/**
 * Deliberately below the 10 M production target. A benchmark nobody runs because it takes an hour
 * is not a gate, and the **shape** of the ratio is visible long before the target — which is the
 * whole signal. The target itself is a documented expectation, not a claimed measurement.
 */
const SCALES = [10_000, 100_000, 500_000];
const REPEATS = 15;
const TENANT = 'tnt_bench';

const CAMERAS = 200;
const INCIDENTS = 5_000;
const CORRELATIONS = 5_000;

const QUERIES: { name: string; filter: Record<string, unknown> }[] = [
  { name: 'unfiltered page', filter: {} },
  { name: 'by incident (panel)', filter: { 'source.incidentId': 'inc_7' } },
  { name: 'by correlation (spine)', filter: { 'source.correlationId': 'corr_11' } },
  { name: 'by event', filter: { 'source.eventId': 'evt_512' } },
  { name: 'by camera', filter: { 'source.cameraId': 'cam_3' } },
  { name: 'kind + status', filter: { kind: 'clip', status: 'available' } },
];

interface Row {
  scale: number;
  query: string;
  index: string;
  examined: number;
  returned: number;
  medianMs: number;
}

function doc(index: number) {
  return {
    _id: `evd_${String(index).padStart(8, '0')}`,
    tenantId: TENANT,
    kind: index % 2 ? 'clip' : 'snapshot',
    status: 'available',
    capturedAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    source: {
      cameraId: `cam_${index % CAMERAS}`,
      incidentId: `inc_${index % INCIDENTS}`,
      eventId: `evt_${index}`,
      correlationId: `corr_${index % CORRELATIONS}`,
    },
  };
}

async function seed(col: Collection, scale: number): Promise<void> {
  await col.deleteMany({});
  const BATCH = 10_000;
  for (let start = 0; start < scale; start += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, scale - start) }, (_, i) => doc(start + i));
    await col.insertMany(batch as never[], { ordered: false });
  }
}

async function measure(col: Collection, filter: Record<string, unknown>) {
  const find = () =>
    col
      .find({ tenantId: TENANT, ...filter })
      .sort({ capturedAt: -1, _id: -1 })
      .limit(50);

  const explained = (await find().explain('executionStats')) as {
    queryPlanner: { winningPlan: Record<string, unknown> };
    executionStats: { totalDocsExamined: number; nReturned: number };
  };
  const json = JSON.stringify(explained.queryPlanner.winningPlan);

  await find().toArray(); // warm
  const samples: number[] = [];
  for (let run = 0; run < REPEATS; run += 1) {
    const started = performance.now();
    await find().toArray();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);

  return {
    index: json.match(/"indexName":"([^"]+)"/)?.[1] ?? '(none)',
    examined: explained.executionStats.totalDocsExamined,
    returned: explained.executionStats.nReturned,
    medianMs: samples[Math.floor(samples.length / 2)]!,
  };
}

async function main(): Promise<void> {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 2000 });
  try {
    await client.connect();
    await client.db(DB).command({ ping: 1 });
  } catch {
    process.stdout.write(
      '\nSKIPPED — no MongoDB reachable at MONGO_URI.\n' +
        'This benchmark measures query plans, so there is nothing honest to report without one.\n\n',
    );
    await client.close().catch(() => {});
    return;
  }

  const col = client.db(DB).collection('evidence_bench');
  await col.dropIndexes().catch(() => {});
  await new MongoEvidenceStore(col as never).ensureIndexes();

  const rows: Row[] = [];
  for (const scale of SCALES) {
    await seed(col, scale);
    for (const { name, filter } of QUERIES) {
      rows.push({ scale, query: name, ...(await measure(col, filter)) });
    }
  }

  await col.drop().catch(() => {});
  await client.close();

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  process.stdout.write('\nEvidence search — real MongoDB. examined/returned is the signal.\n');
  process.stdout.write(`${'-'.repeat(96)}\n`);
  process.stdout.write(
    `${'query'.padEnd(24)}${'index'.padEnd(22)}${SCALES.map((s) => `${s}`.padStart(16)).join('')}\n`,
  );
  for (const { name } of QUERIES) {
    const first = rows.find((r) => r.query === name)!;
    const cells = SCALES.map((scale) => {
      const row = rows.find((r) => r.scale === scale && r.query === name)!;
      return `${row.examined}/${row.returned} ${row.medianMs.toFixed(1)}ms`.padStart(16);
    });
    process.stdout.write(`${name.padEnd(24)}${first.index.padEnd(22)}${cells.join('')}\n`);
  }
  process.stdout.write(
    '\nThe ratio must stay flat as the scale grows. One that tracks collection size is TD-25\n' +
      'returning. Latency is machine-specific; the ratio is not.\n\n',
  );
}

await main();
