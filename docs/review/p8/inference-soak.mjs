/**
 * P-8 Phase 3H · **does the inference runtime still behave once it has been running a while?**
 *
 *   node docs/review/p8/inference-soak.mjs            # 15 minutes, 4 cameras — the DEFAULT
 *   MINUTES=120 node docs/review/p8/inference-soak.mjs   # a long soak — see the policy below
 *   node docs/review/p8/inference-soak.mjs clean      # ⚠️ if a run was interrupted
 *
 * ### ⚠️ The default is 15 minutes, and a long soak needs a REASON
 *
 * Architect execution policy, 2026-08-05: a multi-hour soak is not a routine milestone gate. The
 * default here is a short stability run, and `MINUTES` is raised only when one of these holds:
 * a memory or resource leak is suspected, a concurrency or scheduling issue is suspected, or the
 * build is a release candidate / real-hardware validation (P-9) / pilot readiness (P-10) / GA.
 * Anything else re-verifies a foundation that already passed, at the cost of the thing not built yet.
 *
 * ⚠️ **A short run is weaker, and pretending otherwise is the trap.** Fifteen minutes cannot see a
 * slow arena leak. What it does see — flat memory across its own halves, a queue that drains, and
 * detection consistency holding — is enough to catch a regression introduced by a change, which is
 * what a milestone gate is for. The leak question is deferred to the runs listed above, not answered.
 *
 * A ladder answers "how fast is it?". This answers a different and more expensive question: **does
 * it stay that way?** The failures a ladder cannot see are the ones that cost a customer a weekend —
 * a session that leaks a few megabytes per thousand frames, a latency that creeps as an arena
 * fragments, a queue that never quite drains, a detector that quietly stops finding the second
 * person.
 *
 * ### ⚠️ Drift is measured against the SECOND half, not the first
 *
 * Comparing the last sample with the first mistakes warm-up for drift — the first minute includes a
 * cold page cache and a JIT that has not settled. The comparison here is the mean of the first half
 * against the mean of the second, which is the shape a leak actually has.
 *
 * ### ⚠️ Detection consistency is the AI-side check, and it is the point
 *
 * Every camera streams the same photograph of two people. So `detections / analysed frame` must sit
 * at **2.0 for the whole run**. A runtime that drifts to 1.8 is not "slightly slower" — it has
 * stopped seeing a person, and no operational metric in this file would notice.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assignCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const RUNTIME = 'vip-prod-inference-1';
const FIXTURE = 'vip-rtsp-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-soak';
const CAMERAS = Number(process.env.CAMERAS ?? 4);
const MINUTES = Number(process.env.MINUTES ?? 15);
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? 60);
const OUT = process.env.OUT ?? `${ROOT}/docs/review/p8/soak-samples.json`;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push({ label, detail });
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scrape(container, port) {
  const text =
    container === MEDIA
      ? shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`])
      : shq('docker', [
          'exec',
          container,
          'python',
          '-c',
          `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/metrics',timeout=5).read().decode())`,
        ]);
  const out = {};
  const labelled = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    out[name] = Number(value);
    const label = (labels.match(/(?:^|,)label="([^"]*)"/) ?? [])[1];
    if (label !== undefined) {
      labelled[name] ??= {};
      labelled[name][label] = Number(value);
    }
  }
  return { ...out, _labelled: labelled };
}

function containerStats(name) {
  const raw = shq('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name]);
  const [cpu = '', mem = ''] = raw.split('|');
  const toMb = (s) => {
    const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) return 0;
    const v = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    return unit.startsWith('g') ? v * 1024 : unit.startsWith('k') ? v / 1024 : v;
  };
  return {
    cpuPercent: Number((cpu.replace('%', '') || '0').trim()),
    memoryMb: toMb((mem.split('/')[0] ?? '').trim()),
  };
}

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

async function cleanup(quiet = false) {
  await login();
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} soak camera(s) and stopped the RTSP fixture\n`);
  return cams.length;
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

console.log(`\nP-8 Phase 3H · inference soak — ${CAMERAS} cameras, ${MINUTES} minutes\n`);
await login();
await cleanup(true);

shq('docker', ['rm', '-f', FIXTURE]);
sh('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${ROOT}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
]);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
for (let i = 1; i <= CAMERAS; i += 1) {
  const made = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name: `${TAG} ${String(i).padStart(2, '0')}`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/p8soak${String(i).padStart(2, '0')}`,
      metadata: { tags: [TAG] },
    }),
  });
  await api(`/media/streams/${made.json.data.id}/start`, { method: 'POST', headers: H, body: '{}' });
  /* ⚠️ P-8 Phase 6: a camera with no assignment is never analysed. See `_assign.mjs`. */
  await assignCameras(api, H, [made.json.data.id]);
}

