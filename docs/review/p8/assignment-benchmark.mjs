/**
 * P-8 Phase 6 · **what does the assignment layer cost, and what breaks first?**
 *
 *   node docs/review/p8/assignment-benchmark.mjs        # 1 → 16 cameras
 *   LADDER=1,2 node docs/review/p8/assignment-benchmark.mjs
 *   node docs/review/p8/assignment-benchmark.mjs clean  # ⚠️ if a run was interrupted
 *
 * The Phase 5 ladder measures what publishing costs. This measures what **orchestrating** costs on
 * top of it: how long a decision takes to reach the data plane, what the control plane's own
 * poll-and-report cycle costs both services, and how utilisation moves as the estate grows.
 *
 * ### ⚠️ Every rung assigns the cameras it creates
 *
 * A ladder that started cameras without assigning them would measure the *skip* path — one map
 * lookup per frame — and report it as the cost of the subsystem. Each rung enables AI on every
 * camera it creates and waits for the enforcement point to confirm, so the numbers describe a
 * platform doing the work.
 *
 * ### ⚠️ Assignment latency is measured END TO END, by the platform, not by this script
 *
 * `camera_assignment_latency_ms` is the control plane's own measurement of accepted-change →
 * reported-applied. Timing it from here would measure this script's HTTP round trip and its own
 * sleeps. It is **`null` until a full round trip completes**, and stays null rather than becoming a
 * zero (ADR-0039) — a benchmark reporting "0 ms to apply an assignment" would be describing a
 * deployment where nothing was ever applied.
 *
 * ### ⚠️ No capacity number is published from one run
 *
 * The standing sizing policy applies unchanged: **2 cameras supported, 4 provisional, and no
 * recommendation until three independent runs agree.** This writes a rung table and refuses to turn
 * it into a headline.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const CAMERA = 'vip-prod-camera-1';
const FIXTURE = 'vip-assignment-bench';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-assignbench';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/assignment-capacity.json');
const LADDER = (process.env.LADDER ?? '1,2,4,8,16').split(',').map(Number);
const WINDOW = Number(process.env.WINDOW ?? 20);
const WARMUP = Number(process.env.WARMUP ?? 10);
/** How long a rung waits for the enforcement point to confirm its assignments. */
const CONVERGE_MS = Number(process.env.CONVERGE_MS ?? 18_000);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts }).trim();
const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${B}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

let H = {};
async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/** Scrape a service's Prometheus endpoint from inside the network. */
function scrape(container, port) {
  const raw = shq('docker', ['exec', container, 'wget', '-qO-', `http://127.0.0.1:${port}/metrics`]);
  const out = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    if (i === -1) continue;
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

/**
 * A series by name, tolerating labels.
 *
 * ⚠️ Every series carries a `service="…"` default label, so an exact-key lookup matches nothing.
 * Phase 5 reported every events-service counter as absent for exactly this reason, and it looked
 * legitimate because absence is a valid answer under ADR-0039.
 */
function series(metrics, name, labels = {}) {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const [key, value] of Object.entries(metrics)) {
    if (key !== name && !key.startsWith(`${name}{`)) continue;
    if (wanted.every((w) => key.includes(w))) return value;
  }
  return undefined;
}

/** A counter delta. ⚠️ Absent on BOTH reads means the series was never exported — `null`, not 0. */
function delta(before, after, name, labels = {}) {
  const a = series(after, name, labels);
  const b = series(before, name, labels);
  if (a === undefined && b === undefined) return null;
  return (a ?? 0) - (b ?? 0);
}

/** A gauge's current value, or `null` when the sample is omitted (ADR-0039). */
const gauge = (m, name) => series(m, name) ?? null;

/** Container CPU % and RSS in MB, from docker's own accounting. */
function usage(container) {
  const raw = shq('docker', [
    'stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', container,
  ]);
  const [cpu, mem] = raw.split('\t');
  const memMb = /([\d.]+)\s*([KMG])iB/.exec(mem ?? '');
  const scale = { K: 1 / 1024, M: 1, G: 1024 };
  return {
    cpu: Number((cpu ?? '0').replace('%', '')) || 0,
    memMb: memMb ? Number(Number(memMb[1]) * (scale[memMb[2]] ?? 1)).toFixed(1) : 0,
  };
}

