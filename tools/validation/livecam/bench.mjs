/**
 * Live-ingest benchmark and back-pressure driver (P-9).
 *
 * ### ⭐ Why this is a script and not the browser page
 *
 * The page deliberately keeps **one** upload in flight, because that is the only way `uploadMs`
 * means "how long the network took" rather than "how long we made ourselves wait". Proving what
 * happens when the pipeline is *overloaded* needs the opposite: many frames in flight, at a rate no
 * operator would choose, sustained long enough for a queue to fill. Doing that from the page would
 * mean shipping a control whose only purpose is to break the deployment.
 *
 * ⚠️ Everything downstream of the POST is identical to the page's path — same route, same gateway,
 * same `FrameSink.push`, same runtime. The only difference is the rate and the concurrency, which is
 * exactly the variable under test.
 *
 * ### Modes
 *
 *   pressure — baseline → overload → recovery, sampling queue depth, drops, frame age and latency
 *   fps      — 1, 2, 4, 8, 15 fps in turn, each with CPU, memory, detection and tracking measured
 *   soak     — one long continuous run, watching for leaks, queue growth and latency drift
 *
 *   node bench.mjs <mode> --camera <id> --frames <dir> [--seconds N] [--out file.json]
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { analyseContinuity, describeContinuity, sliceUninterrupted } from '../lib/continuity.mjs';

const execFileAsync = promisify(execFile);

/* Caddy's internal CA — same reasoning as `playwright.config.ts`'s `ignoreHTTPSErrors`. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const args = process.argv.slice(2);
const MODE = args[0] ?? 'pressure';
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';
const CAMERA = flag('camera', process.env.VIP_LIVE_CAMERA ?? '');
const FRAMES_DIR = flag('frames', '');
const OUT = flag('out', `/tmp/livecam-${MODE}.json`);
const SECONDS = Number(flag('seconds', 0));

if (CAMERA === '' || FRAMES_DIR === '') {
  console.error('⛔ --camera <id> and --frames <dir of jpg> are required.');
  process.exit(2);
}

const CONTAINERS = ['vip-prod-media-1', 'vip-prod-inference-1', 'vip-prod-events-1', 'vip-prod-rules-1'];

/* ── platform access ───────────────────────────────────────────────────────────────────────────── */

