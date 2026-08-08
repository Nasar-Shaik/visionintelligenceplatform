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
  });
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
