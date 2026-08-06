/**
 * P-8 Phase 3H · **is the inference platform production-ready, or only working?**
 *
 *   node docs/review/p8/hardening.mjs          # warm-up → reproducibility → capacity → truthfulness
 *   node docs/review/p8/hardening.mjs clean    # ⚠️ if a run was interrupted
 *   SECTIONS=5 node docs/review/p8/hardening.mjs   # one section — used by the mutation harness, so
 *                                                 # that mutations test THIS check, not a copy of it
 *
 * Phase 3 proved the pipeline produces real detections. This asks the four questions that decide
 * whether it can be sold:
 *
 * 1. **Warm-up** — is the first frame after a deploy an outlier, and by how much?
 * 2. **Reproducibility** — does the same frame give the same answer, bit for bit?
 * 3. **Capacity** — how many cameras, from measurement rather than hope?
 * 4. **Truthfulness** — is every number on the dashboard traceable to a runtime metric?
 *
 * ### ⚠️ The capacity answer is a REFUSAL as much as a number
 *
 * The honest output of a capacity run is often "fewer than you hoped". The sizing recommendation
 * below is computed from the measured p95 and drop rate, not chosen — and if the drop rate crosses
 * the threshold at four cameras, four is what it says.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assignCameras, raiseRuntimeCapacity } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MEDIA = 'vip-prod-media-1';
const RUNTIME = 'vip-prod-inference-1';
const FIXTURE = 'vip-rtsp-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-hard';
const LADDER = [1, 2, 4, 8, 12, 16];
const WINDOW = Number(process.env.WINDOW ?? 25);
const WARMUP = 10;
const SCENE = `${ROOT}/infra/docker/fixtures/media/scene-people.jpg`;
const OUT = process.env.OUT ?? `${ROOT}/docs/review/p8/capacity-samples.json`;
/** Above this share of offered frames dropped, a rung is past capacity, not at it. */
const DROP_BUDGET_PERCENT = 2;
/**
 * ⚠️ Section filter, and the reason it exists is not convenience. `mutations.mjs` has to prove that
 * the *shipped* truthfulness check catches a renamed metric; running a reimplementation of that
 * check would only prove the reimplementation works. So the mutation harness runs `SECTIONS=5`
 * against this file, and the thing under test is the thing that ships.
 */
const SECTIONS = (process.env.SECTIONS ?? '1,2,3,4,5,6').split(',').map((s) => Number(s.trim()));
const want = (n) => SECTIONS.includes(n);

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
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

function infer(jpegPath, { cameraId = 'cam_hard', seq = 1, capturedAt = null } = {}) {
  const body = {
    capabilityId: 'perception.person-detection',
    context: { tenantId: TENANT },
    frame: { cameraId, seq, capturedAt: capturedAt ?? new Date().toISOString(), source: 'media' },
    imageBase64: readFileSync(jpegPath).toString('base64'),
  };
  const staged = join(tmpdir(), `p8-hard-${process.pid}.json`);
  writeFileSync(staged, JSON.stringify(body));
  try {
    sh('docker', ['cp', staged, `${MEDIA}:/tmp/p8-hard.json`]);
    const raw = shq('docker', [
      'exec', MEDIA, 'sh', '-c',
      'curl -s -X POST http://inference:8085/infer -H "content-type: application/json" ' +
        '-H "x-internal-key: $INTERNAL_API_KEY" --data-binary @/tmp/p8-hard.json',
    ]);
    try {
      return JSON.parse(raw);
    } catch {
      return { success: false, raw: raw.slice(0, 200) };
    }
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      /* best effort */
    }
  }
}

function runtimeView() {
  const raw = shq('docker', [
    'exec', RUNTIME, 'python', '-c',
    "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/runtime',timeout=5).read().decode())",
  ]);
  try {
    return JSON.parse(raw).data ?? {};
  } catch {
    return {};
  }
}