let token = '';
async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed: ${JSON.stringify(body)}`);
  token = body.data.accessToken;
}

const H = () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  'x-tenant-id': TENANT,
});

/**
 * ⛔ **Both of these re-authenticate on a 401, and the soak is why.**
 *
 * The access token does not last thirty minutes. Without a refresh, a 30-minute soak read
 * **`sent=3598 rejected=3601`** — the first fifteen minutes sent real frames and the second fifteen
 * sent nothing but 401s, at exactly the cadence a healthy run has. ⚠️ **Nothing looked wrong while it
 * happened**: the loop kept its rate, the queue stayed at zero, and `docker stats` dutifully recorded
 * an idle deployment. The drift analysis then compared a first tenth under load against a last tenth
 * under none, and would have reported memory *falling* over the run as evidence of no leak.
 *
 * One retry per call. A loop would turn a genuinely wrong password into an infinite one.
 */
async function get(path, retry = true) {
  const res = await fetch(`${BASE}/api${path}`, { headers: H() });
  if (res.status === 401 && retry) {
    await login();
    return get(path, false);
  }
  const body = await res.json().catch(() => ({}));
  return res.ok ? body.data : null;
}

async function post(path, body, retry = true) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: H(),
    body: JSON.stringify(body ?? {}),
  });
  if (res.status === 401 && retry) {
    await login();
    return post(path, body, false);
  }
  const parsed = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: parsed.data, error: parsed.error };
}

/**
 * Container CPU and memory.
 *
 * ⛔ **This was `execFileSync` and it corrupted every throughput number in the report.**
 *
 * `docker stats --no-stream` takes about a second to answer, and `execFileSync` blocks the **whole
 * Node event loop** for that second — so the send loop's timers did not fire, its in-flight uploads
 * did not resolve, and the next tick found `inflight` still set and recorded `skipped-busy`.
 *
 * ⚠️ **The signature that gave it away was the constancy.** Achieved frame rate was ~70 % of target
 * at 1, 2, 4, 8 **and** 15 fps. A platform limit does not scale perfectly with the load you offer
 * it; a fixed overhead does. At 4 s intervals over 60 s, fifteen blocking samples ate ~25 % of the
 * run, and 9 skips appeared even at **1 fps**, where a 16 ms upload cannot possibly collide with a
 * 1000 ms interval.
 *
 * ⛔ The lesson is S-4 from the release soak, and this file already carried a comment stating it —
 * *"a sampler that stalls the thing it measures reports the stall as the measurement"* — written
 * directly above a synchronous call. Knowing the rule is not the same as obeying it.
 *
 * `execFile` promisified does not block the loop: the child runs while the sender keeps sending.
 */
async function containerStats() {
  try {
    const { stdout: raw } = await execFileAsync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...CONTAINERS],
      { encoding: 'utf8' },
    );
    const out = {};
    for (const line of raw.trim().split('\n')) {
      const [name, cpu, mem] = line.split('\t');
      if (name === undefined) continue;
      const short = name.replace('vip-prod-', '').replace('-1', '');
      out[short] = {
        cpuPercent: Number((cpu ?? '0').replace('%', '')),
        memMiB: parseMem((mem ?? '').split(' / ')[0] ?? ''),
      };
    }
    return out;
  } catch {
    return null; /* ⚠️ null, never a zeroed record — ADR-0039. */
  }
}

function parseMem(text) {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (unit.startsWith('gi')) return n * 1024;
  if (unit.startsWith('mi')) return n;
  if (unit.startsWith('ki')) return n / 1024;
  return null;
}

/* ── measurement helpers ───────────────────────────────────────────────────────────────────────── */

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const stats = (arr) =>
  arr.length === 0
    ? null
    : {
        count: arr.length,
        min: Math.min(...arr),
        avg: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)),
        p95: pct(arr, 95),
        max: Math.max(...arr),
      };

/** Per-camera pipeline metrics — the platform's own view of the queue. */
async function pipelineFor() {
  const rows = await get('/media/perception/assignment/cameras');
  return (rows ?? []).find((r) => r.cameraId === CAMERA) ?? null;
}

async function trackingFor() {
  const listing = await get('/tracking/cameras');
  return (listing?.cameras ?? []).find((c) => c.cameraId === CAMERA) ?? null;
}

/* ── the frame corpus ──────────────────────────────────────────────────────────────────────────── */

const files = readdirSync(FRAMES_DIR)
  .filter((f) => f.endsWith('.jpg'))
  .sort();
const CORPUS = files.map((f) => readFileSync(join(FRAMES_DIR, f)).toString('base64'));
if (CORPUS.length === 0) {
  console.error(`⛔ no .jpg frames in ${FRAMES_DIR}`);
  process.exit(2);
}
const BYTES = files.reduce((a, f) => a + readFileSync(join(FRAMES_DIR, f)).byteLength, 0) / files.length;

/**
 * Send frames for a phase.
 *
 * ⚠️ The cadence is anchored to the phase start, not to the previous send — the same anti-drift rule
 * the browser loop uses, and for the same reason: without it, "15 fps" measured over 90 s is really
 * 13.4 fps and every conclusion about back-pressure is drawn at the wrong load.
 */
async function sendPhase({ label, fps, seconds, maxInflight, sampler }) {
  const started = Date.now();
  const interval = 1000 / fps;
  const uploads = [];
  let inflight = 0;
  let sent = 0;
  let rejected = 0;
  let skippedBusy = 0;
  let cursor = 0;
  let tick = 0;

  while ((Date.now() - started) / 1000 < seconds) {
    if (inflight >= maxInflight) {
      skippedBusy += 1;
    } else {
      inflight += 1;
      const image = CORPUS[cursor % CORPUS.length];
      cursor += 1;
      const at = Date.now();
      void post(`/media/live/${CAMERA}/frame`, { image, capturedAtMs: at })
        .then((r) => {
          uploads.push(Date.now() - at);
          if (r.ok) sent += 1;
          else rejected += 1;
        })
        .catch(() => {
          rejected += 1;
        })
        .finally(() => {
          inflight -= 1;
        });
    }
    tick += 1;
    const due = started + tick * interval;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  }
  /* Let the tail settle so the phase's own numbers are complete before the next phase starts. */
  const settleUntil = Date.now() + 3_000;
  while (inflight > 0 && Date.now() < settleUntil) await new Promise((r) => setTimeout(r, 50));

  const elapsed = (Date.now() - started) / 1000;
  /*
   * ⭐ **The harness grades its own measurement.** `skipped-busy` at a rate whose interval dwarfs
   * the upload time cannot be the platform — it is the driver failing to offer the load it claims.
   * Reporting the achieved rate without this ratio is how "the platform manages 70 % of target"
   * gets written down about a blocked event loop (see `containerStats`).
   */
  const offered = sent + rejected + skippedBusy;
  const skipRatio = offered === 0 ? null : skippedBusy / offered;
  return {
    label,
    targetFps: fps,
    maxInflight,
    seconds: Number(elapsed.toFixed(1)),
    sent,
    rejected,
    skippedBusy,
    skipRatio: skipRatio === null ? null : Number(skipRatio.toFixed(3)),
    /** ⚠️ True when the driver, not the deployment, bounded the rate. */
    harnessBound: skipRatio !== null && skipRatio > 0.05 && maxInflight === 1 && fps <= 8,
    achievedFps: Number((sent / elapsed).toFixed(2)),
    uploadMs: stats(uploads),
    samples: sampler.take(),
  };
}

/**
 * Samples the platform's queue view on its own timer.
 *
 * ⭐ Started once and shared across phases, so the recovery curve is continuous — a sampler
 * restarted per phase would produce three disconnected series and lose the very thing being proved,
 * which is that the queue *comes back down*.
 */
function startSampler(intervalMs = 2_000) {
  const rows = [];
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      const at = new Date().toISOString();
      const pipeline = await pipelineFor();
      rows.push({
        at,
        queueDepth: pipeline?.queueDepth ?? null,
        droppedQueueFull: pipeline?.framesDroppedQueueFull ?? null,
        delivered: pipeline?.framesDelivered ?? null,
        offered: pipeline?.framesOffered ?? null,
        processingFps: pipeline?.processingFps ?? null,
        processingLatencyMs: pipeline?.processingLatencyMs ?? null,
        activeTracks: pipeline?.activeTracks ?? null,
      });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void tick();
  let taken = 0;
  return {
    stop: () => {
      stopped = true;
    },
    all: () => rows,
    /** Rows since the last `take()` — the slice belonging to the phase that just ended. */
    take: () => {
      const slice = rows.slice(taken);
      taken = rows.length;
      return slice;
    },
  };
}

/** Resource sampler, on its own slow timer so `docker stats` never blocks the send loop. */
function startResourceSampler(intervalMs = 5_000) {
  const rows = [];
  let stopped = false;
  const tick = async () => {
    while (!stopped) {
      const sample = await containerStats();
      if (sample !== null) rows.push({ at: new Date().toISOString(), ...sample });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
    all: () => rows,
  };
}

function summariseResources(rows, key) {
  const out = {};
  for (const service of ['media', 'inference', 'events', 'rules']) {
    const values = rows.map((r) => r[service]?.[key]).filter((v) => typeof v === 'number');
    out[service] = stats(values);
  }
  return out;
}

/* ── modes ─────────────────────────────────────────────────────────────────────────────────────── */

await login();

async function openSession(fps) {
  const r = await post(`/media/live/${CAMERA}/open`, {
    frameRate: Math.min(60, Math.max(1, Math.round(fps))),
    agent: `bench-${MODE}`,
    width: 640,
    height: 360,
  });
  if (!r.ok) throw new Error(`open failed: ${JSON.stringify(r.error)}`);
  return r.data;
}
const closeSession = () => post(`/media/live/${CAMERA}/close`, {});

if (MODE === 'pressure') {
  /*
   * ⭐ Three phases and the middle one is meant to hurt. The claim being tested is not "the pipeline
   * never drops" — it is designed to drop, and says so in `FrameSink`'s header. The claim is that it
   * drops the RIGHT frames, keeps serving, and **recovers** — which cannot be shown by an overload
   * phase alone. A test that only overloads proves the system breaks; it takes the third phase to
   * prove it comes back.
   */
  const sampler = startSampler(2_000);
  const resources = startResourceSampler(5_000);
  const phases = [];

  await openSession(4);
  phases.push(await sendPhase({ label: 'baseline', fps: 4, seconds: 60, maxInflight: 1, sampler }));
  phases.push(await sendPhase({ label: 'overload', fps: 25, seconds: 90, maxInflight: 12, sampler }));
  phases.push(await sendPhase({ label: 'recovery', fps: 4, seconds: 90, maxInflight: 1, sampler }));
  await closeSession();

  sampler.stop();
  resources.stop();
  const tracking = await trackingFor();
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        mode: 'pressure',
        camera: CAMERA,
        frameBytesAvg: Math.round(BYTES),
        at: new Date().toISOString(),
        phases,
        series: sampler.all(),
        resources: resources.all(),
        resourceSummary: {
          cpuPercent: summariseResources(resources.all(), 'cpuPercent'),
          memMiB: summariseResources(resources.all(), 'memMiB'),
        },
        trackingAfter: tracking,
      },
      null,
      2,
    ),
  );
  for (const p of phases) {
    console.log(
      `${p.label.padEnd(9)} target=${String(p.targetFps)}fps inflight=${String(p.maxInflight)} ` +
        `sent=${String(p.sent)} (${String(p.achievedFps)} fps) rejected=${String(p.rejected)} ` +
        `skipped=${String(p.skippedBusy)}${p.harnessBound ? ' ⛔HARNESS-BOUND' : ''} ` +
        `upload p95=${String(p.uploadMs?.p95 ?? '—')}ms ` +
        `queue max=${String(Math.max(0, ...p.samples.map((s) => s.queueDepth ?? 0)))} ` +
        `drops+${String(
          (p.samples.at(-1)?.droppedQueueFull ?? 0) - (p.samples[0]?.droppedQueueFull ?? 0),
        )}`,
    );
  }
  console.log(`\nwritten to ${OUT}`);
} else if (MODE === 'fps') {
  /*
   * ⚠️ Each rate gets its own ingest session, and the gap between them exceeds the tracker's
   * `reentryGapSeconds` (12 s). Without the gap, the last subject of one rate is linked as a
   * re-entry of the first subject of the next, and the recovery counts become a property of the
   * benchmark rather than of the footage.
   */
  const perRate = [];
  for (const fps of [1, 2, 4, 8, 15]) {
    const sampler = startSampler(2_000);
    const resources = startResourceSampler(4_000);
    const before = await trackingFor();
    await openSession(fps);
    const seconds = SECONDS > 0 ? SECONDS : 60;
    const phase = await sendPhase({ label: `${String(fps)}fps`, fps, seconds, maxInflight: 1, sampler });
    await closeSession();
    await new Promise((r) => setTimeout(r, 6_000));
    const after = await trackingFor();
    sampler.stop();
    resources.stop();
    const d = (k) => (before === null || after === null ? null : (after[k] ?? 0) - (before[k] ?? 0));
    perRate.push({
      ...phase,
      tracking: {
        framesTracked: d('framesTracked'),
        createdTracks: d('createdTracks'),
        recoveredTracks: d('recoveredTracks'),
        occlusionsSurvived: d('occlusionsSurvived'),
        outOfOrderFrames: d('outOfOrderFrames'),
        averageTrackingMs: after?.averageTrackingMs ?? null,
      },
      pipeline: await pipelineFor(),
      cpuPercent: summariseResources(resources.all(), 'cpuPercent'),
      memMiB: summariseResources(resources.all(), 'memMiB'),
    });
    console.log(
      `${String(fps).padStart(2)} fps  sent=${String(phase.sent)} achieved=${String(phase.achievedFps)} ` +
        `skipped=${String(phase.skippedBusy)}${phase.harnessBound ? ' ⛔HARNESS-BOUND' : ''} ` +
        `upload p95=${String(phase.uploadMs?.p95 ?? '—')}ms ` +
        `inference cpu avg=${String(perRate.at(-1).cpuPercent.inference?.avg ?? '—')}% ` +
        `tracks+${String(perRate.at(-1).tracking.createdTracks)}`,
    );
    /* Longer than `reentryGapSeconds` — see above. */
    await new Promise((r) => setTimeout(r, 15_000));
  }
  writeFileSync(
    OUT,
    JSON.stringify({ mode: 'fps', camera: CAMERA, at: new Date().toISOString(), perRate }, null, 2),
  );
  console.log(`\nwritten to ${OUT}`);
} else if (MODE === 'soak') {
  /*
   * ⛔ **Refuse to start if this camera already has a live session, and the reason is a corrupted
   * run.** `LiveIngest.open()` deliberately REPLACES the session for a camera, so a second sender
   * does not fail — both post into one session and the platform ingests at twice the target rate.
   * Measured: a soak targeting 4 fps was ingesting **8.00 fps** because a duplicate process was
   * running, and every drift, latency and CPU figure would have described a load nobody chose.
   *
   * ⚠️ The `sent` vs `framesAccepted` cross-check at the end catches the same thing from the other
   * side — a sender that posted 7200 frames into a session the platform counted 14400 of has a
   * companion it does not know about.
   */
  const existing = await get('/media/live/sessions');
  const clash = (existing ?? []).find((x) => x.cameraId === CAMERA);
  if (clash !== undefined) {
    console.error(
      `⛔ camera ${CAMERA} already has a live session (agent "${String(clash.agent)}", ` +
        `${String(clash.framesAccepted)} frames). Stop it first — a second sender would double the ` +
        `ingest rate and silently invalidate this run.`,
    );
    process.exit(2);
  }
  /*
   * ⭐ A long continuous run. What is being watched is not throughput — it is **drift**: memory that
   * only rises, a queue that never returns to zero, a latency that is 30 % worse in the last ten
   * minutes than the first. Each of those is invisible in a 60-second run and fatal in a customer
   * deployment that stays up for a month.
   */
  const seconds = SECONDS > 0 ? SECONDS : 1_800;
  const sampler = startSampler(5_000);
  const resources = startResourceSampler(10_000);
  const before = await trackingFor();
  await openSession(4);
  const phase = await sendPhase({ label: 'soak', fps: 4, seconds, maxInflight: 1, sampler });
  await closeSession();
  const after = await trackingFor();
  sampler.stop();
  resources.stop();

  /*
   * ⛔ **Did the host stay awake?** Asked before anything is derived, because every figure below
   * divides work by wall-clock time. The 2026-08-08 run sent 7181 frames at a true 4.000 fps, the
   * laptop then suspended for 966 s, and the summary recorded `2.6 fps` — a shortfall that never
   * happened, past both the rejected-frame guard and the duplicate-sender guard.
   */
  const allSeries = sampler.all();
  const allRows = resources.all();
  const continuity = {
    frames: analyseContinuity({ samples: allSeries, intervalMs: 5_000 }),
    resources: analyseContinuity({ samples: allRows, intervalMs: 10_000 }),
  };
  console.log(`\ncontinuity (queue sampler)    ${describeContinuity(continuity.frames)}`);
  console.log(`continuity (resource sampler) ${describeContinuity(continuity.resources)}\n`);

  /*
   * ⭐ Analyse the window the process was demonstrably awake for. Deriving drift across a
   * suspension compares the minutes before a freeze with the minutes after a thaw and calls the
   * difference a trend.
   */
  const rows = sliceUninterrupted({ samples: allRows, intervalMs: 10_000 });
  const series = sliceUninterrupted({ samples: allSeries, intervalMs: 5_000 });

  /* ⭐ First tenth vs last tenth. A single average over 30 minutes hides a monotone rise entirely. */
  const slice = (arr, from, to) => arr.slice(Math.floor(arr.length * from), Math.floor(arr.length * to));
  const drift = {};
  for (const service of ['media', 'inference', 'events', 'rules']) {
    const mem = rows.map((r) => r[service]?.memMiB).filter((v) => typeof v === 'number');
    drift[service] = {
      memFirstTenthAvg: stats(slice(mem, 0, 0.1))?.avg ?? null,
      memLastTenthAvg: stats(slice(mem, 0.9, 1))?.avg ?? null,
    };
  }
  const lat = series.map((s) => s.processingLatencyMs).filter((v) => typeof v === 'number');
  /*
   * The rate the sender actually sustained, over the time it was actually running. Kept beside the
   * wall-clock figure rather than replacing it, so a reader can see the gap the guard is about.
   */
  const awakeSeconds = continuity.frames.uninterrupted.seconds;
  const achievedFpsUninterrupted =
    continuity.frames.inconclusive || awakeSeconds <= 0 ? null : Number((phase.sent / awakeSeconds).toFixed(3));
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        mode: 'soak',
        camera: CAMERA,
        at: new Date().toISOString(),
        requestedSeconds: seconds,
        /* ⚠️ `phase.seconds` and `phase.achievedFps` are wall-clock. Read these two beside them. */
        continuity,
        awakeSeconds,
        achievedFpsUninterrupted,
        phase,
        drift,
        latencyFirstTenth: stats(slice(lat, 0, 0.1)),
        latencyLastTenth: stats(slice(lat, 0.9, 1)),
        queueMax: Math.max(0, ...series.map((s) => s.queueDepth ?? 0)),
        tracking: {
          before,
          after,
          createdTracks: before === null || after === null ? null : after.createdTracks - before.createdTracks,
          recoveredTracks:
            before === null || after === null ? null : after.recoveredTracks - before.recoveredTracks,
          outOfOrderFrames:
            before === null || after === null ? null : after.outOfOrderFrames - before.outOfOrderFrames,
        },
        /*
         * ⚠️ The **full** series is persisted, including anything recorded after a suspension —
         * the derived tables above use the uninterrupted window, and a reader must be able to see
         * the difference rather than take this file's word for it.
         */
        analysed: { frameSamples: series.length, resourceSamples: rows.length },
        series: allSeries,
        resources: allRows,
      },
      null,
      2,
    ),
  );
  console.log(
    `soak wall=${String(phase.seconds)}s awake=${String(awakeSeconds)}s sent=${String(phase.sent)} ` +
      `fps=${String(achievedFpsUninterrupted ?? phase.achievedFps)} rejected=${String(phase.rejected)} ` +
      `queueMax=${String(Math.max(0, ...series.map((s) => s.queueDepth ?? 0)))}`,
  );
  console.log(`written to ${OUT}`);
  /*
   * ⛔ **The run grades itself, because the failure mode is silent.** A soak whose frames were
   * refused kept its cadence, kept its queue at zero and recorded an idle deployment — and the drift
   * analysis would have read "memory fell over 30 minutes" as good news. Anything above 1 % refused
   * means the numbers above describe a run that did not happen.
   */
  /*
   * ⭐ The other half of the duplicate-sender guard: the platform's own count of what it accepted for
   * this session, against what this process sent. They must agree.
   */
  const sessionNow = ((await get('/media/live/sessions')) ?? []).find((x) => x.cameraId === CAMERA);
  const platformAccepted = sessionNow?.framesAccepted ?? null;
  if (platformAccepted !== null && platformAccepted > phase.sent * 1.05) {
    console.error(
      `\n⛔ INVALID RUN — the platform accepted ${String(platformAccepted)} frames for this session ` +
        `but this process sent ${String(phase.sent)}. Another sender was feeding the same camera; ` +
        `every figure above describes a load nobody chose. Do not report them.`,
    );
    process.exit(1);
  }

  const refusedRatio = phase.sent + phase.rejected === 0 ? 1 : phase.rejected / (phase.sent + phase.rejected);
  if (refusedRatio > 0.01) {
    console.error(
      `\n⛔ INVALID RUN — ${(refusedRatio * 100).toFixed(1)} % of frames were refused. ` +
        `The drift and latency figures above describe a deployment that was not under load. Do not report them.`,
    );
    process.exit(1);
  }

  /*
   * ⛔ **Third guard: was the process running for the soak it claims to have run?** A soak is a
   * question about *duration*, so a host that suspends does not slow the run down — it removes the
   * part of the run that had not happened yet, while leaving a full-looking file behind.
   *
   * ⚠️ Deliberately judged on the awake window against the *requested* duration, not on whether a
   * suspension occurred at all. The 2026-08-08 run suspended after the sender had finished its full
   * 1800 s, so its measurements stand and only its wall-clock summary fields were wrong. A run that
   * froze at minute six is a six-minute soak and must not be reported as thirty.
   */
  if (continuity.frames.inconclusive) {
    console.error(
      `\n⛔ INVALID RUN — the queue sampler produced ${String(continuity.frames.sampleCount)} sample(s), ` +
        `too few to show the host stayed awake. Nothing here can be reported as a soak.`,
    );
    process.exit(1);
  }
  if (awakeSeconds < seconds * 0.9) {
    console.error(
      `\n⛔ INVALID RUN — the process ran for ${String(awakeSeconds)} s of a requested ${String(seconds)} s ` +
        `(${describeContinuity(continuity.frames)}). This is a ${(awakeSeconds / 60).toFixed(0)}-minute soak ` +
        `wearing a ${(seconds / 60).toFixed(0)}-minute file. Re-run on a host that will not sleep — on macOS, ` +
        `prefix the command with \`caffeinate -dimsu\`.`,
    );
    process.exit(1);
  }
  if (!continuity.frames.intact) {
    console.error(
      `\n⚠️ The measurements stand — the sender completed its ${String(seconds)} s before the host froze — ` +
        `but this run's wall-clock fields are wrong and must not be quoted: ` +
        `${describeContinuity(continuity.frames)}`,
    );
  }
} else {
  console.error(`⛔ unknown mode "${MODE}" — expected pressure | fps | soak`);
  process.exit(2);
}
