/**
 * **The customer journey, driven against the deployed product** (P-8.5 Product Validation, step 3).
 *
 *   node tools/validation/validate.mjs                      # the standard set
 *   node tools/validation/validate.mjs --clips=crowd,blur    # named clips
 *   node tools/validation/validate.mjs --all                 # every clip in the manifest
 *   node tools/validation/validate.mjs --concurrent=5        # N uploads at once
 *   node tools/validation/validate.mjs --out=artifacts/run.json
 *
 * ### ⭐ Why this exists when there are already 300 media tests
 *
 * Every one of those runs against a double. They prove the code is right. This uploads a real file
 * over TLS to a real object store, has real ffmpeg decode it, real ONNX look at it, and real Mongo
 * and NATS carry the result — and it is the only thing in the repository that can find a defect
 * living in the *joins* between those. Every serious defect in P-8 was of that kind: a presigned URL
 * signed for the wrong audience, a dedup key that a rerun collided with, a msgId the broker
 * discarded. Not one was visible to a unit test.
 *
 * ### ⛔ What it refuses to do
 *
 * It does not assert. It **measures and reports**. A journey that fails is recorded with its stage,
 * its HTTP status and its body, and the run continues to the next clip — because the second failure
 * is usually what explains the first, and a harness that stops at the first one hides it. The
 * judgement about what is a defect belongs in the validation document, written by a human reading
 * this output.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(ROOT, 'infra/docker/fixtures/media');
const MANIFEST = join(FIXTURES, 'validation/manifest.json');

const BASE = process.env.BASE ?? 'https://localhost';
const TENANT = process.env.TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.PASSWORD ?? '12345678';
const CAMERA = process.env.CAMERA ?? 'cam_retail_entrance';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const ALL = process.argv.includes('--all');
const CLIPS = arg('clips', null);
const CONCURRENT = Number(arg('concurrent', '1'));
const OUT = arg('out', null);
const FRAME_RATE = Number(arg('fps', '2'));
const SPEED = arg('speed', null);
/** ⚠️ Generous. A 5-minute clip at 2 fps is 600 frames, and the deployment analyses ~2 fps wall. */
const TIMEOUT_MS = Number(arg('timeout', '900')) * 1000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** The default set: one per behaviour a customer would recognise, not one per fixture. */
const STANDARD = [
  'single-person-walking',
  'multiple-people',
  'retail-loitering',
  'crowd',
  'empty-scene',
  'night-footage',
  'occlusion',
  'long-recording',
];