function scrape(container, port) {
  const text =
    container === MEDIA
      ? shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`])
      : shq('docker', ['exec', container, 'python', '-c',
          `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/metrics',timeout=5).read().decode())`]);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/);
    if (m) out[m[1]] = Number(m[3]);
  }
  return out;
}

function containerStats(name) {
  const raw = shq('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', name]);
  const [cpu = '', mem = ''] = raw.split('|');
  const toMb = (s) => {
    const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) return 0;
    const v = Number(m[1]);
    const u = (m[2] ?? '').toLowerCase();
    return u.startsWith('g') ? v * 1024 : u.startsWith('k') ? v / 1024 : v;
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
    await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} camera(s) and stopped the RTSP fixture\n`);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

/** Bring the runtime back to its committed configuration whatever happened above. */
function restoreRuntime() {
  shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh up -d --force-recreate --no-build inference`]);
}

console.log('\nP-8 Phase 3H · production hardening\n');
await login();
await cleanup(true);

/* ── 1 · warm-up ─────────────────────────────────────────────────────────────────────────────── */
const warmup = { coldStartMs: 0, firstColdMs: 0, warmedColdMs: 0, firstWarmMs: 0, warmedWarmMs: 0, warmupMs: 0 };
if (want(1)) {
  console.log('1 · warm-up: what the first frame after a deploy costs');
  // (a) warm-up OFF: the first inference pays for the arena allocation and kernel selection itself.
  shq('bash', ['-c', `cd ${ROOT} && INFERENCE_ONNX_WARMUP=0 ./infra/docker/prod.sh up -d --force-recreate --no-build inference`]);
  const coldStarted = Date.now();
  for (let i = 0; i < 60; i += 1) {
    if ((runtimeView().health ?? '') === 'ok') break;
    await sleep(1000);
  }
  warmup.coldStartMs = Date.now() - coldStarted;
  const cold = infer(SCENE, { seq: 1 });
  warmup.firstColdMs = cold?.data?.inferenceMs ?? 0;
  const coldRest = [];
  for (let i = 0; i < 10; i += 1) coldRest.push(infer(SCENE, { seq: 2 + i })?.data?.inferenceMs ?? 0);
  warmup.warmedColdMs = mean(coldRest);

  // (b) warm-up ON (the committed configuration).
  restoreRuntime();
  const warmStarted = Date.now();
  for (let i = 0; i < 60; i += 1) {
    if ((runtimeView().health ?? '') === 'ok') break;
    await sleep(1000);
  }
  const warmStartMs = Date.now() - warmStarted;
  const first = infer(SCENE, { seq: 1 });
  warmup.firstWarmMs = first?.data?.inferenceMs ?? 0;
  const warmRest = [];
  for (let i = 0; i < 10; i += 1) warmRest.push(infer(SCENE, { seq: 2 + i })?.data?.inferenceMs ?? 0);
  warmup.warmedWarmMs = mean(warmRest);
  warmup.warmupMs = (runtimeView().capabilities?.[0]?.adapter?.warmupMs) ?? 0;

  console.log(`  cold start (no warm-up): ${(warmup.coldStartMs / 1000).toFixed(1)}s to READY`);
  console.log(`  cold start (warm-up on): ${(warmStartMs / 1000).toFixed(1)}s to READY, warm-up itself ${warmup.warmupMs.toFixed(0)}ms`);
  console.log(`  first inference — unwarmed ${warmup.firstColdMs.toFixed(1)}ms · warmed ${warmup.firstWarmMs.toFixed(1)}ms`);
  console.log(`  steady inference — ${warmup.warmedWarmMs.toFixed(1)}ms`);

  check(warmup.warmupMs > 0, 'the runtime warms the session during load', `${warmup.warmupMs.toFixed(0)}ms`);
  // ⚠️ The claim is only worth making if the improvement is real. If an unwarmed first frame is no
  // slower than a warmed one, warm-up is ceremony and this reports it as a finding.
  const improvement = warmup.firstColdMs > 0 ? ((warmup.firstColdMs - warmup.firstWarmMs) / warmup.firstColdMs) * 100 : 0;
  if (improvement < 10) {
    finding(
      'warm-up buys less than 10%',
      `unwarmed ${warmup.firstColdMs.toFixed(1)}ms vs warmed ${warmup.firstWarmMs.toFixed(1)}ms — it moves cost to load rather than removing it`,
    );
  } else {
    check(true, '⚠️ and the first real frame is measurably cheaper for it', `${improvement.toFixed(0)}% faster`);
  }
  check(
    warmup.firstWarmMs < warmup.warmedWarmMs * 2,
    'a warmed runtime has no first-frame outlier',
    `first ${warmup.firstWarmMs.toFixed(1)}ms vs steady ${warmup.warmedWarmMs.toFixed(1)}ms`,
  );
  check(warmup.coldStartMs < 30_000, 'the container reaches READY quickly either way', `${(warmup.coldStartMs / 1000).toFixed(1)}s`);
}

