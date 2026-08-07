/**
 * Turn a soak's three JSONL streams into the tables the report quotes.
 *
 *   node tools/validation/soak-report.mjs .soak
 *
 * ⛔ **Nothing here is retyped by hand.** A number copied into Markdown is a number nobody can
 * re-measure; every table below is generated from the run's own append-only streams, so a reader
 * can regenerate it and get the same answer or find out that they cannot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

console.log('## Operations\n');
console.log('| Operation | OK | Failed | p50 ms | p95 ms | max ms |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [kind, b] of [...byKind].sort((a, b) => b[1].ok + b[1].fail - (a[1].ok + a[1].fail))) {
  console.log(
    `| \`${kind}\` | ${b.ok} | ${b.fail} | ${pct(b.ms, 50)} | ${pct(b.ms, 95)} | ${Math.max(...b.ms)} |`,
  );
}
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