const now = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = '';
const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authed(), ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  token = body?.data?.accessToken ?? '';
  if (!token) throw new Error(`login failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

/**
 * Sample container CPU and memory.
 *
 * ⚠️ `docker stats --no-stream` costs about a second, so it is sampled at the boundaries of a stage
 * rather than continuously — enough for a baseline, not enough to catch a transient spike, and the
 * baseline document says so rather than implying otherwise.
 */
function sampleResources() {
  try {
    const raw = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}',
       'vip-prod-media-1', 'vip-prod-inference-1', 'vip-prod-events-1', 'vip-prod-mongodb-1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const out = {};
    for (const line of raw.trim().split('\n')) {
      const [name, cpu, mem] = line.split('\t');
      out[name.replace('vip-prod-', '').replace('-1', '')] = {
        cpuPercent: Number(cpu.replace('%', '')),
        memory: mem.split(' / ')[0],
      };
    }
    return out;
  } catch {
    return null;
  }
}

/** Bytes currently held in the recordings bucket — storage growth, measured not estimated. */
function storageBytes() {
  try {
    const raw = execFileSync(
      'docker', ['exec', 'vip-prod-minio-1', 'sh', '-c', 'du -sb /data 2>/dev/null | cut -f1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return Number(raw.trim());
  } catch {
    return null;
  }
}

/* ─────────────────────────  one journey  ───────────────────────── */

/**
 * The fourteen steps, in the order a customer performs them.
 *
 * Each stage records how long it took and what it returned. A stage that fails sets `failedAt` and
 * the journey stops — the later stages have nothing to act on — but the run continues with the next
 * clip.
 */
async function journey(clip, opts = {}) {
  const label = opts.label ?? clip.id;
  const file = join(FIXTURES, clip.file);
  const bytes = statSync(file).size;
  const j = {
    clip: clip.id,
    label,
    file: clip.file,
    bytes,
    intent: clip.intent ?? null,
    measuredInFixture: clip.measured ?? null,
    timings: {},
    stages: {},
    findings: [],
  };
  const fail = (stage, detail) => {
    j.failedAt = stage;
    j.error = detail;
    return j;
  };
  /*
   * ⚠️ Sampled before the UPLOAD, not before the analysis. The first version measured only across
   * the analysis stage and reported 0 bytes every time — which is correct (offline analysis writes
   * nothing but its session document) and completely useless as a storage-growth baseline, because
   * what actually consumes a customer's disk is the recording they uploaded and the stills they
   * later capture.
   */
  const storageAtJourneyStart = storageBytes();

  /* 1 — create the analysis and claim an upload slot */
  let t = now();
  const created = await api('/api/media/analyses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cameraId: CAMERA,
      label: `P-8.5 ${label}`,
      originalName: `${clip.id}.mp4`,
      contentType: 'video/mp4',
      bytes,
      /* ⚠️ A fixed footage start, so two runs of the same clip land on the same footage clock and a
       * rerun is genuinely comparable. Letting it default to upload time would make every run's
       * timestamps different and every comparison meaningless. */
      footageStartedAt: '2026-02-14T18:30:00.000Z',
    }),
  });
  j.timings.createMs = now() - t;
  if (created.status !== 201) return fail('create', `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  const analysisId = created.body.data.analysis.id;
  const uploadUrl = created.body.data.uploadUrl;
  j.analysisId = analysisId;
  j.stages.create = { status: 201, analysisId };

  /* 2 — put the bytes straight at the object store (ADR-0036: never through the gateway) */
  t = now();
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': created.body.data.contentType },
    body: readFileSync(file),
  });
  j.timings.uploadMs = now() - t;
  j.timings.uploadMbps = bytes / 1024 / 1024 / (j.timings.uploadMs / 1000);
  if (!put.ok) return fail('upload', `HTTP ${put.status} ${(await put.text()).slice(0, 300)}`);
  j.stages.upload = { status: put.status, bytes, mbps: Number(j.timings.uploadMbps.toFixed(2)) };

  /* 3 — confirm: the service probes the object and refuses what it cannot decode */
  t = now();
  const confirmed = await api(`/api/media/analyses/${analysisId}/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  j.timings.prepareMs = now() - t;
  if (confirmed.status !== 200) {
    j.stages.confirm = { status: confirmed.status, body: confirmed.body };
    return fail('confirm', `HTTP ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 400)}`);
  }
  const asset = confirmed.body.data.asset ?? {};
  j.stages.confirm = {
    status: 200,
    codec: asset.codec,
    codecTag: asset.codecTag,
    width: asset.width,
    height: asset.height,
    sourceFrameRate: asset.sourceFrameRate,
    durationSeconds: asset.durationSeconds,
    findings: confirmed.body.data.findings ?? [],
  };
  /* ⚠️ A probe that disagrees with what the generator measured is a real finding about the probe,
   * not a rounding difference to wave through. */
  if (clip.durationSeconds && Math.abs(asset.durationSeconds - clip.durationSeconds) > 0.5) {
    j.findings.push({
      kind: 'functional-bug',
      what: `probe reports ${asset.durationSeconds}s, the file is ${clip.durationSeconds}s`,
    });
  }

  /* 4/5 — start a session and wait for a worker to claim it */
  t = now();
  const sessionBody = { analysisFrameRate: FRAME_RATE };
  if (SPEED !== null) sessionBody.speed = SPEED === 'null' ? null : Number(SPEED);
  const started = await api(`/api/media/analyses/${analysisId}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sessionBody),
  });
  if (started.status !== 201) return fail('session', `HTTP ${started.status} ${JSON.stringify(started.body).slice(0, 300)}`);
  const sessionId = started.body.data.id;
  j.sessionId = sessionId;

  /* 6 — poll to a terminal state, recording when it first started running */
  const before = sampleResources();
  const storageBefore = storageBytes();
  let session = started.body.data;
  let sawRunning = null;
  let progressSamples = 0;
  const deadline = Date.now() + TIMEOUT_MS;
  while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(session.state)) {
    if (Date.now() > deadline) {
      j.stages.analysis = { state: session.state, timedOut: true, progress: session.progress };
      return fail('analysis', `still ${session.state} after ${TIMEOUT_MS / 1000}s`);
    }
    await sleep(1000);
    const detail = await api(`/api/media/analyses/${analysisId}`);
    if (detail.status !== 200) return fail('poll', `HTTP ${detail.status}`);
    const sessions = detail.body.data.sessions ?? [];
    session = sessions.find((s) => s.id === sessionId) ?? session;
    if (sawRunning === null && (session.state === 'running' || session.state === 'starting')) {
      sawRunning = now();
      j.timings.queueWaitMs = sawRunning - t;
    }
    /*
     * ⚠️ Progress must be OBSERVED moving, not assumed. A session that jumps 0 → 100 at the end is
     * a progress bar that tells a customer nothing for the whole run.
     *
     * ⛔ The field is `framesProcessed`. The first version of this harness read `framesAnalysed`,
     * which does not exist — so it reported "progress never moved" and a speed factor of ×0.00 for a
     * run the platform had correctly recorded at ×8.27. A harness that reads a phantom field
     * fabricates a defect in working software, which is the most expensive kind of false alarm.
     */
    if (session.progress && session.progress.framesProcessed > 0) progressSamples += 1;
  }
  j.timings.analysisMs = now() - (sawRunning ?? t);
  j.timings.totalSessionMs = now() - t;
  j.stages.analysis = {
    state: session.state,
    progress: session.progress ?? null,
    findings: session.findings ?? [],
    speed: session.speed ?? null,
    progressSamplesObserved: progressSamples,
    resourcesBefore: before,
    resourcesAfter: sampleResources(),
    storageGrowthBytes: storageBefore !== null && storageBytes() !== null ? storageBytes() - storageBefore : null,
  };
  if (progressSamples === 0 && session.state === 'succeeded') {
    j.findings.push({ kind: 'ux-issue', what: 'progress never reported a non-zero frame count while running' });
  }
  if (session.state !== 'succeeded') {
    return fail('analysis', `session ended ${session.state}: ${JSON.stringify(session.findings ?? []).slice(0, 300)}`);
  }
  /*
   * ⭐ **Both ends are recorded, and they are not the same measurement.**
   *
   * `reported*` is what the platform says about itself — measured inside the worker, over the frames
   * it actually decoded. `observed*` is measured out here, over wall-clock time from the first poll
   * that saw the session running to the one that saw it finish, and it therefore includes queue
   * latency, polling granularity and everything else a customer waits through.
   *
   * The observed figure is always the pessimistic one and it is the honest number for a customer
   * expectation. Keeping both is what makes a divergence visible: a platform reporting ×8 while a
   * customer waits ×1 is a defect that a single number, from either end, would hide completely.
   */
  const framesProcessed = session.progress?.framesProcessed ?? 0;
  j.timings.framesProcessed = framesProcessed;
  j.timings.reportedThroughputFps = session.progress?.throughputFps ?? null;
  j.timings.reportedSpeedFactor = session.progress?.speedFactor ?? null;
  j.timings.observedThroughputFps = framesProcessed / (j.timings.analysisMs / 1000);
  j.timings.observedSpeedFactor = (framesProcessed / FRAME_RATE) / (j.timings.analysisMs / 1000);

  /* 7 — the timeline */
  t = now();
  const timeline = await api(`/api/media/analyses/${analysisId}/timeline`);
  j.timings.timelineMs = now() - t;
  if (timeline.status !== 200) return fail('timeline', `HTTP ${timeline.status} ${JSON.stringify(timeline.body).slice(0, 300)}`);
  const tl = timeline.body.data;
  j.stages.timeline = {
    entries: tl.entries?.length ?? 0,
    tracks: tl.tracks?.length ?? 0,
    density: tl.density?.length ?? 0,
    incidents: tl.incidents?.length ?? 0,
    incidentsAvailable: tl.incidentsAvailable,
    truncated: tl.truncated,
  };

  /* 8 — incidents raised by THIS run, isolated by analysisSessionId */
  t = now();
  const incidents = await api(`/api/workflow/incidents?analysisSessionId=${sessionId}&limit=50`);
  j.timings.incidentsMs = now() - t;
  j.stages.incidents = {
    status: incidents.status,
    count: incidents.status === 200 ? (incidents.body.data.items?.length ?? 0) : null,
  };
  /* ⛔ The isolation guarantee, checked on live data rather than in a unit test: not one incident
   * from this offline run may appear in the queue an operator works from. */
  const liveQueue = await api('/api/workflow/incidents?limit=200');
  if (liveQueue.status === 200) {
    const leaked = (liveQueue.body.data.items ?? []).filter((i) => i.analysisSessionId !== undefined);
    j.stages.incidents.leakedIntoLiveQueue = leaked.length;
    if (leaked.length > 0) {
      j.findings.push({ kind: 'functional-bug', what: `${leaked.length} offline incident(s) visible in the live queue` });
    }
  }

  /* 9 — an evidence still at a real footage offset */
  const offset = Math.min(10, Math.max(1, (clip.durationSeconds ?? 30) / 3));
  t = now();
  const snap = await api(`/api/media/analyses/${analysisId}/snapshots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offsetSeconds: offset }),
  });
  j.timings.snapshotMs = now() - t;
  j.stages.snapshot = { status: snap.status };
  if (snap.status === 201) {
    const s = snap.body.data;
    j.stages.snapshot = {
      status: 201,
      bytes: s.bytes,
      width: s.width,
      height: s.height,
      occurredAt: s.occurredAt,
      registeredAsEvidence: s.registeredAsEvidence,
    };
    /* ⚠️ The URL is fetched. A signed URL that 404s is indistinguishable from a working one until
     * somebody clicks it, and "the API returned 201" is not evidence that a picture exists. */
    const img = await fetch(s.url);
    const blob = await img.arrayBuffer();
    j.stages.snapshot.urlFetch = { status: img.status, bytes: blob.byteLength };
    const isJpeg = blob.byteLength > 2 && new Uint8Array(blob)[0] === 0xff && new Uint8Array(blob)[1] === 0xd8;
    j.stages.snapshot.isJpeg = isJpeg;
    if (!isJpeg) j.findings.push({ kind: 'functional-bug', what: 'the snapshot URL did not return a JPEG' });
  } else {
    j.stages.snapshot.body = snap.body;
  }

  /* 10 — the export report */
  t = now();
  const report = await api(`/api/media/analyses/${analysisId}/report`);
  j.timings.reportMs = now() - t;
  if (report.status !== 200) {
    j.stages.report = { status: report.status, body: report.body };
    return fail('report', `HTTP ${report.status}`);
  }
  const r = report.body.data;
  j.stages.report = {
    status: 200,
    counts: r.counts ?? null,
    incidents: r.incidents?.length ?? 0,
    generatedAt: r.generatedAt,
  };
  /* ⛔ A report that lists an incident above a count of zero contradicts itself — the exact defect
   * slice 7 shipped and the deployment found. Checked on live data forever after. */
  if (r.counts && (r.counts.incidents ?? 0) === 0 && (r.incidents?.length ?? 0) > 0) {
    j.findings.push({ kind: 'functional-bug', what: 'the report lists incidents above a count of zero' });
  }

  /* 11 — playback, the thing P-5.8 found had never worked outside `pnpm dev` */
  t = now();
  const playback = await api(`/api/media/analyses/${analysisId}/playback`);
  j.timings.playbackMs = now() - t;
  j.stages.playback = { status: playback.status };
  if (playback.status === 200) {
    const head = await fetch(playback.body.data.url, { method: 'GET', headers: { range: 'bytes=0-1023' } });
    j.stages.playback.mediaFetch = { status: head.status, contentType: head.headers.get('content-type') };
    if (head.status !== 206 && head.status !== 200) {
      j.findings.push({ kind: 'functional-bug', what: `playback URL returned HTTP ${head.status}` });
    }
  }

  j.storage = {
    atJourneyStartBytes: storageAtJourneyStart,
    growthBytes: storageAtJourneyStart !== null ? storageBytes() - storageAtJourneyStart : null,
    /* ⚠️ Growth is expected to EXCEED the uploaded file: the recording, plus the still, plus
     * whatever the store's own metadata costs. A growth of exactly `bytes` would mean the snapshot
     * never landed. */
    uploadedBytes: bytes,
  };
  j.ok = true;
  return j;
}

/* ─────────────────────────  run  ───────────────────────── */

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const byId = new Map(manifest.clips.map((c) => [c.id, c]));

/*
 * ⚠️ The duration ladder is **not** in the manifest, and deliberately so: those files are hundreds
 * of megabytes, generated on demand for a performance run and deleted afterwards, so a manifest
 * entry for them would be a permanent claim about a file that usually does not exist. They are
 * synthesised here from what is on disk, and carry no `measured` ground truth because nobody probed
 * them — which is the honest state for a fixture built by looping another one.
 */
function ladderClip(id) {
  const file = `validation/large/${id}.mp4`;
  const abs = join(FIXTURES, file);
  if (!existsSync(abs)) return null;
  const minutes = Number(/duration-(\d+)min/.exec(id)?.[1] ?? 0);
  return {
    id,
    file,
    title: `${minutes} minutes of footage`,
    category: 'duration-ladder',
    durationSeconds: minutes * 60,
    bytes: statSync(abs).size,
  };
}

const requested = ALL ? manifest.clips.map((c) => c.id) : CLIPS ? CLIPS.split(',') : STANDARD;
const selected = requested.map((id) => byId.get(id) ?? ladderClip(id)).filter(Boolean);
const missing = requested.filter((id) => !byId.has(id) && ladderClip(id) === null);
if (missing.length > 0) {
  console.error(`\n⛔ unknown clip(s): ${missing.join(', ')}`);
  console.error('   run `node tools/dataset/generate.mjs --verify` (and `large.mjs` for the ladder)\n');
  process.exit(2);
}

console.log(`\nVIP product validation — ${selected.length} clip(s), concurrency ${CONCURRENT}\n`);
await login();
console.log(`  ✓ signed in as ${EMAIL}\n`);

const runStart = now();
const storageAtStart = storageBytes();
const journeys = [];

if (CONCURRENT <= 1) {
  for (const clip of selected) {
    process.stdout.write(`  ${clip.id.padEnd(24)} `);
    const j = await journey(clip);
    journeys.push(j);
    console.log(
      j.ok
        ? `✓ ${(j.timings.analysisMs / 1000).toFixed(1)}s · ${j.timings.framesProcessed} frames · ` +
          `${j.stages.timeline.entries} events · ${j.stages.timeline.tracks} tracks · ${j.stages.incidents.count} inc · ` +
          `×${j.timings.observedSpeedFactor.toFixed(1)} obs / ×${(j.timings.reportedSpeedFactor ?? 0).toFixed(1)} rep`
        : `✗ failed at ${j.failedAt}: ${String(j.error).slice(0, 120)}`,
    );
  }
} else {
  /*
   * ⚠️ Concurrency is the point of this branch, so every journey starts before any is awaited.
   * `maxConcurrent` defaults to 1 in the runner (L-41), so what is measured here is the QUEUE
   * behaving correctly under load — not parallel analysis, which the deployment does not do.
   */
  const batches = [];
  for (let i = 0; i < selected.length; i += CONCURRENT) batches.push(selected.slice(i, i + CONCURRENT));
  for (const batch of batches) {
    const settled = await Promise.all(batch.map((c, n) => journey(c, { label: `${c.id}#${n + 1}` })));
    for (const j of settled) {
      journeys.push(j);
      console.log(`  ${j.label.padEnd(28)} ${j.ok ? `✓ ${(j.timings.analysisMs / 1000).toFixed(1)}s` : `✗ ${j.failedAt}`}`);
    }
  }
}