/* ── 2 · reproducibility ─────────────────────────────────────────────────────────────────────── */
const repro = { runs: 20, confidences: [], variance: 0, fields: [] };
if (want(2)) {
  console.log('\n2 · reproducibility: the same frame, twenty times');
  // ⚠️ Fixed for the run (so all 20 are the same frame identity) but derived from the clock, never
  // hard-coded: a literal timestamp silently changes meaning when it passes from future to past —
  // `frameLatencyMs` is null on one side of that line and a number on the other.
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  const results = [];
  for (let i = 0; i < repro.runs; i += 1) results.push(infer(SCENE, { seq: 7, capturedAt })?.data ?? null);
  const usable = results.filter((r) => r !== null);
  check(usable.length === repro.runs, 'every run answered', `${usable.length}/${repro.runs}`);

  const counts = new Set(usable.map((r) => r.detections.length));
  check(counts.size === 1 && [...counts][0] === 2, 'the detection count never varies', `counts: ${[...counts].join(', ')}`);

  // ⚠️ The strong form: everything except the wall clock must be byte-identical. Comparing only the
  // count would pass a runtime whose boxes wandered by a pixel every call.
  const fingerprint = (r) =>
    JSON.stringify({
      detections: r.detections.map((d) => ({ id: d.detectionId, label: d.label, conf: d.confidence, bbox: d.bbox })),
      model: r.model,
      provider: r.executionProvider,
      preprocessing: r.preprocessingVersion,
      threshold: r.confidenceThreshold,
      schema: r.schemaVersion,
    });
  const prints = new Set(usable.map(fingerprint));
  check(prints.size === 1, '⚠️ every field except the clock is byte-identical across all runs', `${prints.size} distinct result(s)`);

  repro.confidences = usable.map((r) => r.detections.map((d) => d.confidence));
  const perDetection = [0, 1].map((i) => repro.confidences.map((c) => c[i]).filter((v) => v !== undefined));

  /*
   * ⚠️ **The claim is that the values are identical, and that is what is asserted — not that a
   * computed variance equals zero.** The first version tested `variance === 0` and went red at
   * `1.2e-32`, which looks like a real wobble and is not: √1.2e-32 ≈ 1.1e-16, one ULP of a double
   * near 0.92. `mean()` sums twenty copies of the same number, and floating-point addition is not
   * associative, so the mean lands a bit away from the value every sample equals — then squaring
   * that gap produces the 1e-32. The runtime never varied; the arithmetic in this file did.
   *
   * Distinct-value counting has no such artefact: if every run returned the same double, the set has
   * one member, exactly. The variance is still computed and reported, because a number a reviewer
   * can see beats a claim they have to trust — but it is evidence, not the assertion.
   */
  const distinct = perDetection.map((values) => new Set(values).size);
  const variances = perDetection.map((values) => {
    const m = mean(values);
    return mean(values.map((v) => (v - m) ** 2));
  });
  repro.variance = Math.max(...variances);
  repro.distinctConfidences = distinct;
  check(
    distinct.every((n) => n === 1),
    '⚠️ every confidence is the identical double across all runs — not "close", identical',
    perDetection
      .map((v, i) => `d${i}: ${v[0]?.toFixed(6)} × ${v.length} runs, ${distinct[i]} distinct`)
      .join(' · '),
  );
  console.log(
    `  computed variance ${variances.map((x) => x.toExponential(1)).join(' / ')} — ` +
      'floating-point residue of the mean, not runtime variation',
  );

  const latencies = usable.map((r) => r.inferenceMs);
  console.log(
    `  inference ${Math.min(...latencies).toFixed(1)}–${Math.max(...latencies).toFixed(1)}ms ` +
      `(mean ${mean(latencies).toFixed(1)}ms) — the only thing that varies is time`,
  );

  /*
   * ⚠️ **Agreement is not presence.** Everything above compares the twenty results to each other, and
   * every one of those comparisons passes if a field is `undefined` in all twenty — `undefined ===
   * undefined`, and a fingerprint built from missing keys is stable precisely because nothing is
   * there. So each field a future reproduction needs is asserted to EXIST and to be the right shape,
   * against a freshly captured frame (the repro frame's `capturedAt` is deliberately stale, which
   * makes its capture latency uninteresting).
   */
  const live = infer(SCENE, { seq: 99 })?.data ?? {};
  const required = [
    ['schemaVersion', (v) => typeof v === 'string' && /^\d+\.\d+$/.test(v)],
    ['model.id', (v) => typeof v === 'string' && v.length > 0],
    ['model.version', (v) => typeof v === 'string' && v.length > 0],
    ['executionProvider', (v) => typeof v === 'string' && v.length > 0],
    // Not a bare "1.0": a version alone cannot reproduce a frame. The resolved input spec —
    // size, layout, dtype, colour order, pad — has to travel with it.
    ['preprocessingVersion', (v) => typeof v === 'string' && v.includes('/') && v.length > 8],
    ['confidenceThreshold', (v) => typeof v === 'number' && v > 0 && v <= 1],
    ['inferenceMs', (v) => typeof v === 'number' && v > 0],
    ['frameLatencyMs', (v) => typeof v === 'number' && v >= 0],
  ];
  const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  for (const [path, valid] of required) {
    const value = dig(live, path);
    const ok = valid(value);
    repro.fields.push({ path, value, ok });
    check(ok, `  ${path} is present and reproducible`, JSON.stringify(value));
  }
}

