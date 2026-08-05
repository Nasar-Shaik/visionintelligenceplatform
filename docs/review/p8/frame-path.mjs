/**
 * P-8 Phase 2 · **do real frames actually travel from a camera to the runtime?**
 *
 *   node docs/review/p8/frame-path.mjs          # baseline → 1,2,4,8,16 cameras → back-pressure → clean
 *   node docs/review/p8/frame-path.mjs clean    # ⚠️ if a run was interrupted
 *
 * Phase 2 is not about detection. It is about transport: frames leaving ffmpeg, crossing the network,
 * and being counted on the other side — under load, and while the far side is broken.
 *
 * ### ⚠️ The source is synthetic, and that is stated everywhere it matters
 *
 * Cameras point at an RTSP fixture (`mediamtx` + `ffmpeg testsrc`), not at hardware. Every number
 * below measures **the platform's frame path**; none of it is a claim about vendor compatibility.
 * [L-1](../../project/KNOWN_LIMITATIONS.md) stands until real cameras are connected in P-9.
 *
 * ### The check that matters most
 *
 * **Frame accounting closes.** `offered = delivered + dropped + failed + no-image`, exactly, at every
 * rung. A pipeline that loses frames without counting them is one that will one day lose evidence
 * without counting it, and the difference between "we dropped 400 frames" and "400 frames are
 * missing" is the whole of an operator's confidence.
 *
 * ### And the hard requirement
 *
 * **Recording must survive perception.** The runtime is paused mid-run with cameras streaming: frames
 * must fail, segments must not. Segments are evidence; frames are an opinion about evidence.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const RUNTIME = 'vip-prod-inference-1';
const FIXTURE = 'vip-rtsp-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-fixture';
const LADDER = [1, 2, 4, 8, 16];
/** Seconds of steady state sampled at each rung, after warm-up. */
const WINDOW = 20;
const WARMUP = 8;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push(label);
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

/* ── the deployment, read from inside it ──────────────────────────────────────────────────────── */

