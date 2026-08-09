/**
 * Turn a soak's three JSONL streams into the tables the report quotes.
 *
 *   node tools/validation/soak-report.mjs .soak
 *   node tools/validation/soak-report.mjs .soak-p11 60000 --json .soak-p11/soak.json
 *
 * ⛔ **Nothing here is retyped by hand.** A number copied into Markdown is a number nobody can
 * re-measure; every table below is generated from the run's own append-only streams, so a reader
 * can regenerate it and get the same answer or find out that they cannot.
 *
 * ⛔ **And nothing here writes to those streams.** They are opened read-only; the report is stdout
 * and `--json` is a new file beside them. A report that can edit its own inputs is not evidence.
 *
 * P-11 added the sections a *release* soak has to answer, which a drift report does not: shape of
 * each series over the whole run, storage and log growth, evidence and invariant counts, the
 * behaviour/track-history/scene counters, and a computed GO/NO-GO over explicit criteria.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyseContinuity, describeContinuity } from './lib/continuity.mjs';

const OUT = process.argv[2] ?? '.soak';
const read = (name) => {
  try {
    return readFileSync(join(OUT, name), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const ops = read('ops.jsonl');
const metrics = read('metrics.jsonl');
const events = read('events.jsonl');

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const n = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : '—');

/* ── run continuity ──────────────────────────────────────────────────────────────────────── */
/*
 * ⛔ **First, because it decides whether anything below may be quoted.** Every table here divides
 * work by wall-clock time. A host that sleeps mid-soak freezes the process while the clock runs on,
 * so throughput, drift and per-hour figures all shrink toward a number nobody chose — and the
 * streams still look complete. Checked here rather than only in `soak.mjs` because a run that was
 * killed, or that died, never reaches its own finaliser, and that is exactly when this gets read.
 */
const sampleArg = Number(process.argv[3]);
const SAMPLE_MS = Number.isFinite(sampleArg) && sampleArg > 0 ? sampleArg : 60_000;
const continuity = analyseContinuity({ samples: metrics, intervalMs: SAMPLE_MS });
console.log('## Run continuity\n');
console.log(`${describeContinuity(continuity)}\n`);
if (!continuity.intact && !continuity.inconclusive) {
  console.log(
    `> ⚠️ Wall clock **${n(continuity.totalSeconds / 3600, 2)} h**, process awake ` +
      `**${n(continuity.uninterrupted.seconds / 3600, 2)} h**. Treat every rate below as describing the ` +
      `awake window only, and do not certify a release from this run.\n`,
  );
}

/* ── operations ──────────────────────────────────────────────────────────────────────────── */
const byKind = new Map();
for (const o of ops) {
  if (o.ms === undefined) continue;
  if (!byKind.has(o.kind)) byKind.set(o.kind, { ok: 0, fail: 0, ms: [] });
  const b = byKind.get(o.kind);
  if (o.ok) b.ok += 1;
  else b.fail += 1;
  b.ms.push(o.ms);
}

/*
 * ⭐ **The drift column is the one that finds the defect a percentile hides.**
 *
 * A p95 taken over a whole soak is an average of a beginning and an end, so an endpoint that doubles
 * in cost across the night shows up as a merely unremarkable number. Comparing the first quarter's
 * median against the last quarter's is what named DEFECT-5 in P-11: of every operation the soak ran,
 * exactly two grew — `behaviour-primitives` 330 → 608 ms and `behaviour-timeline` 323 → 589 ms —
 * while all six others stayed flat to within 2 ms. That contrast is the finding; neither number is
 * alarming alone, and the p95 column showed nothing.
 *
 * ⚠️ +50 % and at least 20 ms, and it **fails C7b** rather than merely printing. An operation that
 * costs more at the end of the night than the beginning is either a defect or a fact somebody should
 * have to write down; both deserve a human, and a criterion is how a report insists on one.
 *
 * ⛔ Quarter medians, not first-and-last samples — the same discipline the memory verdict uses, for
 * the same reason: a single slow call at either end must not become a trend.
 */
const quarterMedian = (ms, q) => {
  const s = [...ms].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map((o) => o.v);
  const part = s.slice(Math.floor((s.length * q) / 4), Math.floor((s.length * (q + 1)) / 4)).sort((a, b) => a - b);
  return part.length === 0 ? null : part[part.length >> 1];
};
const opSamples = new Map();
for (const o of ops) {
  if (o.ms === undefined) continue;
  if (!opSamples.has(o.kind)) opSamples.set(o.kind, []);
  opSamples.get(o.kind).push({ at: o.at, v: o.ms });
}
const drifting = [];