/* ── 3 · capacity ────────────────────────────────────────────────────────────────────────────── */
const rows = [];
/**
 * ⚠️ **Raised for the ladder, restored in the `finally` below.**
 *
 * The seeded runtime declares 4 cameras, and from P-8 Phase 6 the control plane enforces it — so the
 * 8-camera rung is refused with a 409 by the control plane doing exactly its job. This ladder reached
 * 16 cameras the week before that gate shipped and stopped dead at 4 afterwards; the first full
 * nightly since is what found it. See `raiseRuntimeCapacity`, which is shared so the next ladder does
 * not rediscover this.
 *
 * ⚠️ The sizing policy is untouched: nothing is published from one run, and a rung that drops frames
 * still reports dropped frames. What is removed is a refusal standing in front of a measurement.
 */
let restoreCapacity = async () => {};
if (want(3)) {
  console.log(`\n3 · capacity at ${LADDER.join(', ')} cameras (${WINDOW}s windows)`);
  restoreCapacity = await raiseRuntimeCapacity(api, H, Math.max(...LADDER) + 8);
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
    '-v', `${ROOT}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
    '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(3000);

  const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
  let created = 0;
  for (const target of LADDER) {
    while (created < target) {
      created += 1;
      const made = await api('/camera/cameras', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          zoneId,
          name: `${TAG} ${String(created).padStart(2, '0')}`,
          protocol: 'rtsp',
          streamUrl: `rtsp://${FIXTURE}:8554/p8h${String(created).padStart(2, '0')}`,
          metadata: { tags: [TAG] },
        }),
      });
      await api(`/media/streams/${made.json.data.id}/start`, { method: 'POST', headers: H, body: '{}' });
      /* ⚠️ P-8 Phase 6: a camera with no assignment is never analysed. See `_assign.mjs`. */
      await assignCameras(api, H, [made.json.data.id]);
    }
    await sleep(WARMUP * 1000);
    const m0 = scrape(MEDIA, 8083);

    /*
     * ⚠️ The queue is sampled THROUGH the window, not once at the end of it. A single read reports
     * the depth at one instant, and the instant a window ends is the one moment a backlog is most
     * likely to have drained — a queue that spiked to 30 and recovered would be recorded as 0, which
     * is the opposite of what a sizing table is for. Peak is the number that decides capacity.
     */
    let queuePeak = 0;
    let runtimeQueuePeak = 0;
    const polls = Math.max(1, Math.floor(WINDOW / 2.5));
    for (let p = 0; p < polls; p += 1) {
      await sleep((WINDOW / polls) * 1000);
      queuePeak = Math.max(queuePeak, scrape(MEDIA, 8083).media_perception_queue_depth ?? 0);
      runtimeQueuePeak = Math.max(runtimeQueuePeak, scrape(RUNTIME, 8085).inference_queue_depth ?? 0);
    }

    const m1 = scrape(MEDIA, 8083);
    const r1 = scrape(RUNTIME, 8085);
    const mediaStats = containerStats(MEDIA);
    const runtimeStats = containerStats(RUNTIME);
    const d = (k) => (m1[k] ?? 0) - (m0[k] ?? 0);

    const delivered = d('media_perception_frames_delivered_total');
    const dropped = d('media_perception_frames_dropped_total');
    const offered = d('media_perception_frames_offered_total');
    const row = {
      cameras: target,
      offered,
      analysed: delivered,
      detections: d('media_perception_detections_total'),
      dropped,
      failed: d('media_perception_frames_failed_total'),
      dropPercent: offered > 0 ? (dropped / offered) * 100 : 0,
      fps: delivered / WINDOW,
      detectionsPerSecond: d('media_perception_detections_total') / WINDOW,
      latencyAvgMs: r1.inference_latency_ms_avg ?? 0,
      latencyP50Ms: r1.inference_latency_ms_p50 ?? 0,
      latencyP95Ms: r1.inference_latency_ms_p95 ?? 0,
      frameLatencyMs: m1.media_perception_frame_latency_ms_avg ?? 0,
      queueDepth: m1.media_perception_queue_depth ?? 0,
      queuePeak,
      runtimeQueuePeak,
      // ⚠️ `fps` IS the sustained throughput — frames actually analysed, held for the whole window.
      // What it needs beside it is not a second name for itself but the rate the cameras *asked*
      // for: sustained throughput only means something against offered load.
      offeredFps: offered / WINDOW,
      runtimeCpu: runtimeStats.cpuPercent,
      runtimeMem: runtimeStats.memoryMb,
      mediaCpu: mediaStats.cpuPercent,
      mediaMem: mediaStats.memoryMb,
    };
    rows.push(row);
    console.log(
      `  ${String(target).padStart(2)} cams · ${row.fps.toFixed(1)} fps · p95 ${row.latencyP95Ms.toFixed(0)}ms · ` +
        `drop ${row.dropPercent.toFixed(1)}% · cpu ${row.runtimeCpu.toFixed(0)}% · mem ${row.runtimeMem.toFixed(0)}MB`,
    );
  }
  writeFileSync(OUT, JSON.stringify({ window: WINDOW, rows, warmup, reproducibility: repro }, null, 2));
}