console.log(`${CAMERAS} cameras streaming; warming up for 60s before the first sample`);
await sleep(60_000);

/* ── the long middle ─────────────────────────────────────────────────────────────────────────── */

const samples = [];
const started = Date.now();
const totalSamples = Math.floor((MINUTES * 60) / SAMPLE_SECONDS);
let previous = { media: scrape(MEDIA, 8083), runtime: scrape(RUNTIME, 8085) };

for (let n = 1; n <= totalSamples; n += 1) {
  await sleep(SAMPLE_SECONDS * 1000);
  const media = scrape(MEDIA, 8083);
  const runtime = scrape(RUNTIME, 8085);
  const mediaStats = containerStats(MEDIA);
  const runtimeStats = containerStats(RUNTIME);

  const delivered = (media.media_perception_frames_delivered_total ?? 0) - (previous.media.media_perception_frames_delivered_total ?? 0);
  const detections = (media.media_perception_detections_total ?? 0) - (previous.media.media_perception_detections_total ?? 0);

  const sample = {
    minute: Math.round((Date.now() - started) / 60_000),
    delivered,
    detections,
    perFrame: delivered > 0 ? detections / delivered : 0,
    dropped: (media.media_perception_frames_dropped_total ?? 0) - (previous.media.media_perception_frames_dropped_total ?? 0),
    failed: (media.media_perception_frames_failed_total ?? 0) - (previous.media.media_perception_frames_failed_total ?? 0),
    queueDepth: media.media_perception_queue_depth ?? 0,
    inferenceMsAvg: media.media_perception_inference_ms_avg ?? 0,
    frameLatencyMsAvg: media.media_perception_frame_latency_ms_avg ?? 0,
    runtimeP50: runtime.inference_latency_ms_p50 ?? 0,
    runtimeP95: runtime.inference_latency_ms_p95 ?? 0,
    runtimeRssMb: (runtime.inference_process_max_rss_kb ?? 0) / 1024,
    runtimeCpu: runtimeStats.cpuPercent,
    runtimeMem: runtimeStats.memoryMb,
    mediaCpu: mediaStats.cpuPercent,
    mediaMem: mediaStats.memoryMb,
  };
  samples.push(sample);
  previous = { media, runtime };

  if (n % 5 === 0 || n === 1) {
    console.log(
      `  ${String(sample.minute).padStart(3)}m · ${sample.delivered} analysed · ${sample.perFrame.toFixed(2)}/frame · ` +
        `p95 ${sample.runtimeP95.toFixed(0)}ms · queue ${sample.queueDepth} · dropped ${sample.dropped} · ` +
        `runtime ${sample.runtimeCpu.toFixed(0)}% / ${sample.runtimeMem.toFixed(0)}MB`,
    );
  }
}

writeFileSync(OUT, JSON.stringify({ cameras: CAMERAS, minutes: MINUTES, samples }, null, 2));

/* ── what the run has to prove ───────────────────────────────────────────────────────────────── */

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const half = Math.floor(samples.length / 2);
const first = samples.slice(0, half);
const second = samples.slice(half);
const drift = (key) => {
  const a = mean(first.map((s) => s[key]));
  const b = mean(second.map((s) => s[key]));
  return { a, b, delta: b - a, percent: a === 0 ? 0 : ((b - a) / a) * 100 };
};

/**
 * ⚠️ **Below this many samples, drift is reported but NOT asserted.**
 *
 * The comparison is the mean of the first half against the mean of the second. With three samples
 * that is one minute against two, and a single-sample baseline is noise rather than a trend — a
 * three-minute run failed here at "p95 +28.3 %" while memory was flat to the megabyte, detection
 * consistency was exactly 2.00 and nothing was wrong. A check that goes red on a healthy platform
 * is worse than no check: it is the one people learn to ignore.
 *
 * Ten samples gives five against five, which is the least that can carry the claim. At the default
 * cadence that is ten minutes, and the standard 15–30 minute run clears it comfortably.
 */
