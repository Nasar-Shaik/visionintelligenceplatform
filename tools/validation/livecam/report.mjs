/**
 * Turn the live-capture run artefacts into the markdown tables the validation documents carry.
 *
 * ⭐ **Generated rather than transcribed, deliberately.** Twenty-seven rows of six numbers copied by
 * hand into a document is a transcription error waiting to happen, and a transcription error in a
 * validation report is indistinguishable from a product defect to everyone who reads it afterwards.
 *
 *   node report.mjs --matrix <matrix.json> [--latency f] [--pressure f] [--fps f] [--soak f] [--parity f]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyseContinuity, describeContinuity, sliceUninterrupted } from '../lib/continuity.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const read = (p) => (p !== '' && existsSync(resolve(p)) ? JSON.parse(readFileSync(resolve(p), 'utf8')) : null);

const matrix = read(flag('matrix', ''));
const latency = read(flag('latency', ''));
const pressure = read(flag('pressure', ''));
const fps = read(flag('fps', ''));
const soak = read(flag('soak', ''));
const parity = read(flag('parity', ''));

const n = (v, digits = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

/* ── the scenario matrix ───────────────────────────────────────────────────────────────────────── */

if (matrix !== null) {
  const rows = matrix.results ?? matrix;
  console.log(`### Scenario matrix — ${String(matrix.seconds ?? '?')} s at ${String(matrix.fps ?? '?')} fps, ${String(rows.length)} scenarios\n`);
  console.log(
    '| Scenario | Group | Detections | Frames with a detection | Frames with none | Detections/frame | Tracks created | Active at end | Events | Incidents | Ground truth | Looped |',
  );
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |');
  for (const r of rows) {
    if (r.status === 'manual') {
      console.log(
        `| ${r.id} | device | — | — | — | — | — | — | — | — | — | **NOT EXECUTED** |`,
      );
      continue;
    }
    if (r.status !== 'ran') {
      console.log(`| ${r.id} | — | — | — | — | — | — | — | — | — | — | ${r.status} |`);
      continue;
    }
    /*
     * ⛔ A row whose instrument did not read is marked, never dashed into the table beside real
     * measurements. Dashes read as "nothing happened"; this row means "we do not know", and the two
     * must not look alike in a document somebody will quote.
     */
    if (r.detection === null || r.detection === undefined) {
      console.log(
        `| ${r.id} | ${r.group ?? '—'} | ⛔ **INSTRUMENT DID NOT READ — row invalid, re-run required** | | | | | | | | ${r.expectedPeople === null ? '—' : String(r.expectedPeople)} | |`,
      );
      continue;
    }
    const d = r.detection;
    const perFrame =
      typeof d.detectionsPublished === 'number' && typeof d.resultsPublished === 'number' && d.resultsPublished > 0
        ? d.detectionsPublished / d.resultsPublished
        : null;
    console.log(
      `| ${r.id} | ${r.group} | ${String(d.detectionsPublished ?? '—')} | ${String(d.resultsPublished ?? '—')} | ` +
        `${String(d.suppressedNoDetections ?? '—')} | ${n(perFrame, 2)} | ${String(r.tracking?.createdTracks ?? '—')} | ` +
        `${String(r.tracking?.activeTracksAtEnd ?? '—')} | ${String(r.events?.count ?? '—')} | ` +
        `${String(r.incidents?.count ?? '—')} | ${r.expectedPeople === null ? '—' : String(r.expectedPeople)} | ` +
        `${r.looped === true ? '⚠️ yes' : 'no'} |`,
    );
  }
  /* ⚠️ Loss counters, reported separately and always — a matrix that only shows what was found
   * cannot distinguish "the scene was empty" from "the frames were dropped". */
  const lost = rows
    .filter((r) => r.status === 'ran')
    .reduce(
      (a, r) => ({
        queueFull: a.queueFull + (r.detection?.droppedQueueFull ?? 0),
        outOfOrder: a.outOfOrder + (r.detection?.droppedOutOfOrder ?? 0),
        failed: a.failed + (r.detection?.failed ?? 0),
      }),
      { queueFull: 0, outOfOrder: 0, failed: 0 },
    );
  console.log(
    `\n**Loss across the whole matrix:** dropped (queue full) **${String(lost.queueFull)}** · ` +
      `dropped (out of order) **${String(lost.outOfOrder)}** · publish failures **${String(lost.failed)}**\n`,
  );
}

/* ── stage latency ─────────────────────────────────────────────────────────────────────────────── */