/* ── 4 · what capacity actually is ───────────────────────────────────────────────────────────── */
let sustainable = 0;
if (want(4) && rows.length > 0) {
  console.log('\n4 · the sizing recommendation, computed not chosen');
  // ⚠️ Sustainable = the largest rung whose drop rate is inside budget AND whose predecessors also
  // were. A single good rung after a bad one is noise, not capacity.
  for (const row of rows) {
    if (row.dropPercent <= DROP_BUDGET_PERCENT && row.failed === 0) sustainable = row.cameras;
    else break;
  }
  const at = rows.find((r) => r.cameras === sustainable);
  const first = rows.find((r) => r.dropPercent > DROP_BUDGET_PERCENT);

  check(sustainable > 0, 'there is a sustainable camera count', `${sustainable} cameras`);
  check(
    rows.every((r) => r.failed === 0),
    'no frame was refused or unreachable at any rung',
  );
  check(
    rows.every((r) => r.analysed === 0 || Math.abs(r.detections / r.analysed - 2) < 0.05),
    '⚠️ detection consistency holds at every rung — two people, every frame, to saturation',
    rows.map((r) => `${r.cameras}:${(r.detections / Math.max(r.analysed, 1)).toFixed(2)}`).join(' '),
  );
  check(
    Math.max(...rows.map((r) => r.runtimeMem)) - Math.min(...rows.map((r) => r.runtimeMem)) < 60,
    'runtime memory is flat across the whole ladder',
    `${Math.min(...rows.map((r) => r.runtimeMem)).toFixed(0)}–${Math.max(...rows.map((r) => r.runtimeMem)).toFixed(0)}MB`,
  );

  console.log(
    `\n  ⚠️ SIZING: ${sustainable} camera(s) per host at 2 fps on CPU` +
      (at ? ` — p95 ${at.latencyP95Ms.toFixed(0)}ms, ${at.runtimeCpu.toFixed(0)}% CPU, ${at.runtimeMem.toFixed(0)}MB` : ''),
  );
  if (first) {
    console.log(
      `  frames first exceed the ${DROP_BUDGET_PERCENT}% drop budget at ${first.cameras} cameras ` +
        `(${first.dropPercent.toFixed(1)}%), and the queue absorbs it by policy`,
    );
    finding(
      'capacity is CPU-bound and well below the frame path',
      `the transport carried 16 cameras with zero loss in Phase 2; inference sustains ${sustainable}`,
    );
  }
}