console.log('## Operations\n');
console.log('| Operation | OK | Failed | p50 ms | p95 ms | max ms | first ¼ med | last ¼ med | drift |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const [kind, b] of [...byKind].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))) {
  const samples = opSamples.get(kind) ?? [];
  const q0 = samples.length >= 8 ? quarterMedian(samples, 0) : null;
  const q3 = samples.length >= 8 ? quarterMedian(samples, 3) : null;
  const growth = q0 !== null && q0 > 0 && q3 !== null ? ((q3 - q0) / q0) * 100 : null;
  if (growth !== null && growth >= 50 && q3 - q0 >= 20) drifting.push(`\`${kind}\` ${q0} → ${q3} ms (+${n(growth, 0)} %)`);
  console.log(
    `| \`${kind}\` | ${b.ok} | ${b.fail} | ${pct(b.ms, 50)} | ${pct(b.ms, 95)} | ${Math.max(...b.ms)} | ${q0 ?? '—'} | ${q3 ?? '—'} | ${growth === null ? '—' : `${growth >= 0 ? '+' : ''}${n(growth, 0)} %`} |`,
  );
}
console.log(
  drifting.length === 0
    ? '\n⭐ **No operation grew materially over the run** — every median in the last quarter is within 50 % of the first.'
    : `\n⛔ **Operations whose cost grew over the run:** ${drifting.join(', ')}. An operation that degrades as data accumulates is a defect a percentile hides.`,
);
const totalOps = ops.filter((o) => o.ms !== undefined).length;
const totalFail = ops.filter((o) => o.ms !== undefined && !o.ok).length;
console.log(
  `\n**${totalOps} timed operations · ${totalFail} failed · ${n(((totalOps - totalFail) / Math.max(1, totalOps)) * 100, 2)} % success**\n`,
);

/* ── analyses ────────────────────────────────────────────────────────────────────────────── */
const counts = ops.filter((o) => o.kind === 'analysis-counts');
const byTag = new Map();
let frames = 0;
let dets = 0;
let dropped = 0;
for (const c of counts) {
  frames += c.counts?.framesAnalysed ?? 0;
  dets += c.counts?.detections ?? 0;
  dropped += c.counts?.framesDropped ?? 0;
  if (!byTag.has(c.tag)) byTag.set(c.tag, { runs: 0, frames: 0, dets: 0 });
  const t = byTag.get(c.tag);
  t.runs += 1;
  t.frames += c.counts?.framesAnalysed ?? 0;
  t.dets += c.counts?.detections ?? 0;
}
console.log('## Analyses by scene type\n');
console.log('| Scene | Runs | Frames analysed | Detections | Detections / frame |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const [tag, t] of [...byTag].sort((a, b) => b[1].runs - a[1].runs)) {
  console.log(`| ${tag} | ${t.runs} | ${t.frames} | ${t.dets} | ${n(t.dets / Math.max(1, t.frames), 2)} |`);
}
console.log(
  `\n**${counts.length} successful analyses · ${frames} frames analysed · ${dets} detections · ${dropped} frames dropped**\n`,
);

const rejected = ops.filter((o) => o.kind === 'expected-rejection');
console.log(`**Expected refusals honoured:** ${rejected.length}\n`);

/* ── resource series ─────────────────────────────────────────────────────────────────────── */
console.log('## Resource drift\n');
const first = metrics[0];
const last = metrics[metrics.length - 1];
if (first && last) {
  const names = [...new Set([...Object.keys(first.containers ?? {}), ...Object.keys(last.containers ?? {})])];
  console.log('| Container | Mem start | Mem end | Δ | Peak mem | Peak CPU % |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const name of names.sort()) {
    const series = metrics.map((m) => m.containers?.[name]).filter(Boolean);
    if (series.length === 0) continue;
    const mem = series.map((s) => s.memMb).filter(Number.isFinite);
    const cpu = series.map((s) => s.cpu).filter(Number.isFinite);
    const a = first.containers?.[name]?.memMb;
    const b = last.containers?.[name]?.memMb;
    const delta = typeof a === 'number' && typeof b === 'number' ? b - a : undefined;
    console.log(
      `| ${name} | ${n(a)} | ${n(b)} | ${delta === undefined ? '—' : `${delta >= 0 ? '+' : ''}${n(delta)}`} | ${n(Math.max(...mem))} | ${n(Math.max(...cpu))} |`,
    );
  }
}

const apis = metrics.map((m) => m.api?.ms).filter(Number.isFinite);
const fps = metrics.map((m) => m.runtime?.fps).filter(Number.isFinite);
const p95 = metrics.map((m) => m.runtime?.latencyP95Ms).filter(Number.isFinite);
const qd = metrics.map((m) => m.runtime?.queueDepth).filter(Number.isFinite);
const pending = metrics.map((m) => Math.max(0, ...(m.jetstream?.streams ?? []).map((s) => s.maxPending ?? 0)));

console.log('\n## Runtime and platform\n');
console.log('| Series | Min | p50 | p95 | Max |');
console.log('| --- | ---: | ---: | ---: | ---: |');
const row = (label, arr) =>
  arr.length && console.log(`| ${label} | ${n(Math.min(...arr))} | ${n(pct(arr, 50))} | ${n(pct(arr, 95))} | ${n(Math.max(...arr))} |`);
row('API latency (ms)', apis);
row('Runtime fps', fps);
row('Inference p95 latency (ms)', p95);
row('Runtime queue depth', qd);
row('JetStream max consumer pending', pending);