/** Prometheus text → { name: value }, ignoring labels (one series per name here). */
function scrape(container, port) {
  const text =
    container === MEDIA
      ? shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`])
      : shq('docker', [
          'exec',
          container,
          'python',
          '-c',
          `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/metrics',timeout=4).read().decode())`,
        ]);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_][a-z0-9_]*)(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** CPU %, memory MB and network bytes for a container, from the runtime's own accounting. */
function containerStats(name) {
  const raw = shq('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}',
    name,
  ]);
  const [cpu = '', mem = '', net = ''] = raw.split('|');
  const toMb = (s) => {
    const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) return 0;
    const v = Number(m[1]);
    const unit = (m[2] ?? '').toLowerCase();
    return unit.startsWith('g')
      ? v * 1024
      : unit.startsWith('k')
        ? v / 1024
        : unit.startsWith('b')
          ? v / 1048576
          : v;
  };
  return {
    cpuPercent: Number((cpu.replace('%', '') || '0').trim()),
    memoryMb: toMb((mem.split('/')[0] ?? '').trim()),
    netInMb: toMb((net.split('/')[0] ?? '').trim()),
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

/* ── fixture cameras ──────────────────────────────────────────────────────────────────────────── */

const fixtureCameras = async () => {
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  return (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
};

async function cleanup(quiet = false) {
  await login();
  const cams = await fixtureCameras();
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    /* ⚠️ No `content-type` on a bodyless DELETE: Fastify refuses `application/json` with an empty
       body, and the first version of this cleanup reported "removed 17" while deleting none. */
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet)
    console.log(`\nremoved ${cams.length} fixture camera(s) and stopped the RTSP fixture\n`);
  return cams.length;
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

function startFixture() {
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    FIXTURE,
    '--network',
    NETWORK,
    '-v',
    `${ROOT}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
    // P-8 Phase 3: the fixture's default path now loops a real photograph, so the frames that
    // travel the pipeline contain something a detector can be right or wrong about.
    '-v',
    `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
}

console.log('\nP-8 Phase 2 · the frame path\n');
await login();

/* ── 0 · idle baseline, before a single camera exists ─────────────────────────────────────────── */
console.log('0 · idle baseline (nothing connected)');

await cleanup(true);
await sleep(2000);

const idleRuntime = containerStats(RUNTIME);
const idleMedia = containerStats(MEDIA);
const imageSize = (img) => shq('docker', ['images', img, '--format', '{{.Size}}']);

const restartedAt = Date.now();
sh('docker', ['restart', RUNTIME]);
let startupMs = 0;
for (let i = 0; i < 60; i += 1) {
  const health = shq('docker', ['inspect', '-f', '{{.State.Health.Status}}', RUNTIME]);
  if (health === 'healthy') {
    startupMs = Date.now() - restartedAt;
    break;
  }
  await sleep(500);
}
check(
  startupMs > 0 && startupMs < 60_000,
  'the runtime restarts to healthy on its own',
  `${(startupMs / 1000).toFixed(1)}s`,
);
console.log(
  `  · runtime idle: ${idleRuntime.memoryMb.toFixed(1)} MB · ${idleRuntime.cpuPercent}% CPU · image ${imageSize('vip/inference:local')}`,
);
console.log(
  `  · media idle:   ${idleMedia.memoryMb.toFixed(1)} MB · ${idleMedia.cpuPercent}% CPU · image ${imageSize('vip/media:local')}`,
);
check(
  idleRuntime.memoryMb > 0 && idleRuntime.memoryMb < 250,
  '⚠️ an idle runtime is cheap enough to leave running on a small box',
  `${idleRuntime.memoryMb.toFixed(1)} MB`,
);

const before = scrape(MEDIA, 8083);
check(
  before['media_perception_frames_offered_total'] !== undefined,
  'media exposes the perception counters — the seam is measurable from the deployment',
  `offered=${before['media_perception_frames_offered_total']}`,
);

/* ── 1 · the ladder ───────────────────────────────────────────────────────────────────────────── */
console.log(`\n1 · throughput at ${LADDER.join(', ')} cameras (${WINDOW}s window each)`);

startFixture();
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const created = [];
const rungs = [];

for (const n of LADDER) {
  while (created.length < n) {
    const i = created.length + 1;
    const mk = await api('/camera/cameras', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        zoneId,
        name: `P8 fixture ${String(i).padStart(2, '0')}`,
        protocol: 'rtsp',
        streamUrl: `rtsp://${FIXTURE}:8554/p8cam${String(i).padStart(2, '0')}`,
        metadata: { tags: [TAG] },
      }),
    });
    if (mk.status !== 201) {
      check(false, `could not create fixture camera ${i}`, `${mk.status} ${mk.text.slice(0, 120)}`);
      break;
    }
    const id = mk.json.data.id;
    created.push(id);
    await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
  }

  await sleep(WARMUP * 1000);
  const m0 = scrape(MEDIA, 8083);
  const r0 = scrape(RUNTIME, 8085);
  const t0 = Date.now();
  await sleep(WINDOW * 1000);
  const m1 = scrape(MEDIA, 8083);
  const r1 = scrape(RUNTIME, 8085);
  const seconds = (Date.now() - t0) / 1000;

  const d = (a, b, k) => (b[k] ?? 0) - (a[k] ?? 0);
  const offered = d(m0, m1, 'media_perception_frames_offered_total');
  const delivered = d(m0, m1, 'media_perception_frames_delivered_total');
  const dropped = d(m0, m1, 'media_perception_frames_dropped_total');
  const failed = d(m0, m1, 'media_perception_frames_failed_total');
  const noImage = d(m0, m1, 'media_perception_frames_no_image_total');
  const runtimeProcessed = d(r0, r1, 'inference_runtime_frames_processed_total');

  const mediaStats = containerStats(MEDIA);
  const runtimeStats = containerStats(RUNTIME);
  const netDelta = containerStats(MEDIA).netInMb - (m0.__net ?? 0);

  const rung = {
    n,
    offered,
    delivered,
    dropped,
    failed,
    noImage,
    runtimeProcessed,
    fps: delivered / seconds,
    deliverMs: m1['media_perception_deliver_ms_avg'] ?? 0,
    frameAgeMs: m1['media_perception_frame_age_ms_avg'] ?? 0,
    queueDepth: m1['media_perception_queue_depth'] ?? 0,
    runtimeLatencyMs: r1['inference_runtime_latency_ms_avg'] ?? 0,
    mediaCpu: mediaStats.cpuPercent,
    mediaMem: mediaStats.memoryMb,
    runtimeCpu: runtimeStats.cpuPercent,
    runtimeMem: runtimeStats.memoryMb,
    netInMb: netDelta,
    cameras: r1['inference_runtime_cameras_current'] ?? 0,
  };
  rungs.push(rung);

  console.log(
    `  ${String(n).padStart(2)} cam · ${offered.toString().padStart(4)} offered · ${delivered
      .toString()
      .padStart(4)} delivered · ${dropped} dropped · ${failed} failed · ${rung.fps.toFixed(
      1,
    )} fps · deliver ${rung.deliverMs.toFixed(1)} ms · age ${rung.frameAgeMs.toFixed(
      1,
    )} ms · media ${rung.mediaCpu.toFixed(0)}%/${rung.mediaMem.toFixed(0)}MB · runtime ${rung.runtimeCpu.toFixed(
      0,
    )}%/${rung.runtimeMem.toFixed(0)}MB`,
  );
}