/* ── 5 · dashboard truthfulness ──────────────────────────────────────────────────────────────── */
/*
 * ⚠️ **Cameras are stopped first, and that is not tidiness.** This section compares a number the
 * page shows against the same number in the runtime's own `/metrics`, read a second or two later.
 * With sixteen cameras still streaming, `framesProcessed` moves by a hundred between the two reads
 * and the check fails against a platform that is telling the truth — a tolerance wide enough to
 * absorb that would be wide enough to absorb a fabricated number, which is the only thing the
 * check exists to catch. Frozen counters make the comparison exact.
 */
if (want(5)) {
  await cleanup(true);
  await sleep(4000);

  console.log('\n5 · every number the dashboard shows traces to a runtime metric');
  const page = await api('/system/ai-runtime', { headers: H });
  const data = page.json?.data ?? {};
  const metrics = scrape(RUNTIME, 8085);
  const view = runtimeView();

  check(page.status === 200 && data.configured === true, 'the operator route answers');

  // Each rendered field is matched to the producer that measured it. ⚠️ Nothing on this page may be
  // computed by the gateway, the console, or this script.
  const traced = [
    ['health', data.runtime?.health, view.health],
    ['executionProvider', data.runtime?.executionProvider, view.executionProvider],
    ['runtimeVersion', data.runtime?.runtimeVersion, view.runtimeVersion],
    ['framesProcessed', data.runtime?.capabilities?.[0]?.metrics?.framesProcessed, metrics.inference_frames_processed_total],
    ['detectionsTotal', data.runtime?.capabilities?.[0]?.metrics?.detectionsTotal, metrics.inference_detections_total],
    ['latencyP95Ms', data.runtime?.capabilities?.[0]?.metrics?.latencyP95Ms, metrics.inference_latency_ms_p95],
  ];
  for (const [name, shown, source] of traced) {
    const ok =
      typeof shown === 'number' && typeof source === 'number'
        ? Math.abs(shown - source) <= Math.max(1, Math.abs(source) * 0.05)
        : shown === source;
    check(ok, `  ${name} is the runtime's own number`, `page ${shown} · runtime ${source}`);
  }

  // ⚠️ The absences, which are the part a dashboard gets wrong. GPU must be null (there is none) and
  // no measured field may be a fabricated zero when nothing produced it.
  check(
    data.runtime?.resources?.gpuPercent === null || data.runtime?.resources?.gpuPercent === undefined,
    '  GPU is absent rather than 0%',
    String(data.runtime?.resources?.gpuPercent),
  );
  check(
    typeof data.runtime?.resources?.cpuCores === 'number' && data.runtime.resources.cpuCores > 0,
    '  CPU cores come from the cgroup quota',
    `${data.runtime?.resources?.cpuCores}`,
  );
  check(
    data.pipeline?.offered >= data.pipeline?.delivered,
    '  the pipeline counters are internally consistent',
    `${data.pipeline?.offered} offered ≥ ${data.pipeline?.delivered} delivered`,
  );
  check(
    typeof data.observedAt === 'string' && Date.now() - Date.parse(data.observedAt) < 10_000,
    '  the page states when it was observed, and it is now',
  );
}

