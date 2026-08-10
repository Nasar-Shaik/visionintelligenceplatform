/**
 * Replay the behaviour reads of a stored analysis, and compare them byte for byte.
 *
 *   node tools/validation/association-replay.mjs --stream ases_… --out before.json
 *   node tools/validation/association-replay.mjs --stream ases_… --against before.json
 *
 * ⭐ **Why a replay tool exists at all.** The behaviour projections are pure functions over durable
 * track history (ADR-0054): nothing about a timeline, a graph or an association is stored, so every
 * read recomputes. That makes a *corrected* formula fix history rather than being unable to reach
 * it — and it makes the same read, on the same run, a repeatable measurement. This captures one and
 * diffs the next.
 *
 * ### ⛔ What only a side-by-side diff can catch
 *
 * A read's answer depends on more than the footage. It depends on the confidence floors, on the
 * carriable-label set, on which line zones the assignment gate happened to hold, on the entry caps.
 * Those are **configuration**, they are invisible in any single response, and a single response
 * always looks self-consistent. Two responses, on identical evidence, are the only thing that shows
 * a configuration change moving a number nobody meant to move.
 *
 * ⚠️ That is precisely how the slice-2.10 floor change had to be verified: identical footage before
 * and after, with `person` counts required to be **unchanged** and object counts required to move.
 * A run that showed both moving would have meant the floor had leaked into the person class.
 *
 * ### ⚠️ Volatile fields are removed, not tolerated
 *
 * Identity ids embed the run id, and footage epochs embed the upload's declared start. Those differ
 * between two runs of the same clip for reasons that mean nothing, and leaving them in would make
 * every diff fail — which trains everybody to ignore the diff. They are stripped by shape, and
 * `--keep-ids` turns that off when comparing one run against *itself* across a code change, which is
 * the strictest form of this check.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/* ⚠️ Scoped to this validation tool, never the application: the edge uses Caddy's internal CA. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';

const flag = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] !== undefined && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return index >= 0 ? true : fallback;
};

const STREAM = flag('stream');
const CAMERA = flag('camera');
const OUT = flag('out');
const AGAINST = flag('against');
const KEEP_IDS = flag('keep-ids', false) === true;

if (STREAM === null && CAMERA === null) {
  console.error('need --stream <analysisSessionId> or --camera <cameraId>');
  process.exit(2);
}

let token = '';
const login = async () => {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login: HTTP ${res.status}`);
  token = (await res.json()).data.accessToken;
};

const api = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-tenant-id': TENANT },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/**
 * Strip what differs between two runs of the same footage for reasons that mean nothing.
 *
 * ⛔ **By shape, never by name.** An earlier version listed the volatile keys; the first field that
 * gained an id was compared anyway and the diff was noise nobody read. Anything that *looks* like a
 * run-scoped id or an absolute epoch goes, which fails safe: a new volatile field is neutralised the
 * day it appears rather than the day somebody notices.
 */
const RUN_ID = /\b(ases|ana)_[0-9a-f]{8,}/g;
const EPOCH = /^1[6-9]\d{8}(\.\d+)?$/;

const normalise = (value) => {
  if (Array.isArray(value)) return value.map(normalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, normalise(inner)]),
    );
  }
  if (typeof value === 'string') {
    return KEEP_IDS ? value : value.replace(RUN_ID, '<run>');
  }
  if (typeof value === 'number' && !KEEP_IDS && EPOCH.test(String(value))) {
    /* ⚠️ An absolute footage epoch. The *offsets* derived from it are the meaningful values, and
     * they survive: only the origin is replaced. */
    return '<epoch>';
  }
  return value;
};

const scope = STREAM !== null ? `streamId=${encodeURIComponent(String(STREAM))}` : `cameraId=${encodeURIComponent(String(CAMERA))}`;

await login();

const [timeline, graph, primitives, history] = await Promise.all([
  api(`/api/behaviour/timeline?${scope}`),
  api(`/api/behaviour/graph?${scope}`),
  api(`/api/behaviour/primitives?${scope}`),
  api(`/api/track-history?${scope}`),
]);

for (const [name, res] of [['timeline', timeline], ['graph', graph], ['primitives', primitives], ['history', history]]) {
  if (res.status !== 200) {
    console.error(`${name}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    process.exit(1);
  }
}

const prim = primitives.body.data?.primitives ?? {};
const labelCounts = {};
for (const record of history.body.data?.records ?? []) {
  labelCounts[record.label] = (labelCounts[record.label] ?? 0) + 1;
}

const capture = {
  scope,
  /* ⭐ The summary a human reads first, and the one a regression is visible in. */
  summary: {
    records: history.body.data?.records?.length ?? 0,
    labels: Object.fromEntries(Object.entries(labelCounts).sort()),
    countsByKind: timeline.body.data?.countsByKind ?? {},
    byNodeKind: graph.body.data?.graph?.counts?.byNodeKind ?? {},
    byEdgeKind: graph.body.data?.graph?.counts?.byEdgeKind ?? {},
    associationDiagnostic: prim.associationDiagnostic ?? null,
    lineGeometry: timeline.body.data?.lineGeometry ?? null,
  },
  reads: normalise({
    timeline: timeline.body.data,
    graph: graph.body.data,
    primitives: primitives.body.data,
    history: history.body.data,
  }),
};

if (OUT !== null) {
  writeFileSync(String(OUT), JSON.stringify(capture, null, 2));
  console.log(`captured ${scope} → ${String(OUT)}`);
}

console.log(JSON.stringify(capture.summary, null, 2));

if (AGAINST === null) process.exit(0);

// --- the comparison -------------------------------------------------------------------------------

const before = JSON.parse(readFileSync(String(AGAINST), 'utf8'));

/** Every leaf path where two normalised trees disagree. */
const differences = (a, b, path = '') => {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const bothObjects =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) return [{ path, before: a, after: b }];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.flatMap((key) => differences(a[key], b[key], path === '' ? key : `${path}.${key}`));
};

const diff = differences(before.reads, capture.reads);

console.log(`\n=== replay: ${String(AGAINST)} vs this read ===`);
if (diff.length === 0) {
  console.log('⭐ byte for byte identical after normalisation.');
  process.exit(0);
}

console.log(`${String(diff.length)} difference(s):\n`);
for (const d of diff.slice(0, 40)) {
  const show = (v) => (v === undefined ? '(absent)' : JSON.stringify(v)).slice(0, 160);
  console.log(`  ${d.path}\n    before ${show(d.before)}\n    after  ${show(d.after)}`);
}
if (diff.length > 40) console.log(`  … and ${String(diff.length - 40)} more`);

/*
 * ⚠️ A difference is not automatically a failure — a deliberate change SHOULD move these numbers,
 * and that is the point of running this before and after one. The exit code says "something moved",
 * and a person says whether it was the thing they moved.
 */
process.exit(1);