const DRIFT_MIN_SAMPLES = 10;
const canAssertDrift = samples.length >= DRIFT_MIN_SAMPLES;

console.log(`\nafter ${MINUTES} minutes (${samples.length} samples, first half vs second half)\n`);
if (!canAssertDrift) {
  console.log(
    `  ⓘ fewer than ${DRIFT_MIN_SAMPLES} samples — drift is reported below but not asserted, because\n` +
      `    ${first.length} sample(s) against ${second.length} cannot tell a trend from noise.\n`,
  );
}

{
  // A drift assertion, or a reported observation when the run is too short to support one.
  const driftCheck = (ok, label, detail) =>
    canAssertDrift ? check(ok, label, detail) : finding(`${label} (not asserted)`, detail);

  const memory = drift('runtimeMem');
  // ⚠️ A leak is a SLOPE, not a number, so this compares halves rather than endpoints. At ~490
  // frames/minute even a short run covers thousands of frames; anything that grows per-frame is
  // visible as a trend here long before it is visible as an outage.
  driftCheck(
    Math.abs(memory.percent) < 5,
    'runtime memory is flat across the run',
    `${memory.a.toFixed(0)}MB → ${memory.b.toFixed(0)}MB (${memory.percent >= 0 ? '+' : ''}${memory.percent.toFixed(1)}%)`,
  );

  const rss = drift('runtimeRssMb');
  driftCheck(
    Math.abs(rss.percent) < 5,
    'and the process agrees with the container about it',
    `RSS ${rss.a.toFixed(0)}MB → ${rss.b.toFixed(0)}MB`,
  );

  const latency = drift('runtimeP95');
  driftCheck(
    Math.abs(latency.percent) < 20,
    'p95 inference latency does not drift',
    `${latency.a.toFixed(0)}ms → ${latency.b.toFixed(0)}ms (${latency.percent >= 0 ? '+' : ''}${latency.percent.toFixed(1)}%)`,
  );

  const cpu = drift('runtimeCpu');
  driftCheck(
    Math.abs(cpu.percent) < 25,
    'CPU is stable, not climbing',
    `${cpu.a.toFixed(0)}% → ${cpu.b.toFixed(0)}%`,
  );

  const perFrame = samples.map((s) => s.perFrame).filter((v) => v > 0);
  const lo = Math.min(...perFrame);
  const hi = Math.max(...perFrame);
  // ⚠️ The AI-side check, and the reason this file exists. Every camera streams the same two people
  // for the whole run, so this must sit at 2.0. A drift to 1.8 is a runtime that has stopped seeing a
  // person, and not one operational metric above would notice.
  check(
    lo >= 1.95 && hi <= 2.05,
    '⚠️ detection consistency: exactly two people, every minute, for the whole run',
    `${lo.toFixed(2)}–${hi.toFixed(2)} detections per frame`,
  );

  const failed = samples.reduce((a, s) => a + s.failed, 0);
  check(failed === 0, 'no frame was refused or unreachable in the whole run', `${failed} failures`);

  const maxQueue = Math.max(...samples.map((s) => s.queueDepth));
  check(maxQueue <= 8, 'the queue never built up without draining', `peak depth ${maxQueue}`);

  const dropped = samples.reduce((a, s) => a + s.dropped, 0);
  const analysed = samples.reduce((a, s) => a + s.delivered, 0);
  const dropRate = analysed + dropped > 0 ? (dropped / (analysed + dropped)) * 100 : 0;
  check(
    dropRate < 5,
    `${CAMERAS} cameras is inside capacity`,
    `${dropped} dropped of ${analysed + dropped} offered (${dropRate.toFixed(2)}%)`,
  );

  const gaps = samples.filter((s) => s.delivered === 0).length;
  check(gaps === 0, 'no minute passed with nothing analysed', `${gaps} silent minute(s)`);

  console.log(
    `\n  total: ${analysed} frames analysed, ${samples.reduce((a, s) => a + s.detections, 0)} detections, ` +
      `${(analysed / (MINUTES * 60)).toFixed(2)} fps sustained`,
  );
  console.log(`  samples written to ${OUT}`);
}

await cleanup();
console.log(
  failures === 0
    ? `\n✓ the runtime is stable over ${MINUTES} minutes${findings.length ? ` · ${findings.length} finding(s)` : ''}\n`
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