/* ── 6 · the measured table ──────────────────────────────────────────────────────────────────── */
if (want(6) && rows.length > 0) {
console.log('\n6 · measured\n');
console.log(
  'cams | offered |  fps | det/s | avg lat |    p50 |    p95 | capture→det | drop% | dropped | queue peak | runtime cpu/mem | media cpu/mem',
);
for (const r of rows) {
  console.log(
    `${String(r.cameras).padStart(4)} | ${r.offeredFps.toFixed(1).padStart(7)} | ${r.fps.toFixed(1).padStart(4)} | ` +
      `${r.detectionsPerSecond.toFixed(1).padStart(5)} | ` +
      `${(r.latencyAvgMs.toFixed(1) + 'ms').padStart(7)} | ${(r.latencyP50Ms.toFixed(1) + 'ms').padStart(6)} | ` +
      `${(r.latencyP95Ms.toFixed(1) + 'ms').padStart(6)} | ${(r.frameLatencyMs.toFixed(0) + 'ms').padStart(11)} | ` +
      `${r.dropPercent.toFixed(1).padStart(5)} | ${String(r.dropped).padStart(7)} | ` +
      `${(r.queuePeak + '/' + r.runtimeQueuePeak).padStart(10)} | ` +
      `${(r.runtimeCpu.toFixed(0) + '% / ' + r.runtimeMem.toFixed(0) + 'MB').padStart(15)} | ` +
      `${(r.mediaCpu.toFixed(0) + '% / ' + r.mediaMem.toFixed(0) + 'MB').padStart(13)}`,
  );
}
console.log(`\n  samples written to ${OUT}`);
}

// ⚠️ Only a full run touches the deployment on the way out. When the mutation harness calls a single
// section, force-recreating the runtime here would quietly undo the very mutation under test.
await restoreCapacity();
if (SECTIONS.length === 6) restoreRuntime();
console.log(
  failures === 0
    ? `\n✓ the inference platform is production-hardened${findings.length ? ` · ${findings.length} finding(s)` : ''}\n`
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
