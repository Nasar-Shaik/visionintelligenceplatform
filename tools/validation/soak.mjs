/**
 * **Release soak** — hours of representative customer workload against the deployed stack.
 *
 *   node tools/validation/soak.mjs --hours 6.5 --out .soak
 *
 * ⛔ **This is not a load test and must never become one.** A soak asks "does the product stay
 * correct and stable while a customer uses it all night", which is a different question from "what
 * breaks it". Pacing is deliberately gentle — one analysis at a time, an occasional parallel pair,
 * a gap between cycles — because a queue that never drains hides exactly the slow leaks a soak
 * exists to find.
 *
 * ### What it records
 *
 * Three append-only JSONL streams, so a run that dies mid-flight still leaves its evidence:
 *   `ops.jsonl`      one line per operation: kind, target, ms, ok, detail
 *   `metrics.jsonl`  one line per sample: per-container CPU/memory, disk, restarts, runtime, queues
 *   `events.jsonl`   phase changes, and every unexpected outcome with enough context to diagnose
 *
 * ### ⚠️ Expected failures are part of the workload
 *
 * The corpus deliberately contains corrupt files. A soak that treated their rejection as a fault
 * would abort in the first cycle; a soak that ignored *all* failures would sleep through a real
 * one. So every fixture declares what it should do, and only a departure from that is a finding.
 */
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { analyseContinuity, describeContinuity } from './lib/continuity.mjs';

const exec = promisify(execFile);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.BASE ?? 'https://localhost';
const TENANT = process.env.TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.PASSWORD ?? '12345678';
const CAMERA = process.env.CAMERA ?? 'cam_retail_entrance';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const HOURS = Number(arg('hours', '6.5'));
const OUT = arg('out', '.soak');
const CYCLE_GAP_MS = Number(arg('gap', '20000'));
const SAMPLE_MS = Number(arg('sample', '60000'));

mkdirSync(OUT, { recursive: true });
const opsFile = join(OUT, 'ops.jsonl');
const metricsFile = join(OUT, 'metrics.jsonl');
const eventsFile = join(OUT, 'events.jsonl');
const stopFile = join(OUT, 'STOP');

const started = Date.now();
const deadline = started + HOURS * 3600 * 1000;
const iso = () => new Date().toISOString();
const write = (file, obj) => appendFileSync(file, `${JSON.stringify({ at: iso(), ...obj })}\n`);
const event = (level, message, detail = {}) => {
  write(eventsFile, { level, message, ...detail });
  console.log(`[${iso()}] ${level.toUpperCase()} ${message}`);
};

/* ── the corpus ──────────────────────────────────────────────────────────────────────────────
 * ⚠️ `expect` is the whole point of this table. `succeed` means the session must reach
 * `succeeded`; `reject` means the platform must refuse the file — at confirm, or with a `failed`
 * session — and doing so is a PASS. Anything else is a finding.
 */
const F = 'infra/docker/fixtures/media/validation';
const CORPUS = [
  /* scene content */
  { file: `${F}/empty-scene.mp4`, tag: 'empty', expect: 'succeed' },
  { file: `${F}/single-person-walking.mp4`, tag: 'one-person', expect: 'succeed' },
  { file: `${F}/multiple-people.mp4`, tag: 'multi-person', expect: 'succeed' },
  { file: `${F}/crowd.mp4`, tag: 'crowded', expect: 'succeed' },
  { file: `${F}/queue-formation.mp4`, tag: 'crowded', expect: 'succeed' },
  { file: `${F}/occlusion.mp4`, tag: 'occlusion', expect: 'succeed' },
  { file: `${F}/retail-loitering.mp4`, tag: 'dwell', expect: 'succeed' },
  /* resolution ladder */
  { file: `${F}/res-180p.mp4`, tag: 'res-180p', expect: 'succeed' },
  { file: `${F}/res-360p.mp4`, tag: 'res-360p', expect: 'succeed' },
  { file: `${F}/res-720p.mp4`, tag: 'res-720p', expect: 'succeed' },
  { file: `${F}/res-1080p.mp4`, tag: 'res-1080p', expect: 'succeed' },
  /* conditions */
  { file: `${F}/night-footage.mp4`, tag: 'night', expect: 'succeed' },
  { file: `${F}/rain.mp4`, tag: 'weather', expect: 'succeed' },
  { file: `${F}/blur.mp4`, tag: 'blur', expect: 'succeed' },
  { file: `${F}/camera-shake.mp4`, tag: 'shake', expect: 'succeed' },
  { file: `${F}/lighting-changes.mp4`, tag: 'lighting', expect: 'succeed' },
  { file: `${F}/fast-movement.mp4`, tag: 'fast', expect: 'succeed' },
  { file: `${F}/partial-visibility.mp4`, tag: 'partial', expect: 'succeed' },
  /* frame rates and angles */
  { file: `${F}/low-fps.mp4`, tag: 'low-fps', expect: 'succeed' },
  { file: `${F}/high-fps.mp4`, tag: 'high-fps', expect: 'succeed' },
  { file: `${F}/angle-overhead.mp4`, tag: 'angle', expect: 'succeed' },
  { file: `${F}/angle-wide.mp4`, tag: 'angle', expect: 'succeed' },
  /* codecs — ⚠️ hev1 analyses fine and plays on nothing Apple ships (TD-29) */
  { file: `${F}/codec-h264.mp4`, tag: 'codec', expect: 'succeed' },
  { file: `${F}/codec-h265-hvc1.mp4`, tag: 'codec', expect: 'succeed' },
  { file: `${F}/codec-h265-hev1.mp4`, tag: 'codec', expect: 'succeed' },
  /* duration ladder — the medium and large end */
  { file: `${F}/long-recording.mp4`, tag: 'medium', expect: 'succeed' },
  { file: `${F}/large/duration-1min.mp4`, tag: 'medium', expect: 'succeed' },
  { file: `${F}/large/duration-5min.mp4`, tag: 'large', expect: 'succeed' },
  { file: `${F}/large/duration-10min.mp4`, tag: 'large', expect: 'succeed' },
  /* ⛔ the platform must REFUSE these, and refusing is a pass */
  { file: `${F}/corrupt-zero-bytes.mp4`, tag: 'corrupt', expect: 'reject' },
  { file: `${F}/corrupt-not-a-video.mp4`, tag: 'corrupt', expect: 'reject' },
  { file: `${F}/corrupt-truncated-header.mp4`, tag: 'corrupt', expect: 'reject' },
  { file: `${F}/corrupt-audio-only.mp4`, tag: 'corrupt', expect: 'reject' },
];