for (const name of ['media', 'gateway', 'events', 'workflow', 'inference']) {
  const s = metrics.map((m) => m.fds?.[name]).filter(Number.isFinite);
  row(`Open fds — ${name}`, s);
}

/* ── restarts ────────────────────────────────────────────────────────────────────────────── */
console.log('\n## Container restarts\n');
if (first && last) {
  const names = Object.keys(last.restarts ?? {}).sort();
  const moved = names.filter((k) => (last.restarts[k]?.restarts ?? 0) !== (first.restarts?.[k]?.restarts ?? 0));
  console.log(
    moved.length === 0
      ? `⭐ **No container restarted.** Counts identical at first and last sample across ${names.length} containers.`
      : `⛔ **${moved.length} container(s) restarted:** ${moved.map((k) => `${k} ${first.restarts?.[k]?.restarts} → ${last.restarts[k].restarts}`).join(', ')}`,
  );
  const unhealthy = names.filter((k) => last.restarts[k]?.health && last.restarts[k].health !== 'healthy');
  console.log(
    unhealthy.length === 0
      ? '\n⭐ **Every container reported `healthy` at the final sample.**'
      : `\n⛔ **Unhealthy at final sample:** ${unhealthy.join(', ')}`,
  );
}

/* ── disk ────────────────────────────────────────────────────────────────────────────────── */
const disks = metrics.map((m) => m.disk?.availGb).filter(Number.isFinite);
if (disks.length) {
  console.log(
    `\n## Disk\n\nStart **${disks[0]} GB** free → end **${disks[disks.length - 1]} GB** free (min ${Math.min(...disks)} GB). Δ **${n(disks[disks.length - 1] - disks[0])} GB**.`,
  );
}

/* ── findings ────────────────────────────────────────────────────────────────────────────── */
const findings = events.filter((e) => e.level === 'finding' || e.level === 'fatal');
console.log(`\n## Findings\n\n**${findings.length}**`);
for (const f of findings) console.log(`\n- \`${f.at}\` **${f.level}** — ${f.message}\n  \`\`\`json\n  ${JSON.stringify(f)}\n  \`\`\``);

/* ── duration ────────────────────────────────────────────────────────────────────────────── */
if (first && last) {
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3600000;
  console.log(`\n## Duration\n\n**${n(hours, 2)} hours** · ${metrics.length} metric samples · ${ops.filter((o) => o.kind === 'cycle-complete').length} cycles`);
}

/* ══ P-11 release-soak sections ═══════════════════════════════════════════════════════════════
 *
 * Everything above answers "did anything drift?". A release soak has to answer "may this ship?",
 * which needs three things the drift report does not produce: the *shape* of each series over the
 * whole run, the growth of everything that accumulates, and a verdict computed from stated criteria
 * rather than read off the tables by a human who already knows what they hope to conclude.
 */

const RUN_HOURS = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 3600000 : 0;
const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const series = (path) => metrics.map((m) => dig(m, path)).filter((v) => Number.isFinite(v));

/*
 * ⛔ **Warm-up is not trend, and a growth verdict that includes it is wrong.**
 *
 * A service climbs steeply for its first few minutes — caches, pools, lazily imported modules — and
 * then does whatever it is actually going to do. Both P-11 attempts began with a step of roughly the
 * same size, so their *endpoint deltas* were nearly identical (32.3 vs 33.0 MB/h) while their shapes
 * were opposites: R² 0.819 (a line) against R² 0.151 (a cloud). Judging the fix on the endpoints
 * said it had failed; judging it on the shape after warm-up said it had worked, and that was right.
 *
 * So every growth verdict below drops the first `WARMUP_MIN` minutes, and every slope is reported
 * with its R². ⚠️ A slope without an R² is not a finding — a large slope through a wide noise band
 * is oscillation.
 */
const WARMUP_MIN = 10;
const settled = (path) => metrics.filter((m) => (m.elapsedMin ?? 0) > WARMUP_MIN).map((m) => dig(m, path)).filter((v) => Number.isFinite(v));
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const BLOCKS = '▁▂▃▄▅▆▇█';
/** Fixed-width sparkline; bucket-mean downsampling so the shape survives a 400-sample run. */
const spark = (xs, width = 60) => {
  if (xs.length === 0) return '(no data)';
  const per = Math.max(1, Math.ceil(xs.length / width));
  const buckets = [];
  for (let i = 0; i < xs.length; i += per) buckets.push(mean(xs.slice(i, i + per)));
  const lo = Math.min(...buckets);
  const hi = Math.max(...buckets);
  if (hi - lo < 1e-9) return `${BLOCKS[0].repeat(buckets.length)} (flat)`;
  return buckets.map((v) => BLOCKS[Math.min(7, Math.floor(((v - lo) / (hi - lo)) * 7.999))]).join('');
};

/*
 * ⭐ **The leak test that matters is plateau-versus-slope, not "did it grow".**
 *
 * A cache filling to its working set grows and then stops. A leak keeps taking the same bite. So
 * compare the rise across the second half against the rise across the first: still climbing as fast
 * at the end as at the start is unbounded; a flattening rise is a plateau, however large the number
 * it plateaued at. Absolute size is not the test — a 500 MB object store that stopped growing is
 * healthier than a 60 MB service that has not.
 */