/* ── 2 · the checks the ladder has to satisfy ─────────────────────────────────────────────────── */
console.log('\n2 · what the numbers have to say');

for (const r of rungs) {
  check(
    r.delivered > 0,
    `${String(r.n).padStart(2)} cameras — frames actually reached the runtime`,
    `${r.delivered} in ${WINDOW}s`,
  );
}

for (const r of rungs) {
  /* Same six-state invariant as §3; on the ladder the pipeline is empty, so this reduces to
     offered = delivered and stays a real check only because §3 exercises the other four states. */
  const sum = r.delivered + r.dropped + r.failed + r.noImage + r.queueDepth;
  check(
    Math.abs(sum - r.offered) <= 2,
    `${String(r.n).padStart(2)} cameras — ⚠️ frame accounting closes: offered = delivered + dropped + failed`,
    `${r.offered} vs ${sum}`,
  );
}

const top = rungs[rungs.length - 1];
check(
  Math.abs(top.runtimeProcessed - top.delivered) <= Math.max(3, top.delivered * 0.02),
  '⚠️ both ends agree on how many frames crossed — the runtime counted what media sent',
  `media ${top.delivered} · runtime ${top.runtimeProcessed}`,
);
check(
  top.cameras >= LADDER[LADDER.length - 1] - 1,
  'the runtime sees the cameras that are sending, derived from the last minute of traffic',
  `${top.cameras} cameras`,
);
check(
  top.frameAgeMs < 1000,
  '⚠️ a frame is fresh when it arrives — the queue is not silently becoming a buffer',
  `${top.frameAgeMs.toFixed(1)} ms average age at ${top.n} cameras`,
);

const perCameraCpu = (top.mediaCpu + top.runtimeCpu) / top.n;
console.log(
  `  · cost per camera at ${top.n}: ${perCameraCpu.toFixed(1)}% CPU (media ${top.mediaCpu.toFixed(0)}% + runtime ${top.runtimeCpu.toFixed(0)}%)`,
);
if (top.dropped > 0) {
  finding(
    `${top.dropped} frames were dropped at ${top.n} cameras`,
    'deliberate policy (a camera queue was full), not loss — recorded so the number is never mistaken for a fault',
  );
}

/* ── 3 · the hard requirement: recording survives perception ──────────────────────────────────── */
console.log('\n3 · ⚠️ the hard requirement — pause the runtime, keep the recording');

const sampleSegments = async () => {
  const out = [];
  for (const id of created.slice(0, 8)) {
    const st = await api(`/media/streams/${id}/status`, { headers: H });
    out.push({ id, state: st.json?.data?.state, lastSegmentAt: st.json?.data?.lastSegmentAt });
  }
  return out;
};

const segBefore = await sampleSegments();
const mBefore = scrape(MEDIA, 8083);