/* ⚠️ Portrait, irregular duration, real person, real phone frame rate — the shape of input that
 * found V-11 and V-15. Included when present; the fixture library has nothing like it. */
const REAL = process.env.SOAK_REAL_VIDEO;
if (REAL) CORPUS.push({ file: REAL, tag: 'portrait-real', expect: 'succeed' });

/* ── transport ───────────────────────────────────────────────────────────────────────────── */
let token = '';
async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  const data = body.data ?? body;
  token = data.accessToken ?? data.token ?? '';
  if (!token) throw new Error(`login failed: ${res.status}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  /* ⚠️ 401 means the 15-minute token aged out mid-soak, not that the platform broke. */
  if (res.status === 401) {
    await login();
    return api(method, path, body);
  }
  return { status: res.status, ok: res.ok, data: parsed.data ?? parsed, error: parsed.error };
}

/** Time an operation, record it, and never let a throw escape into the loop. */
async function op(kind, target, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    write(opsFile, { kind, target, ms: Date.now() - t0, ok: true });
    return { ok: true, value };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    write(opsFile, { kind, target, ms: Date.now() - t0, ok: false, detail });
    return { ok: false, detail };
  }
}

/* ── one recording, end to end ───────────────────────────────────────────────────────────── */
async function uploadAndAnalyse(entry, { analyse = true } = {}) {
  const name = basename(entry.file);
  const bytes = statSync(entry.file).size;

  const created = await api('POST', '/media/analyses', {
    cameraId: CAMERA,
    label: `soak ${name}`,
    originalName: name,
    contentType: 'video/mp4',
    bytes,
  });
  if (!created.ok) {
    if (entry.expect === 'reject') return { outcome: 'reject', stage: 'create' };
    throw new Error(`create ${created.status}: ${JSON.stringify(created.error).slice(0, 160)}`);
  }

  const put = await fetch(created.data.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': created.data.contentType },
    body: readFileSync(entry.file),
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);

  const confirmed = await api('POST', `/media/analyses/${created.data.analysis.id}/confirm`, {});
  if (!confirmed.ok) {
    if (entry.expect === 'reject') return { outcome: 'reject', stage: 'confirm', id: created.data.analysis.id };
    throw new Error(`confirm ${confirmed.status}: ${JSON.stringify(confirmed.error).slice(0, 160)}`);
  }

  const id = created.data.analysis.id;
  if (!analyse) return { outcome: 'uploaded', id };

  const session = await api('POST', `/media/analyses/${id}/sessions`, {});
  if (!session.ok) {
    if (entry.expect === 'reject') return { outcome: 'reject', stage: 'session', id };
    throw new Error(`session ${session.status}: ${JSON.stringify(session.error).slice(0, 160)}`);
  }

  const sid = session.data.id;
  const TERMINAL = ['succeeded', 'failed', 'cancelled', 'expired'];
  let state = session.data.state;
  let waited = 0;
  /* ⚠️ 20 minutes: a 10-minute recording at ~5× real time plus queueing. Past that it is wedged. */
  while (!TERMINAL.includes(state) && waited < 20 * 60_000) {
    await sleep(3000);
    waited += 3000;
    const detail = await api('GET', `/media/analyses/${id}`);
    state = detail.data?.sessions?.find((s) => s.id === sid)?.state ?? state;
  }
  const detail = await api('GET', `/media/analyses/${id}`);
  const s = detail.data?.sessions?.find((x) => x.id === sid);
  return { outcome: state, id, sessionId: sid, counts: s?.counts, error: s?.error, waitedMs: waited };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ⭐ The read surfaces a customer actually opens after an analysis finishes. */
async function exerciseSurfaces(id, sessionId) {
  await op('timeline', id, async () => {
    const r = await api('GET', `/media/analyses/${id}/timeline?sessionId=${sessionId}`);
    if (!r.ok) throw new Error(`timeline ${r.status}`);
    return r.data;
  });
  await op('report', id, async () => {
    const r = await api('GET', `/media/analyses/${id}/report?sessionId=${sessionId}`);
    if (!r.ok) throw new Error(`report ${r.status}`);
    return r.data;
  });
  const pb = await op('playback', id, async () => {
    const r = await api('GET', `/media/analyses/${id}/playback`);
    if (!r.ok) throw new Error(`playback ${r.status}`);
    return r.data;
  });
  /* ⚠️ The signed URL is only worth anything if the object store honours it. */
  if (pb.ok && pb.value?.url) {
    await op('playback-fetch', id, async () => {
      const r = await fetch(pb.value.url, { method: 'GET', headers: { range: 'bytes=0-1023' } });
      if (!r.ok && r.status !== 206) throw new Error(`object store ${r.status}`);
      await r.arrayBuffer();
      return true;
    });
  }
  await op('snapshot', id, async () => {
    const r = await api('POST', `/media/analyses/${id}/snapshots`, { offsetSeconds: 1 });
    if (!r.ok) throw new Error(`snapshot ${r.status}: ${JSON.stringify(r.error).slice(0, 120)}`);
    return r.data;
  });
  await op('events-query', id, async () => {
    const r = await api('GET', `/events/events?analysisSessionId=${sessionId}&limit=50`);
    if (!r.ok) throw new Error(`events ${r.status}`);
    return r.data;
  });
}

/* ── metrics ─────────────────────────────────────────────────────────────────────────────── */
function dockerStats() {
  try {
    const raw = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
    );
    const out = {};
    for (const line of raw.trim().split('\n')) {
      const [name, cpu, mem, memPerc] = line.split('\t');
      if (!name?.startsWith('vip-prod-')) continue;
      const key = name.replace(/^vip-prod-/, '').replace(/-1$/, '');
      out[key] = {
        cpu: Number.parseFloat(cpu),
        memMb: Number.parseFloat(mem),
        memPerc: Number.parseFloat(memPerc),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Restart count and health per container.
 *
 * ⛔ **This returned `{}` for the entire 6.5-hour soak and nobody noticed** — including me, twice,
 * out loud. The template was `{{.State.Health.Status}}`, and `vip-prod-proxy-1` has **no
 * healthcheck**, so `.State.Health` is nil, `docker inspect` errors on that one container, and the
 * `try` around the whole loop swallowed the failure and returned an empty object for all seventeen.
 *
 * ⚠️ **An empty object compares equal to an empty object**, so the report's "no container
 * restarted" and my own mid-run status updates were derived from two absences, not from evidence.
 * The conclusion happened to be true — `docker inspect` afterwards showed counts identical to
 * baseline — which is exactly what makes this the dangerous shape: a broken check that agrees with
 * reality is indistinguishable from a working one until the day it does not.
 *
 * Two fixes, and the second matters more than the first: `{{if .State.Health}}…{{end}}` so a
 * container without a healthcheck is handled rather than fatal, and a **per-container** try so one
 * awkward container can never blank the metric for the rest.
 */
function restartCounts() {
  let names = [];
  try {
    names = execFileSync(
      'docker',
      ['ps', '-a', '--filter', 'name=vip-prod-', '--format', '{{.Names}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
    ).trim().split('\n').filter(Boolean);
  } catch {
    return {};
  }
  const out = {};
  for (const name of names) {
    try {
      const raw = execFileSync(
        'docker',
        ['inspect', '-f', '{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
      ).trim().split('\t');
      out[name.replace(/^vip-prod-/, '').replace(/-1$/, '')] = {
        restarts: Number(raw[0]),
        health: raw[1],
      };
    } catch {
      /* ⚠️ Named explicitly rather than omitted — a container we could not inspect is a fact the
       * report should carry, not a silent gap that reads as "nothing to see". */
      out[name.replace(/^vip-prod-/, '').replace(/-1$/, '')] = { restarts: null, health: 'uninspectable' };
    }
  }
  return out;
}

async function runtimeMetrics() {
  try {
    const { stdout } = await exec('docker', [
      'exec', 'vip-prod-inference-1', 'python', '-c',
      'import urllib.request;print(urllib.request.urlopen("http://127.0.0.1:8085/runtime").read().decode())',
    ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    const data = JSON.parse(stdout).data;
    const cap = data.capabilities?.[0];
    return {
      health: data.health,
      executionProvider: data.executionProvider,
      state: cap?.state,
      model: cap?.model?.id,
      fps: cap?.metrics?.fps,
      framesProcessed: cap?.metrics?.framesProcessed,
      droppedFrames: cap?.metrics?.droppedFrames,
      avgLatencyMs: cap?.metrics?.avgLatencyMs,
      latencyP95Ms: cap?.metrics?.latencyP95Ms,
      queueDepth: cap?.metrics?.queueDepth,
      detectionsTotal: cap?.metrics?.detectionsTotal,
      memoryMb: cap?.metrics?.memoryMb,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
  }
}

function diskFree() {
  try {
    const raw = execFileSync('df', ['-k', '/'], { encoding: 'utf8' }).trim().split('\n').pop();
    const cols = raw.split(/\s+/);
    return { availGb: Number((Number(cols[3]) / 1024 / 1024).toFixed(1)), usePerc: cols[4] };
  } catch {
    return {};
  }
}

/**
 * Open file descriptors per container.
 *
 * ⛔ **`/proc/1/fd` alone reported a flat `3` for every service** in the harness smoke run — the fds
 * of the `ls` that was asked, not of the server. A metric that cannot move is worse than no metric:
 * it reads as "no leak" for six hours and would have done so through one. Counting every PID in the
 * namespace is what makes the number capable of rising.
 */
function fileDescriptors() {
  const out = {};
  for (const name of ['media', 'gateway', 'inference', 'events', 'workflow']) {
    try {
      const n = execFileSync(
        'docker',
        ['exec', `vip-prod-${name}-1`, 'sh', '-c', 'for p in /proc/[0-9]*; do ls "$p"/fd 2>/dev/null; done | wc -l'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
      ).trim();
      out[name] = Number(n);
    } catch { /* a container without a shell is not a finding */ }
  }
  return out;
}

/**
 * JetStream depth. ⚠️ A soak's most valuable stability signal: a consumer that falls behind shows
 * here as a rising backlog long before anything reports an error.
 */
function jetstream() {
  try {
    const raw = execFileSync(
      'docker',
      ['exec', 'vip-prod-nats-1', 'sh', '-c', 'wget -qO- http://127.0.0.1:8222/jsz?streams=1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 },
    );
    const js = JSON.parse(raw);
    return {
      messages: js.messages,
      bytes: js.bytes,
      consumers: js.consumers,
      streams: (js.account_details ?? [])
        .flatMap((a) => a.stream_detail ?? [])
        .map((s) => ({
          name: s.name,
          messages: s.state?.messages,
          /* ⭐ The number that matters: how far the slowest consumer is behind. */
          maxPending: Math.max(0, ...(s.consumer_detail ?? []).map((c) => c.num_pending ?? 0)),
        })),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}

async function apiLatency() {
  const t0 = Date.now();
  const r = await api('GET', '/media/analyses?limit=5');
  return { ms: Date.now() - t0, status: r.status };
}

/* ── P-11 additions: what slices 2.2 and 2.3 made measurable ─────────────────────────────── */

/**
 * Scrape a container's Prometheus endpoint for the series matching a prefix.
 *
 * ⛔ **`fetcher` is per container and not a convenience.** The first version used
 * `wget || curl` everywhere; the media image has both and the inference image has **neither**, so
 * the behaviour series came back `{}` on every sample of a smoke run — silently, because the
 * `try` returns an empty object and an empty object compares equal to an empty object. It read as
 * "the behaviour layer reported nothing", which is indistinguishable from "the behaviour layer did
 * nothing", for as long as anyone cared to look. Found by comparing the first and last sample of an
 * eight-minute rehearsal rather than by any assertion.
 */
function scrape(container, port, prefix, fetcher = 'wget') {
  const command =
    fetcher === 'python'
      ? `python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${String(port)}/metrics').read().decode())"`
      : `wget -qO- http://127.0.0.1:${String(port)}/metrics`;
  try {
    const raw = execFileSync(
      'docker',
      ['exec', container, 'sh', '-c', command],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 25_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const out = {};
    for (const line of raw.split('\n')) {
      if (line.startsWith('#') || !line.startsWith(prefix)) continue;
      const space = line.lastIndexOf(' ');
      if (space === -1) continue;
      const name = line.slice(0, space).replace(/\{.*\}$/, '');
      out[name] = Number(line.slice(space + 1));
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The behaviour layer's own series (P-11 slices 2.2–2.3).
 *
 * ⛔ **`zoneMembership` is the one that decides whether any zone number below means anything.**
 * `1` is present, `0` is absent (no upstream ever supplied membership, so every zone primitive was
 * inert), `-1` is unobserved. A soak reporting hours of 0.0 s dwell with this at `0` has measured a
 * broken join, not a quiet shop.
 *
 * ⚠️ `latency_ms_avg` is the runtime's own average since boot, so it moves slowly by design — a
 * spike shows as a gentle rise. The per-frame cost is what the benchmark measures, not this.
 */
function behaviourMetrics() {
  const m = scrape('vip-prod-inference-1', 8085, 'inference_', 'python');
  return {
    behaviourFrames: m.inference_behaviour_frames_total,
    subjectsStamped: m.inference_behaviour_subjects_stamped_total,
    behaviourMsAvg: m.inference_behaviour_latency_ms_avg,
    zoneMembership: m.inference_behaviour_zone_membership,
    zoneApplied: m.inference_behaviour_zone_annotations_total,
    zoneMissed: m.inference_behaviour_zone_annotations_missed_total,
    sceneObservations: m.inference_behaviour_scene_observations_total,
    sceneDropped: m.inference_behaviour_scene_observations_dropped_total,
    moduleFailures: m.inference_behaviour_module_failures_total,
    historyPoints: m.inference_track_history_points_total,
    historyRetired: m.inference_track_history_retired_total,
    /* ⛔ Non-zero means the runtime is perceiving and keeping nothing — a silent data-protection
     * failure, and the exact defect slice 2.2 shipped and had to fix. */
    historyWriteFailures: m.inference_track_history_write_failures_total,
    historyRecords: m.inference_track_history_records,
    historyUndatedDropped: m.inference_track_history_undated_dropped_total,
    trackingMsAvg: m.inference_tracking_latency_ms_avg,
    tracksActive: m.inference_tracking_active,
    tracksConfirmed: m.inference_tracking_confirmed,
    tracksLost: m.inference_tracking_lost,
    tracksCreated: m.inference_tracking_created_total,
    tracksTerminated: m.inference_tracking_terminated_total,
    /* ⛔ Identity continuity, as three numbers the report can watch drift apart. A tracker that
     * stops bridging occlusions produces more tracks per identity every hour — and every
     * accumulating primitive downstream (dwell, loitering, co-presence) silently halves without a
     * single error. `recovered / occlusions` is the ratio that falls first. */
    occlusions: m.inference_tracking_occlusions_total,
    recovered: m.inference_tracking_recovered_total,
    reentryOpportunities: m.inference_tracking_reentry_opportunities_total,
    fragmentation: m.inference_tracking_fragmentation,
    /* ⛔ Frames the tracker saw out of order. Non-zero means the delivery path reordered, which
     * makes every duration derived from footage time suspect. */
    outOfOrder: m.inference_tracking_out_of_order_total,
    trackingFrames: m.inference_tracking_frames_total,
  };
}

/** Media's perception + zone series, including the ADR-0053 echo. */
function mediaMetrics() {
  const m = scrape('vip-prod-media-1', 8083, 'media_');
  return {
    framesOffered: m.media_perception_frames_offered_total,
    framesDelivered: m.media_perception_frames_delivered_total,
    framesDropped: m.media_perception_frames_dropped_total,
    framesFailed: m.media_perception_frames_failed_total,
    queueDepth: m.media_perception_queue_depth,
    inflight: m.media_perception_inflight,
    deliverMsAvg: m.media_perception_deliver_ms_avg,
    frameAgeMsAvg: m.media_perception_frame_age_ms_avg,
    inferenceMsAvg: m.media_perception_inference_ms_avg,
    detections: m.media_perception_detections_total,
    zonesLoaded: m.media_zones_loaded,
    zonesTested: m.media_zones_detections_tested_total,
    zonesInside: m.media_zones_inside_total,
    /* ⛔ `zonesInside > 0` with `zoneEchoesSent === 0` is zones resolving and the behaviour layer
     * never hearing about it — the state slice 2.2 shipped while every dashboard looked healthy. */
    zoneEchoesSent: m.media_zones_echoes_sent_total,
    zoneEchoesDropped: m.media_zones_echoes_dropped_total,
  };
}

/**
 * On-disk growth, per data volume, in KiB.
 *
 * ⚠️ `du` inside the container rather than a database's own `dbStats`, deliberately: the stats
 * command needs credentials this harness has no business holding, and the number a customer's disk
 * runs out of is the one on the filesystem anyway.
 */
function storage() {
  const out = {};
  for (const [key, container] of [['mongo', 'vip-prod-mongodb-1'], ['redis', 'vip-prod-redis-1'], ['minio', 'vip-prod-minio-1']]) {
    try {
      const raw = execFileSync(
        'docker',
        ['exec', container, 'sh', '-c', 'du -sk /data 2>/dev/null | tail -1'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 },
      ).trim();
      out[key] = Number(raw.split(/\s+/)[0]);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

/**
 * Log **rate** — bytes emitted per container since the last sample.
 *
 * ⚠️ A rate rather than a total, because a total needs the Docker VM's filesystem and because the
 * question a soak asks is "is something now logging more than it was". A service that starts
 * emitting a stack trace per frame shows here hours before the disk notices.
 */
function logRates(sinceSeconds) {
  const out = {};
  for (const name of ['media', 'inference', 'events', 'gateway', 'workflow', 'rules']) {
    try {
      const raw = execFileSync(
        'sh',
        ['-c', `docker logs --since ${String(sinceSeconds)}s vip-prod-${name}-1 2>&1 | wc -c`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
      ).trim();
      out[name] = Number(raw);
    } catch {
      out[name] = null;
    }
  }
  return out;
}

/**
 * ⛔ Sessions stuck in a non-terminal state, and how long they have been there.
 *
 * A worker that dies mid-analysis leaves a `running` session nothing will ever finish. It costs
 * nothing, breaks nothing visible, and is exactly the class of defect a soak exists to surface —
 * one orphan an hour is invisible in a ten-minute test and obvious over seven hours.
 */
async function orphanSessions(maxAgeMinutes = 30) {
  try {
    const r = await api('GET', '/media/analyses?limit=100');
    const items = r.data?.items ?? r.data ?? [];
    const now = Date.now();
    const stuck = [];
    for (const a of Array.isArray(items) ? items : []) {
      for (const s of a.sessions ?? []) {
        if (['succeeded', 'failed', 'cancelled', 'expired'].includes(s.state)) continue;
        const startedAt = Date.parse(s.startedAt ?? s.createdAt ?? '');
        if (!Number.isFinite(startedAt)) continue;
        const ageMin = (now - startedAt) / 60000;
        if (ageMin > maxAgeMinutes) stuck.push({ analysisId: a.id, sessionId: s.id, state: s.state, ageMin: Number(ageMin.toFixed(1)) });
      }
    }
    return { checked: Array.isArray(items) ? items.length : 0, stuck };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}

async function sample(phase) {
  /*
   * ⛔ **The API probe goes FIRST and alone.** It used to run in a `Promise.all` with
   * `runtimeMetrics()`, which is a `docker exec … python -c` — starting a Python interpreter in a
   * container, on the same host, concurrently with the request being timed.
   *
   * Measured in the 2026-08-08 soak: the probe reported 10–20 ms with occasional 77–107 ms
   * outliers, and the outliers correlated with **nothing in the product** — two of three had no
   * analysis in flight at all, while plenty of 10–17 ms samples did. Probed cleanly with the host
   * quiet, the same endpoint returned p50 7 ms / p95 9 ms at the same collection size.
   *
   * ⚠️ So the outliers described the measurement, not the platform — the worst kind of metric,
   * because it is plausible and it moves. Ordering it first is not a full fix (the host is shared
   * either way), which is why the report quotes the standalone benchmark for latency and treats
   * this series as indicative only.
   */
  const latency = await apiLatency();
  const runtime = await runtimeMetrics();
  const orphans = await orphanSessions();
  write(metricsFile, {
    phase,
    elapsedMin: Number(((Date.now() - started) / 60000).toFixed(1)),
    containers: dockerStats(),
    restarts: restartCounts(),
    disk: diskFree(),
    fds: fileDescriptors(),
    jetstream: jetstream(),
    runtime,
    api: latency,
    /* P-11: what slices 2.2–2.3 made measurable, plus the growth and liveness signals a release
     * soak is supposed to watch. See each collector for what a bad reading looks like. */
    behaviour: behaviourMetrics(),
    media: mediaMetrics(),
    storage: storage(),
    logBytes: logRates(Math.round(SAMPLE_MS / 1000)),
    orphans,
  });
  if (Array.isArray(orphans.stuck) && orphans.stuck.length > 0) {
    event('finding', `${String(orphans.stuck.length)} orphan session(s) past 30 min`, { stuck: orphans.stuck.slice(0, 5) });
  }
}

/**
 * ⭐ **A burst of live frames through `FrameSink.push`** — the path the offline corpus never touches.
 *
 * Offline analysis uses `FrameSink.deliver`, which awaits every frame; a live camera uses `push`,
 * which enqueues, drops under back-pressure and can have several frames of one camera in flight at
 * once. ⛔ That last property is why the ADR-0053 zone echo names the frame it describes, and a soak
 * that only ever ran the offline path would never exercise it — for seven hours, convincingly.
 *
 * ⚠️ Frames are cut once, into the media container, and reused for the whole soak. Re-cutting them
 * every cycle would make ffmpeg the thing under test.
 */
let liveFramesReady = false;
async function ensureLiveFrames(fps = 4, frames = 40) {
  if (liveFramesReady) return true;
  const source = REAL ?? `${F}/single-person-walking.mp4`;
  try {
    await exec('docker', ['exec', 'vip-prod-media-1', 'sh', '-c', 'rm -rf /tmp/soaklive && mkdir -p /tmp/soaklive'], { timeout: 30_000 });
    await exec('docker', ['cp', source, 'vip-prod-media-1:/tmp/soaklive.mp4'], { timeout: 120_000 });
    await exec('docker', [
      'exec', 'vip-prod-media-1', 'ffmpeg', '-loglevel', 'error',
      '-i', '/tmp/soaklive.mp4', '-vf', `fps=${String(fps)}`, '-frames:v', String(frames),
      '-q:v', '4', '/tmp/soaklive/%04d.jpg',
    ], { timeout: 180_000 });
    liveFramesReady = true;
    return true;
  } catch (err) {
    event('finding', 'could not prepare live frames — the live path will not be exercised', {
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return false;
  }
}

const LIVE_CAMERA = process.env.SOAK_LIVE_CAMERA ?? 'cam_4b8cbcbab9ec4685821b35a01c52efd2';

/* ── zones, for the duration of the soak (ADR-0053) ──────────────────────────────────────── */

/**
 * ⭐ **Zones are drawn for the run, because without one the newest code does not execute.**
 *
 * `inference_behaviour_zone_membership` is a lifetime three-valued reading, so a runtime that saw
 * membership once keeps saying `present` until it restarts — which means it cannot tell anyone
 * whether the join is working *now*. What can is `zoneApplied` rising, and that only happens if a
 * camera actually has zones. A soak of the zone join with no zones drawn would be six hours of
 * green that proved nothing, which is the shape of instrument failure this project keeps finding.
 *
 * ⚠️ `verification-*` names, removed on the way out including after a crash, because a zone left
 * behind silently changes what the next run measures.
 */
const rect = (x, y, w, h) => ({ points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] });

async function drawSoakZones(cameras) {
  const made = [];
  for (const cameraId of cameras) {
    for (const [name, geometry] of [
      ['verification-frame', rect(0, 0, 1, 1)],
      ['verification-left', rect(0, 0, 0.5, 1)],
    ]) {
      const created = await api('POST', '/camera/zones', {
        cameraId, name, kind: 'area', shape: 'polygon', geometry, enabled: true,
      });
      if (created.ok) made.push({ cameraId, zoneId: created.data.id, name });
      else event('finding', `could not draw ${name} on ${cameraId}`, { status: created.status });
    }
  }
  return made;
}

async function removeSoakZones(cameras) {
  let removed = 0;
  for (const cameraId of cameras) {
    const listed = await api('GET', `/camera/zones?cameraId=${encodeURIComponent(cameraId)}`);
    for (const zone of Array.isArray(listed.data) ? listed.data : []) {
      if (typeof zone?.name === 'string' && zone.name.startsWith('verification-')) {
        const gone = await api('DELETE', `/camera/zones/${encodeURIComponent(zone.id)}`);
        if (gone.ok) removed += 1;
      }
    }
  }
  return removed;
}

async function liveBurst(fps = 4) {
  if (!(await ensureLiveFrames(fps))) return null;
  const opened = await api('POST', `/media/live/${LIVE_CAMERA}/open`, { frameRate: fps, agent: 'soak' });
  if (!opened.ok) throw new Error(`live open ${opened.status}: ${JSON.stringify(opened.error).slice(0, 140)}`);

  const { stdout } = await exec(
    'docker',
    ['exec', 'vip-prod-media-1', 'sh', '-c', 'for f in /tmp/soaklive/*.jpg; do base64 -w0 "$f"; echo; done'],
    { timeout: 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const images = stdout.split('\n').filter(Boolean);

  let accepted = 0;
  let refused = 0;
  const lags = [];
  for (const image of images) {
    const t0 = Date.now();
    const posted = await api('POST', `/media/live/${LIVE_CAMERA}/frame`, { image, capturedAtMs: Date.now() });
    if (posted.ok) accepted += 1;
    else refused += 1;
    lags.push(Date.now() - t0);
    /* ⚠️ Paced at the declared rate. Firing flat out would exercise the drop policy rather than the
     * perception path, and a real camera never does that. */
    await sleep(Math.max(0, Math.round(1000 / fps) - (Date.now() - t0)));
  }
  await api('POST', `/media/live/${LIVE_CAMERA}/close`, {});
  return { accepted, refused, postMsP95: pctOf(lags, 95) };
}

const pctOf = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * ⛔ **The correctness invariants a soak is uniquely able to break**, checked per analysis rather
 * than once at the end. Each is a defect class the acceptance criteria name.
 *
 * ⚠️ Every one of these can legitimately be zero on an empty scene, so absence of a subject is not a
 * finding — only an *inconsistency between two views of the same run* is.
 */
async function checkInvariants(id, sessionId, name) {
  const [tl, ev, inc] = await Promise.all([
    api('GET', `/media/analyses/${id}/timeline?sessionId=${sessionId}`),
    api('GET', `/events/events?analysisSessionId=${sessionId}&limit=200`),
    api('GET', `/media/analyses/${id}/report?sessionId=${sessionId}`),
  ]);
  const problems = [];

  const events = ev.data?.events ?? [];
  /* ⛔ Event loss: the timeline is built from the same events store, so a timeline naming more
   * events than the store returns means one of the two lost some. */
  const timelineEvents = (tl.data?.entries ?? []).filter((e) => e.kind === 'event').length;
  if (ev.ok && tl.ok && timelineEvents > 0 && events.length === 0) {
    problems.push(`timeline shows ${String(timelineEvents)} events and the events store returned none`);
  }

  /* ⛔ Duplicate incidents: one triggering event must not produce two incidents in one run. */
  const incidents = inc.data?.incidents ?? [];
  const byTrigger = new Map();
  for (const i of incidents) {
    const key = i.triggeringEventId ?? i.triggerEventId ?? null;
    if (key === null) continue;
    byTrigger.set(key, (byTrigger.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byTrigger) {
    if (count > 1) problems.push(`incident duplicated for triggering event ${String(key)} (×${String(count)})`);
  }

  /* ⛔ Timeline corruption: every offset must be a finite, non-negative number of seconds. */
  for (const e of tl.data?.entries ?? []) {
    if (typeof e.offsetSeconds === 'number' && (!Number.isFinite(e.offsetSeconds) || e.offsetSeconds < 0)) {
      problems.push(`timeline entry with offset ${String(e.offsetSeconds)}`);
      break;
    }
  }

  /* ⛔ Identity continuity: an event naming a track must name an identity too (ADR-0041), or every
   * accumulating primitive downstream silently splits one person into several. */
  const missingIdentity = events.filter(
    (e) => e.subjects?.[0]?.trackingId !== undefined && e.subjects?.[0]?.identityId === undefined,
  ).length;
  if (missingIdentity > 0) {
    problems.push(`${String(missingIdentity)} event(s) carry a trackingId with no identityId`);
  }

  if (problems.length > 0) {
    findings += 1;
    event('finding', `invariant violated on ${name}`, { id, sessionId, problems });
  }
  return { events: events.length, incidents: incidents.length, problems: problems.length };
}

/* ── the loop ────────────────────────────────────────────────────────────────────────────── */
const done = [];
let cycle = 0;
let findings = 0;

async function runCycle() {
  cycle += 1;
  const entry = CORPUS[cycle % CORPUS.length];
  const name = basename(entry.file);

  const res = await op('upload+analyse', name, () => uploadAndAnalyse(entry));
  if (!res.ok) {
    findings += 1;
    event('finding', `${name} threw during upload/analyse`, { detail: res.detail, cycle });
    return;
  }

  const { outcome, id, sessionId, counts, error } = res.value;

  if (entry.expect === 'reject') {
    if (outcome === 'reject' || outcome === 'failed') {
      write(opsFile, { kind: 'expected-rejection', target: name, ok: true, detail: outcome });
    } else {
      findings += 1;
      event('finding', `${name} should have been refused and was ${outcome}`, { cycle, id });
    }
    return;
  }

  if (outcome !== 'succeeded') {
    findings += 1;
    event('finding', `${name} ended ${outcome}`, { cycle, id, sessionId, error, counts });
    return;
  }

  done.push({ id, sessionId, name, tag: entry.tag, counts });
  write(opsFile, { kind: 'analysis-counts', target: name, ok: true, counts, tag: entry.tag });
  await exerciseSurfaces(id, sessionId);

  /* ⛔ The invariants, per analysis. See `checkInvariants` for what each one catches. */
  const inv = await op('invariants', name, () => checkInvariants(id, sessionId, name));
  if (inv.ok) write(opsFile, { kind: 'invariant-counts', target: name, ok: true, ...inv.value });

  /* ⭐ The behaviour read APIs (slice 2.3), exercised for hours rather than once. A recomputation
   * over a growing archive is exactly where a read path that scales badly shows itself. */
  await op('behaviour-primitives', name, async () => {
    const r = await api('GET', `/behaviour/primitives?streamId=${sessionId}`);
    if (!r.ok) throw new Error(`primitives ${r.status}`);
    return { identities: Object.keys(r.data?.primitives?.identities ?? {}).length };
  });
  await op('behaviour-timeline', name, async () => {
    const r = await api('GET', `/behaviour/timeline?streamId=${sessionId}`);
    if (!r.ok) throw new Error(`timeline ${r.status}`);
    return { entries: (r.data?.entries ?? []).length, truncated: r.data?.truncated };
  });

  /* ⭐ A live burst every fifth cycle — the `push` path, which the corpus alone never touches. */
  if (cycle % 5 === 0) {
    const live = await op('live-burst', LIVE_CAMERA, () => liveBurst());
    if (!live.ok) {
      findings += 1;
      event('finding', 'live ingest burst failed', { detail: live.detail, cycle });
    } else if (live.value !== null && live.value.accepted === 0) {
      findings += 1;
      event('finding', 'live ingest accepted no frames', { cycle, result: live.value });
    } else if (live.value !== null) {
      write(opsFile, { kind: 'live-counts', target: LIVE_CAMERA, ok: true, ...live.value });
    }
  }

  /* ⭐ Re-analysis of something uploaded earlier: ADR-0047's promise that two runs of one
   * recording are independently persisted, exercised for hours rather than once. */
  if (cycle % 4 === 0 && done.length > 3) {
    const prior = done[Math.floor(Math.random() * (done.length - 1))];
    const again = await op('re-analyse', prior.name, async () => {
      const s = await api('POST', `/media/analyses/${prior.id}/sessions`, {});
      if (!s.ok) throw new Error(`session ${s.status}: ${JSON.stringify(s.error).slice(0, 140)}`);
      const sid = s.data.id;
      let state = s.data.state;
      let waited = 0;
      while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(state) && waited < 20 * 60_000) {
        await sleep(3000);
        waited += 3000;
        const d = await api('GET', `/media/analyses/${prior.id}`);
        state = d.data?.sessions?.find((x) => x.id === sid)?.state ?? state;
      }
      if (state !== 'succeeded') throw new Error(`rerun ended ${state}`);
      const tl = await api('GET', `/media/analyses/${prior.id}/timeline?sessionId=${sid}`);
      if (!tl.ok) throw new Error(`rerun timeline ${tl.status}`);
      /* ⛔ L-61/V-4: a rerun that persists nothing is the exact shape ADR-0047 exists to prevent. */
      return { entries: tl.data.entries.length, sessionId: sid };
    });
    if (!again.ok) {
      findings += 1;
      event('finding', `re-analysis of ${prior.name} failed`, { detail: again.detail, cycle });
    }
  }

  /* ⭐ A parallel pair every eighth cycle — two customers uploading at once, not a stampede. */
  if (cycle % 8 === 0) {
    const pair = [CORPUS[(cycle + 1) % CORPUS.length], CORPUS[(cycle + 2) % CORPUS.length]].filter(
      (e) => e.expect === 'succeed',
    );
    const results = await Promise.all(
      pair.map((e) => op('parallel-upload', basename(e.file), () => uploadAndAnalyse(e))),
    );
    for (const [i, r] of results.entries()) {
      if (!r.ok || (r.value?.outcome !== 'succeeded' && r.value?.outcome !== undefined)) {
        if (r.ok && r.value.outcome === 'succeeded') continue;
        findings += 1;
        event('finding', `parallel upload ${basename(pair[i].file)} → ${r.detail ?? r.value?.outcome}`, { cycle });
      }
    }
  }
}

async function main() {
  event('phase', 'soak starting', { hours: HOURS, corpus: CORPUS.length, out: OUT });
  /*
   * ⛔ **An overnight run on a laptop is the exact case where the host sleeps.** A suspended process
   * does not slow a soak down — it deletes the hours that had not happened yet and leaves a
   * full-looking set of streams behind, because every rate is computed from a clock that kept
   * running. Measured in the P-9 live soak: 966 s of suspension turned a true 4.000 fps into a
   * recorded 2.6 fps, and every other guard passed.
   */
  if (process.platform === 'darwin') {
    console.log(
      '⚠️  macOS: run this under `caffeinate -dimsu node tools/validation/soak.mjs …` or the host will\n' +
        '    sleep and silently invalidate the run. Continuity is checked at the end either way.\n',
    );
  }
  await login();

  /* ⭐ Zones first, then a plan-poll wait, then the baseline — so the baseline already describes the
   * configuration the whole run uses. Media polls the assignment plan every 5 s; a soak that started
   * uploading before the plan landed would spend its first cycles measuring a different deployment. */
  const zoneCameras = [CAMERA, LIVE_CAMERA];
  const zones = await drawSoakZones(zoneCameras);
  event('phase', `drew ${String(zones.length)} zone(s) for the run`, { zones });
  await sleep(20_000);

  await sample('baseline');

  const sampler = setInterval(() => {
    void sample('soak').catch(() => undefined);
  }, SAMPLE_MS);

  while (Date.now() < deadline) {
    try {
      statSync(stopFile);
      event('phase', 'STOP file present — halting');
      break;
    } catch { /* no stop file, carry on */ }

    await runCycle();
    write(opsFile, { kind: 'cycle-complete', target: String(cycle), ok: true, findings });
    await sleep(CYCLE_GAP_MS);
  }

  clearInterval(sampler);
  await sample('final');
  /* ⚠️ Removed before the report is written, and the count recorded — a zone left on a camera
   * silently changes what the next run measures, and the next run is the one somebody trusts. */
  const zonesRemoved = await removeSoakZones(zoneCameras).catch(() => null);
  event('phase', `removed ${String(zonesRemoved)} verification zone(s)`);

  /*
   * ⭐ **The last question, and the one that decides whether the rest may be quoted:** was this
   * process running for the hours it says it ran? The metrics stream is its own heartbeat — a gap
   * of several sampling intervals means the host was asleep, not that the platform was quiet.
   */
  const heartbeats = readFileSync(metricsFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);
  const continuity = analyseContinuity({ samples: heartbeats, intervalMs: SAMPLE_MS });
  const awakeHours = Number((continuity.uninterrupted.seconds / 3600).toFixed(2));
  console.log(`\ncontinuity  ${describeContinuity(continuity)}\n`);
  if (!continuity.intact) {
    event('finding', 'host suspended during the soak', {
      suspensions: continuity.suspensions,
      backwardsSteps: continuity.backwardsSteps,
      awakeHours,
      wallClockHours: Number((continuity.totalSeconds / 3600).toFixed(2)),
    });
  }

  event('phase', 'soak complete', {
    cycles: cycle,
    analyses: done.length,
    findings,
    elapsedHours: Number(((Date.now() - started) / 3600000).toFixed(2)),
    awakeHours,
    continuous: continuity.intact,
  });
  writeFileSync(
    join(OUT, 'SUMMARY.json'),
    JSON.stringify(
      {
        cycles: cycle,
        analyses: done.length,
        findings,
        started: new Date(started).toISOString(),
        ended: iso(),
        requestedHours: HOURS,
        awakeHours,
        continuity,
      },
      null,
      2,
    ),
  );

  /*
   * ⛔ A release soak must be **uninterrupted** — that is the whole claim it makes. Exiting
   * non-zero is what stops a suspended run from being written up as a GO.
   */
  if (continuity.inconclusive) {
    console.error('⛔ INVALID SOAK — too few metric samples to show the host stayed awake. Not a release soak.');
    process.exit(1);
  }
  if (!continuity.intact || awakeHours < HOURS * 0.95) {
    console.error(
      `⛔ INVALID SOAK — requested ${String(HOURS)} h, the process ran for ${String(awakeHours)} h. ` +
        `This run cannot certify a release; re-run it uninterrupted.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  event('fatal', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