const growth = (xs) => {
  if (xs.length < 10) return { verdict: 'inconclusive', reason: 'fewer than 10 samples' };
  const fifth = Math.max(1, Math.floor(xs.length / 5));
  const q1 = mean(xs.slice(0, fifth));
  const q3 = mean(xs.slice(Math.floor(xs.length * 0.4), Math.floor(xs.length * 0.6)));
  const q5 = mean(xs.slice(-fifth));
  const early = q3 - q1;
  const late = q5 - q3;
  const noise = Math.abs(q5 - q1) < Math.abs(q1) * 0.05;
  let verdict;
  if (noise || late <= 0) verdict = 'stable';
  else if (early <= 0) verdict = 'late-rise';
  else if (late > early * 0.75) verdict = 'unbounded';
  else verdict = 'plateau';
  return { q1: n(q1, 2), q3: n(q3, 2), q5: n(q5, 2), totalPct: q1 === 0 ? null : n(((q5 - q1) / q1) * 100, 1), earlyRise: n(early, 2), lateRise: n(late, 2), verdict };
};

/*
 * ⚠️ A monotonic counter that steps backwards means the process behind it restarted — which Docker's
 * own restart count does not show when a process is replaced inside a living container. So the
 * reset count is reported next to every delta rather than assumed to be zero.
 */
const counter = (path) => {
  const xs = series(path);
  if (xs.length === 0) return null;
  let resets = 0;
  for (let i = 1; i < xs.length; i += 1) if (xs[i] < xs[i - 1]) resets += 1;
  return { first: xs[0], last: xs[xs.length - 1], delta: xs[xs.length - 1] - xs[0], perHour: RUN_HOURS > 0 ? n((xs[xs.length - 1] - xs[0]) / RUN_HOURS, 1) : null, resets };
};

const stat = (path, digits = 2) => {
  const xs = series(path);
  if (xs.length === 0) return null;
  return { min: n(Math.min(...xs), digits), med: n(pct(xs, 50), digits), max: n(Math.max(...xs), digits), last: n(xs[xs.length - 1], digits), growth: growth(xs), spark: spark(xs) };
};

/*
 * ⚠️ `trend` is only meaningful for a series that *accumulates*. On a bursty gauge like CPU or FPS
 * the plateau-versus-slope test answers a question nobody asked: one 800 % CPU spike while ffmpeg
 * decodes would render as "unbounded", which in a release document reads as a leak. Those rows
 * print `—` rather than a confident verdict about the wrong thing.
 */
const SHAPE_HEAD = '| Series | Min | p50 | Max | Final | Trend | Shape (start → end) |\n| --- | ---: | ---: | ---: | ---: | --- | --- |';
const shape = (label, s, unit = '', trend = true) =>
  console.log(
    s === null
      ? `| ${label} | — | — | — | — | — | (not measured) |`
      : `| ${label} | ${s.min}${unit} | ${s.med}${unit} | ${s.max}${unit} | ${s.last}${unit} | ${trend ? s.growth.verdict : '—'} | \`${s.spark}\` |`,
  );

console.log('\n## Shape of the run\n');
console.log('FPS and CPU follow whichever fixture is being analysed, so no trend verdict is offered for them.\n');
console.log(SHAPE_HEAD);
shape('Runtime fps', stat('runtime.fps'), '', false);
shape('Inference latency avg', stat('runtime.avgLatencyMs'), ' ms');
shape('Inference latency p95', stat('runtime.latencyP95Ms'), ' ms');
shape('Inference queue depth', stat('runtime.queueDepth'));
shape('Media deliver avg', stat('media.deliverMsAvg'), ' ms');
shape('Media frame age avg', stat('media.frameAgeMsAvg'), ' ms');
shape('Media queue depth', stat('media.queueDepth'));
shape('Media inflight', stat('media.inflight'));
shape('Gateway API round-trip', stat('api.ms'), ' ms');
shape('Identity fragmentation', stat('behaviour.fragmentation'));

const containerNames = Object.keys(last?.containers ?? {});
console.log('\n### Memory — plateau versus slope\n');
console.log(SHAPE_HEAD);
for (const name of containerNames) shape(name, stat(`containers.${name}.memMb`), ' MB');
shape('inference self-reported', stat('runtime.memoryMb'), ' MB');
const memGrowth = Object.fromEntries(containerNames.map((name) => [name, growth(settled(`containers.${name}.memMb`))]));

/*
 * ⛔ **A flagged container is a question, not a verdict.** `unbounded` means "climbing as fast at the
 * end as at the start", which is what a leak looks like — and also what a store legitimately filling
 * toward a cap looks like when the run is shorter than its retention period. This section names the
 * containers and supplies the slope; choosing between the two answers requires the mechanism, and
 * that is investigation, not arithmetic.
 *
 * ⚠️ An earlier revision tried to settle it automatically by dividing memory growth by the retained
 * record count. That number is unusable: `historyRecords` is a live gauge whose records retire, so
 * the denominator is small and noisy and the same run yielded 66 and 128 KB/record depending on where
 * the window fell. It was removed rather than tuned — a criterion nobody can trust is worse than a
 * blunt one that flags honestly and sends a human to look.
 */