sh('docker', ['pause', RUNTIME]);
console.log('  · runtime PAUSED');
await sleep(25_000);
const segDuring = await sampleSegments();
const mDuring = scrape(MEDIA, 8083);
sh('docker', ['unpause', RUNTIME]);
console.log('  · runtime resumed');

const failedDuring =
  (mDuring['media_perception_frames_failed_total'] ?? 0) -
  (mBefore['media_perception_frames_failed_total'] ?? 0);
const droppedDuring =
  (mDuring['media_perception_frames_dropped_total'] ?? 0) -
  (mBefore['media_perception_frames_dropped_total'] ?? 0);
const deliveredDuring =
  (mDuring['media_perception_frames_delivered_total'] ?? 0) -
  (mBefore['media_perception_frames_delivered_total'] ?? 0);

/*
 * ⚠️ **This is where the accounting check earns its place.** On the ladder nothing is dropped and
 * nothing fails, so `offered = delivered` there is nearly free. Here hundreds of frames are lost on
 * purpose, and every one of them still has to be attributable to a named cause.
 */
const offeredDuring =
  (mDuring['media_perception_frames_offered_total'] ?? 0) -
  (mBefore['media_perception_frames_offered_total'] ?? 0);
check(
  failedDuring + droppedDuring > 0,
  'frames were lost while the runtime was unreachable — and the loss is counted, not silent',
  `${failedDuring} failed · ${droppedDuring} dropped · ${deliveredDuring} still delivered`,
);

/*
 * ⚠️ The complete invariant, and the first version of this check did not have it: a frame is
 * **delivered, dropped, failed, imageless, waiting, or in flight** — six states, not four. The check
 * went red at `806 offered vs 770 accounted`, and the missing 36 were exactly the 32 frames sitting
 * in sixteen two-deep camera queues plus the 4 in flight against a paused runtime. The product was
 * right; the arithmetic was short by the pipeline itself.
 */
const inPipeline =
  (mDuring['media_perception_queue_depth'] ?? 0) + (mDuring['media_perception_inflight'] ?? 0);
const accountedDuring =
  deliveredDuring +
  droppedDuring +
  failedDuring +
  ((mDuring['media_perception_frames_no_image_total'] ?? 0) -
    (mBefore['media_perception_frames_no_image_total'] ?? 0)) +
  inPipeline;
check(
  Math.abs(offeredDuring - accountedDuring) <= 4,
  '⚠️ and the accounting still closes under real loss — every frame is delivered, dropped, failed, waiting or in flight',
  `${offeredDuring} offered vs ${accountedDuring} accounted (${inPipeline} still in the pipeline)`,
);

const advanced = segDuring.filter(
  (s, i) => s.lastSegmentAt !== undefined && s.lastSegmentAt !== segBefore[i]?.lastSegmentAt,
);
check(
  advanced.length >= Math.min(6, segBefore.length),
  '⚠️ **segments kept being written while perception was down** — evidence outlives the runtime',
  `${advanced.length}/${segBefore.length} cameras produced a new segment during the outage`,
);
const stillConnected = segDuring.filter((s) => s.state === 'connected').length;
check(
  stillConnected === segDuring.length,
  'and no stream so much as flinched — the decode path never learned the runtime was gone',
  `${stillConnected}/${segDuring.length} still connected`,
);

await sleep(8000);
const mAfter = scrape(MEDIA, 8083);
check(
  (mAfter['media_perception_frames_delivered_total'] ?? 0) >
    (mDuring['media_perception_frames_delivered_total'] ?? 0),
  'delivery resumed by itself once the runtime came back — no restart, no operator',
  `+${((mAfter['media_perception_frames_delivered_total'] ?? 0) - (mDuring['media_perception_frames_delivered_total'] ?? 0)).toFixed(0)} frames`,
);

/* ── 4 · the runtime's own operational surface ────────────────────────────────────────────────── */
console.log('\n4 · the runtime says what it is doing');

const logs = shq('docker', ['logs', '--since', '3m', RUNTIME]);
const jsonLines = logs
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return undefined;
    }
  })
  .filter(Boolean);