const summary = {
  at: new Date().toISOString(),
  base: BASE,
  tenant: TENANT,
  camera: CAMERA,
  frameRate: FRAME_RATE,
  concurrency: CONCURRENT,
  wallClockMs: now() - runStart,
  storageGrowthBytes: storageAtStart !== null ? storageBytes() - storageAtStart : null,
  clips: journeys.length,
  succeeded: journeys.filter((j) => j.ok).length,
  failed: journeys.filter((j) => !j.ok).length,
  findings: journeys.flatMap((j) => j.findings.map((f) => ({ clip: j.clip, ...f }))),
  journeys,
};

console.log(`\n  ${summary.succeeded}/${summary.clips} journeys completed`);
if (summary.findings.length > 0) {
  console.log(`\n  findings:`);
  for (const f of summary.findings) console.log(`    ⚠️ [${f.kind}] ${f.clip}: ${f.what}`);
}
for (const j of journeys.filter((x) => !x.ok)) {
  console.log(`\n  ⛔ ${j.clip} failed at ${j.failedAt}\n     ${String(j.error).slice(0, 500)}`);
}

if (OUT) {
  mkdirSync(dirname(join(ROOT, OUT)), { recursive: true });
  writeFileSync(join(ROOT, OUT), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n  → ${OUT}`);
}
console.log('');
process.exit(summary.failed === 0 ? 0 : 1);