if (latency !== null) {
  console.log(`### Stage-by-stage latency — ${String(latency.window?.seconds ?? '?')} s at ${String(latency.window?.fps ?? '?')} fps\n`);
  console.log('| Stage | Kind | Measured by | n | min ms | avg ms | p95 ms | max ms |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const s of latency.stages ?? []) {
    const m = s.ms;
    if (m === null || m === undefined) {
      console.log(`| ${s.stage} | ${s.kind} | ${s.where} | — | — | — | — | — |`);
      continue;
    }
    console.log(
      `| ${s.stage} | ${s.kind} | ${s.where} | ${String(m.count ?? '—')} | ${n(m.min, 1)} | ${n(m.avg, 1)} | ${n(m.p95, 1)} | ${n(m.max, 1)} |`,
    );
  }
  console.log(`\n**Clock:** ${latency.clock ?? 'not measured'}\n`);
}

/* ── back-pressure ─────────────────────────────────────────────────────────────────────────────── */

if (pressure !== null) {
  console.log('### Back-pressure — baseline → overload → recovery\n');
  console.log(
    '| Phase | Target fps | In flight | Sent | Achieved fps | Rejected | Upload p95 ms | Queue max | Drops in phase | Pipeline latency avg ms |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const p of pressure.phases ?? []) {
    const queueMax = Math.max(0, ...p.samples.map((s) => s.queueDepth ?? 0));
    const drops =
      (p.samples.at(-1)?.droppedQueueFull ?? 0) - (p.samples[0]?.droppedQueueFull ?? 0);
    const lat = p.samples.map((s) => s.processingLatencyMs).filter((v) => typeof v === 'number');
    const latAvg = lat.length === 0 ? null : lat.reduce((a, b) => a + b, 0) / lat.length;
    console.log(
      `| ${p.label} | ${String(p.targetFps)} | ${String(p.maxInflight)} | ${String(p.sent)} | ${String(p.achievedFps)} | ` +
        `${String(p.rejected)} | ${String(p.uploadMs?.p95 ?? '—')} | ${String(queueMax)} | ${String(drops)} | ${n(latAvg, 1)} |`,
    );
  }
  const cpu = pressure.resourceSummary?.cpuPercent ?? {};
  console.log('\n| Service | CPU min % | CPU avg % | CPU p95 % | CPU max % |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const [svc, s] of Object.entries(cpu)) {
    if (s === null) continue;
    console.log(`| ${svc} | ${n(s.min, 1)} | ${n(s.avg, 1)} | ${n(s.p95, 1)} | ${n(s.max, 1)} |`);
  }
  console.log('');
}

/* ── frame-rate benchmark ──────────────────────────────────────────────────────────────────────── */

if (fps !== null) {
  console.log('### Frame-rate benchmark\n');
  console.log(
    '| Target fps | Sent | Achieved fps | Upload p95 ms | Frames tracked | Tracks created | Tracking ms avg | inference CPU avg % | media CPU avg % | inference RSS MiB avg |',
  );
  console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of fps.perRate ?? []) {
    console.log(
      `| ${String(r.targetFps)} | ${String(r.sent)} | ${String(r.achievedFps)} | ${String(r.uploadMs?.p95 ?? '—')} | ` +
        `${String(r.tracking?.framesTracked ?? '—')} | ${String(r.tracking?.createdTracks ?? '—')} | ` +
        `${n(r.tracking?.averageTrackingMs, 3)} | ${n(r.cpuPercent?.inference?.avg, 1)} | ` +
        `${n(r.cpuPercent?.media?.avg, 1)} | ${n(r.memMiB?.inference?.avg, 0)} |`,
    );
  }
  console.log('');
}

/* ── soak ──────────────────────────────────────────────────────────────────────────────────────── */