check(
  jsonLines.length > 0,
  '⚠️ TD-60: the runtime now emits structured JSON — it was silent after startup in Phase 1',
  `${jsonLines.length} lines in the last 3 minutes`,
);
const heartbeats = jsonLines.filter((l) => l.msg === 'runtime heartbeat');
check(
  heartbeats.length > 0,
  'including a periodic heartbeat, whose absence is the signal that it stopped',
  heartbeats.length > 0
    ? `${heartbeats.length} beats · last: ${heartbeats[heartbeats.length - 1].framesProcessed} frames, ${heartbeats[heartbeats.length - 1].cameras} cameras`
    : 'none',
);
/*
 * ⚠️ The first version of this check forbade **any** line mentioning `/infer`, and went red on the
 * disconnect warnings the pause test deliberately causes — a check that could only pass by the
 * runtime being worse at reporting. What it should assert is the thing that matters: no line **per
 * frame**. Successful frames are logged nowhere, and the exceptional lines are a rounding error
 * against the frames that crossed.
 */
const perFrameLines = jsonLines.filter((l) => l.msg === 'request' && l.path === '/infer');
const inferLines = jsonLines.filter((l) => l.path === '/infer');
check(
  perFrameLines.length === 0 && inferLines.length < Math.max(10, top.delivered * 0.01),
  '⚠️ and it does NOT log a line per frame — at 32 frames a second that would bury everything else',
  `${inferLines.length} exceptional /infer lines against ${top.delivered} frames delivered in one window`,
);
if (inferLines.length > 0) {
  finding(
    `${inferLines.length} "client disconnected" warnings`,
    'media abandoned in-flight frames when the runtime was paused — bounded by maxInflight, and a traceback each before this phase',
  );
}

const cores = shq('docker', ['exec', RUNTIME, 'sh', '-c', 'cat /sys/fs/cgroup/cpu.max']);
const sched = shq('docker', [
  'exec',
  RUNTIME,
  'python',
  '-c',
  `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/scheduler',timeout=4).read().decode())`,
]);
const label = (JSON.parse(sched || '{}').data?.computeResources ?? [])[0]?.label ?? '';
check(
  label !== '',
  '⚠️ TD-61: capacity is read from the cgroup, and the label says which number it is',
  `${label} · cpu.max=${cores}`,
);

/* ── 5 · clean up, and prove it ───────────────────────────────────────────────────────────────── */
console.log('\n5 · the harness leaves nothing behind');
const removed = await cleanup(true);
const left = (await fixtureCameras()).length;
check(left === 0, '⚠️ every fixture camera is gone', `removed ${removed}, ${left} remain`);
check(
  shq('docker', ['ps', '--filter', `name=${FIXTURE}`, '--format', '{{.Names}}']) === '',
  'and the RTSP fixture is stopped',
);

/* ── the table ────────────────────────────────────────────────────────────────────────────────── */
console.log('\n── measured ──────────────────────────────────────────────────────────────────');
console.log(
  'cams | offered | delivered | dropped | failed |   fps | deliver | age  | media cpu/mem | runtime cpu/mem',
);
for (const r of rungs) {
  console.log(
    `${String(r.n).padStart(4)} | ${String(r.offered).padStart(7)} | ${String(r.delivered).padStart(9)} | ${String(
      r.dropped,
    ).padStart(
      7,
    )} | ${String(r.failed).padStart(6)} | ${r.fps.toFixed(1).padStart(5)} | ${r.deliverMs
      .toFixed(1)
      .padStart(
        6,
      )}ms | ${r.frameAgeMs.toFixed(0).padStart(4)}ms | ${`${r.mediaCpu.toFixed(0)}% / ${r.mediaMem.toFixed(0)}MB`.padStart(13)} | ${`${r.runtimeCpu.toFixed(0)}% / ${r.runtimeMem.toFixed(0)}MB`.padStart(15)}`,
  );
}

console.log('');
if (findings.length > 0) {
  console.log(`⚠️ ${findings.length} finding(s):`);
  for (const f of findings) console.log(`   · ${f}`);
  console.log('');
}
console.log(
  failures === 0
    ? '✓ P-8 Phase 2: frames travel, accounting closes, and recording outlives the runtime\n'
    : `✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