async function cleanup(quiet = false) {
  await login();
  const r = await api('/camera/cameras?limit=200', { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    /* ⚠️ Assignment first — a deleted camera whose assignment survives keeps a queue for ever. */
    await api(`/camera/assignments/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} camera(s) and stopped the benchmark fixture\n`);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);

if (!existsSync(join(ROOT, 'infra/docker/fixtures/media/tracking/walk.mp4'))) {
  console.log('\ntracking fixtures are missing — generating them first\n');
  sh('node', [join(ROOT, 'docs/review/p8/tracking-fixtures.mjs')], { stdio: 'inherit' });
}

/*
 * ⚠️ Capacity is raised for the run and restored in a `finally`. The seeded runtime declares 4,
 * which is the deployment's honest provisional ceiling — and a ladder that stopped at 4 would
 * measure the refusal path instead of the cost of sixteen cameras. Raising it is a MEASUREMENT
 * decision and is undone; it is not a recommendation.
 */
const runtimes = (await api('/camera/processing-runtimes', { headers: H })).json?.data ?? [];
const runtimeId = runtimes[0]?.id;
const originalMax = runtimes[0]?.maxCameras;
if (runtimeId === undefined) {
  console.error('no runtime registered — the ladder has nowhere to place cameras');
  process.exit(2);
}

console.log(`\nP-8 Phase 6 · assignment capacity at ${LADDER.join(', ')} cameras (${WINDOW}s windows)\n`);
console.log('  ⚠️ Every rung ASSIGNS what it creates. Latency is the platform’s measurement, not this script’s.\n');

shq('docker', ['rm', '-f', FIXTURE]);
sh('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
]);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const rows = [];

try {
  await api(`/camera/processing-runtimes/${runtimeId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ maxCameras: Math.max(...LADDER) + 8 }),
  });

  for (const cameras of LADDER) {
    /*
     * Fresh cameras each rung: these clips are 70 seconds and play once, so a camera created at
     * rung 1 would have finished by rung 8 and the top of the ladder would measure silence.
     */
    const made = [];
    const assignStarted = Date.now();
    let refused = 0;
    for (let i = 0; i < cameras; i += 1) {
      const cam = await api('/camera/cameras', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          zoneId,
          name: `${TAG} ${cameras}-${i}`,
          protocol: 'rtsp',
          /* Its OWN path — a shared one leaves every rung above the first measuring one stream. */
          streamUrl: `rtsp://${FIXTURE}:8554/walk${String(i + 1).padStart(2, '0')}`,
          metadata: { tags: [TAG] },
        }),
      });
      const id = cam.json?.data?.id;
      if (id === undefined) continue;
      made.push(id);
      await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
      const enabled = await api(`/camera/assignments/${id}/enable`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ profileId: 'person-tracking' }),
      });
      if (enabled.status !== 200) refused += 1;
    }
    /** ⚠️ The control plane's own acceptance time, per camera — not the time to process a frame. */
    const acceptMsPerCamera = Number(((Date.now() - assignStarted) / Math.max(1, cameras)).toFixed(1));

    await sleep(CONVERGE_MS);
    await sleep(WARMUP * 1000);

    const m0 = scrape(MEDIA, 8083);
    const c0 = scrape(CAMERA, 8082);
    const started = Date.now();

    /* Sample through the window — a single reading at the end catches the quietest moment. */
    let cpuPeak = 0;
    let memPeak = 0;
    let cameraCpuPeak = 0;
    let queuePeak = 0;
    const polls = Math.max(2, Math.floor(WINDOW / 5));
    for (let p = 0; p < polls; p += 1) {
      await sleep((WINDOW / polls) * 1000);
      const u = usage(MEDIA);
      const cu = usage(CAMERA);
      const live = scrape(MEDIA, 8083);
      cpuPeak = Math.max(cpuPeak, u.cpu);
      memPeak = Math.max(memPeak, Number(u.memMb));
      cameraCpuPeak = Math.max(cameraCpuPeak, cu.cpu);
      queuePeak = Math.max(queuePeak, series(live, 'media_perception_queue_depth') ?? 0);
    }

    const elapsed = (Date.now() - started) / 1000;
    const m1 = scrape(MEDIA, 8083);
    const c1 = scrape(CAMERA, 8082);
    const cameraUsage = usage(CAMERA);

    const offered = delta(m0, m1, 'media_perception_frames_offered_total') ?? 0;
    const delivered = delta(m0, m1, 'media_perception_frames_delivered_total') ?? 0;
    const dropped = delta(m0, m1, 'media_perception_frames_dropped_total') ?? 0;
    const failed = delta(m0, m1, 'media_perception_frames_failed_total') ?? 0;
    const skippedUnassigned = delta(m0, m1, 'media_perception_frames_skipped_unassigned_total');
    const cycles = delta(m0, m1, 'media_assignment_cycles_total') ?? 0;
    const cycleFailures = delta(m0, m1, 'media_assignment_cycle_failures_total') ?? 0;
    const changes = delta(c0, c1, 'camera_assignment_changes_total') ?? 0;
    const assignmentFailures = delta(c0, c1, 'camera_assignment_failures_total') ?? 0;

    const capacity = (await api('/camera/assignments/capacity', { headers: H })).json?.data ?? {};
    const runtimeRow = (capacity.runtimes ?? []).find((r) => r.runtimeId === runtimeId) ?? {};

    const row = {
      cameras,
      windowSeconds: Number(elapsed.toFixed(1)),
      /** Assignments the control plane refused at this rung. Should be 0 while capacity allows. */
      refused,

      /* ── the control plane ─────────────────────────────────────────────────────────────────── */
      /** ⚠️ The platform's own accepted-change → reported-applied. `null` until a round trip lands. */
      assignmentLatencyMs: gauge(c1, 'camera_assignment_latency_ms'),
      /** This script's own view: how long the control plane took to ACCEPT one enable. */
      acceptMsPerCamera,
      assignmentChanges: changes,
      assignmentFailures,
      assignedCameras: gauge(c1, 'camera_assignment_assigned_cameras'),
      activeCameras: gauge(c1, 'camera_assignment_active_cameras'),
      assignmentQueue: gauge(c1, 'camera_assignment_queue'),
      planVersion: gauge(c1, 'camera_assignment_plan_version'),

      /* ── the enforcement point ─────────────────────────────────────────────────────────────── */
      /** ⚠️ `null` when the runtime was never reached — a timeout is not a slow round trip. */
      runtimeLatencyMs: gauge(m1, 'media_assignment_runtime_latency_ms'),
      planVersionApplied: gauge(m1, 'media_assignment_plan_version'),
      plannedCameras: gauge(m1, 'media_assignment_planned_cameras'),
      cyclesPerSecond: Number((cycles / elapsed).toFixed(3)),
      cycleFailures,
      releases: gauge(m1, 'media_assignment_releases_total'),

      /* ── processing ────────────────────────────────────────────────────────────────────────── */
      offeredPerSecond: Number((offered / elapsed).toFixed(2)),
      deliveredPerSecond: Number((delivered / elapsed).toFixed(2)),
      processingFpsPerCamera: Number((delivered / elapsed / Math.max(1, cameras)).toFixed(2)),
      deliverMsAvg: gauge(m1, 'media_perception_deliver_ms_avg'),
      queuePeak,
      /** ⚠️ Policy, not loss — its own number so a full queue and an unassigned camera never merge. */
      skippedUnassigned,
      dropped,
      failed,

      /* ── capacity ──────────────────────────────────────────────────────────────────────────── */
      /** ⚠️ `null` when the runtime declares no capacity — not 0, and never Infinity. */
      runtimeUtilization: runtimeRow.utilization ?? null,
      runtimeRemaining: runtimeRow.remaining ?? null,

      /* ── cost ──────────────────────────────────────────────────────────────────────────────── */
      mediaCpuPeak: cpuPeak,
      mediaMemMbPeak: memPeak,
      cameraCpuPeak: cameraCpuPeak,
      cameraMemMb: Number(cameraUsage.memMb),
    };
    rows.push(row);

    console.log(
      `  ${String(cameras).padStart(2)} cam  ` +
        `assign ${String(row.assignmentLatencyMs === null ? 'null' : row.assignmentLatencyMs.toFixed(0)).padStart(5)} ms  ` +
        `runtime ${String(row.runtimeLatencyMs === null ? 'null' : row.runtimeLatencyMs.toFixed(0)).padStart(4)} ms  ` +
        `fps/cam ${String(row.processingFpsPerCamera).padStart(5)}  ` +
        `queue ${String(queuePeak).padStart(3)}  ` +
        `util ${row.runtimeUtilization === null ? ' null' : `${(row.runtimeUtilization * 100).toFixed(0)}%`.padStart(5)}  ` +
        `drop ${String(dropped).padStart(4)}  ` +
        `media ${String(cpuPeak).padStart(5)}% ${String(memPeak).padStart(6)} MB  ` +
        `ctrl ${String(cameraCpuPeak).padStart(5)}%`,
    );

    for (const id of made) {
      await api(`/camera/assignments/${id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
      await api(`/media/streams/${id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${id}`, {
        method: 'DELETE',
        headers: { authorization: H.authorization },
      });
    }
    /* Let the enforcement point release everything before the next rung starts counting. */
    await sleep(CONVERGE_MS);
  }
} finally {
  /* ⚠️ The runtime's declared capacity goes back, whatever happened. */
  if (originalMax !== undefined) {
    await api(`/camera/processing-runtimes/${runtimeId}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ maxCameras: originalMax }),
    }).catch(() => {});
  }
  await cleanup(true);
}

const report = {
  measuredAt: new Date().toISOString(),
  host: shq('uname', ['-sm']),
  ladder: LADDER,
  windowSeconds: WINDOW,
  /*
   * ⚠️ Restated in the artefact, not only in the console. A JSON file outlives the terminal it was
   * printed in, and a rung table without its policy is read as a capacity recommendation.
   */
  sizingPolicy:
    'Unchanged from AI-5a: 2 cameras supported, 4 provisional, and no recommendation until three ' +
    'independent runs agree. This file is one run.',
  notes: [
    'Every rung assigns the cameras it creates; the numbers describe a platform doing the work.',
    'assignmentLatencyMs is the CONTROL PLANE’s own measurement of accepted-change → reported-applied.',
    'A null latency means no round trip completed in the window — never zero (ADR-0039).',
    'The runtime’s declared capacity is raised for the run and restored afterwards.',
  ],
  rows,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n  written to ${OUT}\n`);
console.log('  ⚠️ Sizing policy unchanged: 2 supported, 4 provisional, one run recommends nothing.\n');