if (soak !== null) {
  /*
   * ⛔ **Derived here, not trusted from the file.** A soak artefact records what the harness knew at
   * the time it was written, and the harness that wrote the 2026-08-08 run did not yet know that a
   * suspended host inflates wall-clock elapsed. Recomputing from the raw series means an artefact
   * never has to be edited to be read correctly — the evidence stays as recorded, and the
   * interpretation improves with the tool.
   */
  const rawSeries = soak.series ?? [];
  const rawResources = soak.resources ?? [];
  const continuity = analyseContinuity({ samples: rawSeries, intervalMs: 5_000 });
  const series = sliceUninterrupted({ samples: rawSeries, intervalMs: 5_000 });
  const resources = sliceUninterrupted({ samples: rawResources, intervalMs: 10_000 });

  const awake = continuity.inconclusive ? null : continuity.uninterrupted.seconds;
  const sent = soak.phase?.sent ?? null;
  const trueFps = awake !== null && awake > 0 && typeof sent === 'number' ? sent / awake : null;

  console.log(`### Long-running soak — ${n(awake ?? soak.phase?.seconds, 0)} s of continuous ingest\n`);
  console.log(
    `Sent **${String(sent ?? '—')}** frames at **${n(trueFps, 3)}** fps ` +
      `(target ${String(soak.phase?.targetFps ?? '—')}) · rejected **${String(soak.phase?.rejected ?? '—')}** · ` +
      `queue max **${String(Math.max(0, ...series.map((s) => s.queueDepth ?? 0)))}**\n`,
  );

  /*
   * ⚠️ The suspension notice is printed *above* the tables rather than as a footnote. A reader who
   * quotes one number from this section must not be able to do so without having read this first.
   */
  if (!continuity.intact) {
    console.log(`> ⚠️ **Host continuity.** ${describeContinuity(continuity)}\n`);
    console.log(
      `> The tables below are computed over the **${n(awake, 0)} s the process was demonstrably ` +
        `running** (${String(continuity.uninterrupted.count)} of ${String(continuity.sampleCount)} samples). ` +
        `The wall-clock figures this run recorded — ${n(soak.phase?.seconds, 1)} s and ` +
        `${n(soak.phase?.achievedFps, 2)} fps — describe a clock, not a deployment.\n`,
    );
  }

  const slice = (arr, from, to) => arr.slice(Math.floor(arr.length * from), Math.floor(arr.length * to));
  const avg = (arr) => (arr.length === 0 ? null : arr.reduce((x, y) => x + y, 0) / arr.length);

  console.log('| Service | Memory first tenth MiB | Memory last tenth MiB | Drift |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const svc of ['media', 'inference', 'events', 'rules']) {
    const mem = resources.map((r) => r[svc]?.memMiB).filter((v) => typeof v === 'number');
    const first = avg(slice(mem, 0, 0.1));
    const last = avg(slice(mem, 0.9, 1));
    const pctChange = first !== null && last !== null && first > 0 ? ((last - first) / first) * 100 : null;
    console.log(
      `| ${svc} | ${n(first, 1)} | ${n(last, 1)} | ${pctChange === null ? '—' : `${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)} %`} |`,
    );
  }

  const lat = series.map((s) => s.processingLatencyMs).filter((v) => typeof v === 'number');
  const st = (arr) => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((x, y) => x - y);
    return { avg: avg(s), p95: s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)], max: s[s.length - 1] };
  };
  const a = st(slice(lat, 0, 0.1));
  const b = st(slice(lat, 0.9, 1));
  console.log(
    `\n**Pipeline latency drift:** first tenth avg **${n(a?.avg, 1)} ms** (p95 ${n(a?.p95, 1)}) → ` +
      `last tenth avg **${n(b?.avg, 1)} ms** (p95 ${n(b?.p95, 1)})\n`,
  );

  /* ⭐ Deciles, because two endpoints cannot tell a monotone rise from a step at the end. */
  console.log('| Decile | From (min) | Avg ms | p95 ms | Max ms |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  const t0 = series.length > 0 ? Date.parse(String(series[0].at)) : 0;
  for (let i = 0; i < 10; i += 1) {
    const from = Math.floor((lat.length * i) / 10);
    const d = st(lat.slice(from, Math.floor((lat.length * (i + 1)) / 10)));
    const mins = series[from] === undefined ? null : (Date.parse(String(series[from].at)) - t0) / 60_000;
    console.log(`| ${String(i + 1)} | ${n(mins, 1)} | ${n(d?.avg, 2)} | ${n(d?.p95, 2)} | ${n(d?.max, 2)} |`);
  }

  console.log(
    `\n**Tracking over the run:** ${String(soak.tracking?.createdTracks ?? '—')} tracks created · ` +
      `${String(soak.tracking?.recoveredTracks ?? '—')} recovered · ` +
      `${String(soak.tracking?.outOfOrderFrames ?? '—')} out-of-order frames\n`,
  );
}

/* ── parity ────────────────────────────────────────────────────────────────────────────────────── */

if (parity !== null) {
  const r = parity.report ?? parity;
  console.log('### Offline / live parity\n');
  console.log('| | Offline (uploaded recording) | Live (browser webcam) | Identical? |');
  console.log('| --- | --- | --- | :---: |');
  const pairs = [
    ['Model id', r.executionPath?.offline?.modelId, r.executionPath?.live?.modelId],
    ['Runtime version', r.executionPath?.offline?.runtimeVersion, r.executionPath?.live?.runtimeVersion],
    ['Execution provider', r.executionPath?.offline?.executionProvider, r.executionPath?.live?.executionProvider],
  ];
  for (const [label, a, b] of pairs) {
    const same = a !== null && a !== undefined && a === b;
    console.log(`| ${label} | ${a ?? '—'} | ${b ?? '—'} | ${same ? '✅' : '⚠️'} |`);
  }
  console.log(
    `| Event types | ${(r.events?.offlineTypes ?? []).join(', ') || '—'} | ${(r.events?.liveTypes ?? []).join(', ') || '—'} | ` +
      `${JSON.stringify(r.events?.offlineTypes) === JSON.stringify(r.events?.liveTypes) ? '✅' : '⚠️'} |`,
  );
  console.log(
    `| Detections per frame | ${n(r.volumes?.offlineDetectionsPerFrame, 3)} | ${n(r.volumes?.liveDetectionsPerFrame, 3)} | comparable |`,
  );
  console.log('');
}