/** Least-squares fit over the whole run. A high R² with a positive slope is linear growth. */
const trendLine = (xs) => {
  if (xs.length < 10) return null;
  const meanX = (xs.length - 1) / 2;
  const meanY = mean(xs);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (i - meanX) * (xs[i] - meanY);
    sxx += (i - meanX) ** 2;
    syy += (xs[i] - meanY) ** 2;
  }
  const perSample = sxx === 0 ? 0 : sxy / sxx;
  return { perHour: RUN_HOURS > 0 ? n(perSample * (xs.length / RUN_HOURS), 2) : null, r2: syy === 0 ? 0 : n((sxy * sxy) / (sxx * syy), 3) };
};

const memTrend = Object.fromEntries(containerNames.map((name) => [name, trendLine(settled(`containers.${name}.memMb`))]));

/*
 * ⭐ Two independent tests, and a container is only called climbing when **both** agree: the
 * quintile plateau test says the late rise has not flattened, *and* the least-squares fit explains
 * enough of the variance to be a line rather than a band (R² ≥ 0.5). Either alone misfires — the
 * quintile test on an oscillation, the slope on a wide noise band.
 */
const LINEAR_R2 = 0.5;
const leaking = Object.entries(memGrowth)
  .filter(([k, g]) => g.verdict === 'unbounded' && (memTrend[k]?.r2 ?? 0) >= LINEAR_R2)
  .map(([k, g]) => `**${k}** (+${g.totalPct} %, late rise ${g.lateRise} MB vs early ${g.earlyRise} MB, slope ${memTrend[k]?.perHour} MB/h at R²=${memTrend[k]?.r2})`);
const oscillating = Object.entries(memGrowth)
  .filter(([k, g]) => g.verdict === 'unbounded' && (memTrend[k]?.r2 ?? 0) < LINEAR_R2)
  .map(([k, g]) => `**${k}** (+${g.totalPct} %, but R²=${memTrend[k]?.r2} — a band, not a line)`);
console.log(
  leaking.length === 0
    ? `\n⭐ **No container shows linear growth after warm-up** (first ${String(WARMUP_MIN)} min excluded).`
    : `\n⛔ **Climbing linearly after warm-up — each needs a mechanism before it is called a leak or a fill:** ${leaking.join(', ')}`,
);
if (oscillating.length > 0) {
  console.log(`\n⚠️ Rose over the run but without a linear shape, so reported rather than flagged: ${oscillating.join(', ')}`);
}

/*
 * Evidence for whoever investigates the inference runtime: its resident size beside the number of
 * durable track-history records it holds. Those records live under three declared bounds
 * (`ai/inference/track_history.py`): 72 h retention, 4096 records per tenant, 512 points per record.
 * A run shorter than the retention period cannot reach steady state — nothing ages out and the count
 * cap is the only bound in reach — so this table is *expected* to rise. That expectation is not a
 * defence; it is the thing to check against.
 */
const infRows = metrics
  .map((m) => ({ min: m.elapsedMin, rss: m.containers?.inference?.memMb, self: m.runtime?.memoryMb, onDisk: m.behaviour?.historyRecords, liveIds: m.behaviour?.historyLiveIdentities, liveStreams: m.behaviour?.historyLiveStreams, pending: m.behaviour?.historyPendingWrites, retired: m.behaviour?.historyRetired }))
  .filter((r) => Number.isFinite(r.rss) && Number.isFinite(r.onDisk));
if (infRows.length >= 10) {
  console.log('\n### Inference memory beside the structures it holds\n');
  const line = (r) => console.log(`| ${r.min} | ${r.rss} | ${n(r.self)} | ${r.onDisk} | ${r.liveIds ?? '—'} | ${r.liveStreams ?? '—'} | ${r.pending ?? '—'} | ${r.retired} |`);
  console.log('| Elapsed min | Container RSS MB | Runtime self-reported MB | Records on disk | Live identities | Live streams | Pending writes | Retired |');
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const step = Math.max(1, Math.floor(infRows.length / 12));
  for (let i = 0; i < infRows.length; i += step) line(infRows[i]);
  line(infRows[infRows.length - 1]);
  console.log(
    '\nBounds in force: **72 h retention · 4096 records per tenant · 512 points per record**. ' +
      '"Records on disk" is the durable store; the three live columns are the in-memory structures, ' +
      'published only from attempt 2 onward — attempt 1 could not attribute its own memory growth ' +
      'because they did not exist as metrics.\n',
  );
}

console.log('\n### CPU\n');
console.log(SHAPE_HEAD);
for (const name of containerNames) shape(name, stat(`containers.${name}.cpu`), ' %', false);

/* ── storage and log growth ──────────────────────────────────────────────────────────────── */
console.log('\n## Storage and log growth\n');
const stores = { 'mongodb /data (KB)': 'storage.mongo', 'redis /data (KB)': 'storage.redis', 'minio /data (KB)': 'storage.minio', 'JetStream messages': 'jetstream.messages', 'JetStream bytes': 'jetstream.bytes' };
console.log('| Store | Start | End | Δ | Per hour | Counter resets |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
const storageGrowth = {};
for (const [label, path] of Object.entries(stores)) {
  const c = counter(path);
  storageGrowth[path] = c;
  if (c) console.log(`| ${label} | ${c.first} | ${c.last} | ${c.delta >= 0 ? '+' : ''}${c.delta} | ${c.perHour} | ${c.resets} |`);
}
console.log('\n| Container log | Start B | End B | Δ B | B / hour |');
console.log('| --- | ---: | ---: | ---: | ---: |');
const logGrowth = {};
for (const name of Object.keys(last?.logBytes ?? {})) {
  const c = counter(`logBytes.${name}`);
  logGrowth[name] = c;
  if (c) console.log(`| ${name} | ${c.first} | ${c.last} | ${c.delta >= 0 ? '+' : ''}${c.delta} | ${c.perHour} |`);
}

/* ── evidence and incidents ──────────────────────────────────────────────────────────────── */
const evidence = ops
  .filter((o) => o.kind === 'invariant-counts')
  .reduce((a, o) => ({ analyses: a.analyses + 1, events: a.events + (o.events ?? 0), incidents: a.incidents + (o.incidents ?? 0), problems: a.problems + (o.problems ?? 0) }), { analyses: 0, events: 0, incidents: 0, problems: 0 });
const live = ops
  .filter((o) => o.kind === 'live-counts')
  .reduce((a, o) => ({ bursts: a.bursts + 1, accepted: a.accepted + (o.accepted ?? 0), refused: a.refused + (o.refused ?? 0) }), { bursts: 0, accepted: 0, refused: 0 });
const orphanSamples = metrics.filter((m) => (m.orphans?.stuck?.length ?? 0) > 0).length;

console.log('\n## Evidence and incidents\n');
console.log('| | |');
console.log('| --- | ---: |');
console.log(`| Analyses cross-checked | ${evidence.analyses} |`);
console.log(`| Events produced | ${evidence.events} |`);
console.log(`| Incidents produced | ${evidence.incidents} |`);
console.log(`| **Invariant problems** | **${evidence.problems}** |`);
console.log(`| Samples with orphan sessions | ${orphanSamples} |`);
console.log(
  `\nInvariants re-checked on every analysis: no duplicate incident, no event present in the analysis ` +
    `but missing from the events store, no timeline corruption, identity continuity across the run.\n`,
);
console.log(`**Live ingest:** ${live.bursts} burst(s) · ${live.accepted} frames accepted · ${live.refused} refused — through the same runtime as the recorded path.\n`);

/* ── behaviour, track history, scene observation ─────────────────────────────────────────── */
const counters = {
  'runtime frames processed': 'runtime.framesProcessed',
  'runtime frames dropped': 'runtime.droppedFrames',
  'media frames offered': 'media.framesOffered',
  'media frames delivered': 'media.framesDelivered',
  'media frames dropped': 'media.framesDropped',
  'media frames failed': 'media.framesFailed',
  'zone echoes sent': 'media.zoneEchoesSent',
  'zone echoes dropped': 'media.zoneEchoesDropped',
  'zone annotations applied': 'behaviour.zoneApplied',
  'zone annotations missed': 'behaviour.zoneMissed',
  'scene observations': 'behaviour.sceneObservations',
  'scene observations dropped': 'behaviour.sceneDropped',
  'behaviour streams tracked': 'behaviour.streamsTracked',
  'behaviour streams evicted': 'behaviour.streamsEvicted',
  'behaviour module failures': 'behaviour.moduleFailures',
  'history points': 'behaviour.historyPoints',
  'history live identities': 'behaviour.historyLiveIdentities',
  'history live streams': 'behaviour.historyLiveStreams',
  'history pending writes': 'behaviour.historyPendingWrites',
  'history write failures': 'behaviour.historyWriteFailures',
  'history undated dropped': 'behaviour.historyUndatedDropped',
  'tracks created': 'behaviour.tracksCreated',
  'occlusions': 'behaviour.occlusions',
  'frames out of order': 'behaviour.outOfOrder',
};
const c = Object.fromEntries(Object.entries(counters).map(([label, path]) => [path, counter(path)]));
console.log('\n## Behaviour, track history and scene observation\n');
console.log('| Counter | Start | End | Δ | Per hour | Resets |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [label, path] of Object.entries(counters)) {
  const v = c[path];
  if (v) console.log(`| ${label} | ${v.first} | ${v.last} | ${v.delta >= 0 ? '+' : ''}${v.delta} | ${v.perHour} | ${v.resets} |`);
}
const applied = c['behaviour.zoneApplied']?.delta ?? 0;
const missed = c['behaviour.zoneMissed']?.delta ?? 0;
if (applied + missed > 0) {
  console.log(
    `\n**Zone-echo miss rate ${n((missed / (applied + missed)) * 100, 2)} %** (${missed} of ${applied + missed}). ` +
      `ADR-0053 accepts a bounded tail: the echo describes the *previous* frame, so the final frames of a ` +
      `stream are never answered. What matters is that the tail is counted and published rather than ` +
      `silently absorbed — an unanswered frame must not read as "in no zone".\n`,
  );
}

/* ── post-soak verification ──────────────────────────────────────────────────────────────── */
/*
 * ⛔ A missing input is reported as NOT RUN and fails its criterion. It is never skipped: an unrun
 * check and a passing check must not render the same way, which is the failure mode this project
 * keeps finding — a green that proved nothing.
 */
const postStep = (name) => {
  const p = join(OUT, 'post', name);
  if (!existsSync(p)) return { status: 'NOT RUN', detail: `${p} absent` };
  const text = readFileSync(p, 'utf8').trim();
  return { status: /^PASS\b/m.test(text) ? 'PASS' : 'FAIL', detail: text };
};
const postSoak = { browser: postStep('browser.txt'), deployment: postStep('deployment.txt'), repoGate: postStep('repo-gate.txt'), moduleTests: postStep('module-tests.txt'), contracts: postStep('contracts.txt') };
console.log('\n## Post-soak verification\n');
for (const [key, label] of [['deployment', 'Deployment verification'], ['browser', 'Browser certification'], ['repoGate', 'Repository gate'], ['moduleTests', 'Behaviour / track-history / scene module tests'], ['contracts', 'Contract and perception-boundary checks']]) {
  const r = postSoak[key];
  console.log(`### ${label} — **${r.status}**\n`);
  console.log('```');
  console.log((r.detail ?? '').slice(0, 4000));
  console.log('```\n');
}

/* ── acceptance criteria ─────────────────────────────────────────────────────────────────── */
const summary = existsSync(join(OUT, 'SUMMARY.json')) ? JSON.parse(readFileSync(join(OUT, 'SUMMARY.json'), 'utf8')) : null;
const awakeHours = summary?.awakeHours ?? null;
const restartsMoved = first && last ? Object.keys(last.restarts ?? {}).filter((k) => (last.restarts[k]?.restarts ?? 0) !== (first.restarts?.[k]?.restarts ?? 0)) : [];
const unhealthyEnd = Object.entries(last?.restarts ?? {}).filter(([, v]) => v.health && v.health !== 'healthy' && v.health !== 'none').map(([k]) => k);
const failedOps = ops.filter((o) => o.ms !== undefined && !o.ok).length;

const criteria = [
  { id: 'C1', name: 'Ran 6–7 h uninterrupted', met: summary?.continuity?.intact === true && typeof awakeHours === 'number' && awakeHours >= 6, detail: summary === null ? 'SUMMARY.json absent — the run never reached its own completion path' : `continuity intact=${summary.continuity?.intact}, awake ${awakeHours} h of ${summary.requestedHours} h requested` },
  { id: 'C2', name: 'No service restarted', met: restartsMoved.length === 0 && unhealthyEnd.length === 0, detail: restartsMoved.length === 0 ? `no restart counter moved; ${Object.keys(last?.restarts ?? {}).length} containers healthy at the final sample` : `moved: ${restartsMoved.join(', ')}; unhealthy: ${unhealthyEnd.join(', ') || 'none'}` },
  {
    id: 'C3',
    name: 'No linear memory growth after warm-up',
    met: leaking.length === 0,
    detail:
      leaking.length === 0
        ? `no container grows linearly after the first ${WARMUP_MIN} min${oscillating.length > 0 ? `; ${oscillating.length} rose without a linear shape (reported in §Memory)` : ''}`
        : `needs a mechanism: ${leaking.join(', ').replace(/\*\*/g, '')}`,
  },
  { id: 'C4', name: 'No queue growth or backpressure', met: (stat('runtime.queueDepth')?.max ?? 0) === 0 && (stat('media.queueDepth')?.max ?? 0) === 0, detail: `runtime queue max ${stat('runtime.queueDepth')?.max}, media queue max ${stat('media.queueDepth')?.max}` },
  { id: 'C5', name: 'No frame or evidence loss', met: (c['runtime.droppedFrames']?.last ?? 0) === 0 && (c['media.framesDropped']?.last ?? 0) === 0 && (c['media.framesFailed']?.last ?? 0) === 0 && (c['behaviour.historyWriteFailures']?.last ?? 0) === 0 && dropped === 0 && (c['media.framesOffered']?.delta ?? 0) === (c['media.framesDelivered']?.delta ?? -1), detail: `runtime dropped ${c['runtime.droppedFrames']?.last}, media dropped ${c['media.framesDropped']?.last} / failed ${c['media.framesFailed']?.last}, offered−delivered ${(c['media.framesOffered']?.delta ?? 0) - (c['media.framesDelivered']?.delta ?? 0)}, analysis frames dropped ${dropped}, history write failures ${c['behaviour.historyWriteFailures']?.last}` },
  { id: 'C6', name: 'No invariant violation or orphaned work', met: evidence.problems === 0 && orphanSamples === 0 && (c['behaviour.outOfOrder']?.last ?? 0) === 0, detail: `${evidence.problems} invariant problems across ${evidence.analyses} analyses, ${orphanSamples} samples with orphan sessions, ${c['behaviour.outOfOrder']?.last} out-of-order frames` },
  { id: 'C7b', name: 'No operation degrades as data accumulates', met: drifting.length === 0, detail: drifting.length === 0 ? 'every operation\'s last-quarter median is within 50 % of its first' : drifting.join(', ').replace(/`/g, '') },
  { id: 'C7', name: 'Every operation succeeded, no findings', met: failedOps === 0 && findings.length === 0, detail: `${totalOps} timed operations, ${failedOps} failed; ${findings.length} finding(s)` },
  { id: 'C8', name: 'Behaviour / history / scene exercised and clean', met: applied > 0 && (c['behaviour.sceneObservations']?.delta ?? 0) > 0 && (c['behaviour.historyPoints']?.delta ?? 0) > 0 && (c['behaviour.moduleFailures']?.last ?? 1) === 0 && (c['behaviour.sceneDropped']?.last ?? 1) === 0 && (c['behaviour.historyUndatedDropped']?.last ?? 1) === 0, detail: `zone annotations +${applied}, scene observations +${c['behaviour.sceneObservations']?.delta}, history points +${c['behaviour.historyPoints']?.delta}, module failures ${c['behaviour.moduleFailures']?.last}, scene dropped ${c['behaviour.sceneDropped']?.last}, undated history dropped ${c['behaviour.historyUndatedDropped']?.last}` },
  { id: 'C9', name: 'Deployment verification', met: postSoak.deployment.status === 'PASS', detail: postSoak.deployment.status },
  { id: 'C10', name: 'Browser certification', met: postSoak.browser.status === 'PASS', detail: postSoak.browser.status },
  { id: 'C11', name: 'Repository gate', met: postSoak.repoGate.status === 'PASS', detail: postSoak.repoGate.status },
  { id: 'C12', name: 'Module tests (behaviour, history, scene)', met: postSoak.moduleTests.status === 'PASS', detail: postSoak.moduleTests.status },
  { id: 'C13', name: 'Contract and perception-boundary checks', met: postSoak.contracts.status === 'PASS', detail: postSoak.contracts.status },
];
const notMet = criteria.filter((x) => !x.met);
const decision = notMet.length === 0 ? 'GO' : 'NO-GO';

console.log('\n## Acceptance criteria\n');
console.log('| | Criterion | Met | Evidence |');
console.log('| --- | --- | :-: | --- |');
for (const x of criteria) console.log(`| ${x.id} | ${x.name} | ${x.met ? '⭐' : '⛔'} | ${String(x.detail).replace(/\|/g, '\\|')} |`);
console.log(`\n## Decision\n\n# ${decision}\n`);
if (notMet.length > 0) console.log(`Not met: ${notMet.map((x) => `**${x.id}** ${x.name}`).join(' · ')}\n`);

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx >= 0 && process.argv[jsonIdx + 1]) {
  writeFileSync(
    process.argv[jsonIdx + 1],
    `${JSON.stringify(
      {
        decision,
        generatedAt: new Date().toISOString(),
        run: { started: summary?.started ?? first?.at ?? null, ended: summary?.ended ?? last?.at ?? null, requestedHours: summary?.requestedHours ?? null, awakeHours, continuity, samples: metrics.length, cycles: summary?.cycles ?? null, analyses: summary?.analyses ?? null, hours: n(RUN_HOURS, 2) },
        criteria,
        operations: Object.fromEntries([...byKind].map(([k, b]) => [k, { ok: b.ok, failed: b.fail, p50: pct(b.ms, 50), p95: pct(b.ms, 95), max: Math.max(...b.ms) }])),
        analyses: { runs: counts.length, framesAnalysed: frames, detections: dets, framesDropped: dropped, byTag: Object.fromEntries(byTag) },
        live,
        evidence,
        counters: c,
        storage: storageGrowth,
        logs: logGrowth,
        memory: { warmupMinExcluded: WARMUP_MIN, perContainer: memGrowth, slopes: memTrend, climbingLinearly: leaking, roseWithoutLinearShape: oscillating, inferenceVersusStore: infRows },
        restarts: { moved: restartsMoved, unhealthyAtEnd: unhealthyEnd, lifetime: last?.restarts ?? {} },
        series: { fps: stat('runtime.fps'), latencyAvgMs: stat('runtime.avgLatencyMs'), latencyP95Ms: stat('runtime.latencyP95Ms'), runtimeQueueDepth: stat('runtime.queueDepth'), mediaQueueDepth: stat('media.queueDepth'), mediaDeliverMs: stat('media.deliverMsAvg'), frameAgeMs: stat('media.frameAgeMsAvg'), apiMs: stat('api.ms'), fragmentation: stat('behaviour.fragmentation') },
        findings,
        postSoak,
      },
      null,
      2,
    )}\n`,
  );
}
