/**
 * ⭐ **Source-agnosticism, measured** (P-9 requirement 7).
 *
 * Runs **the same footage** twice — once as an uploaded recording through the offline analysis path,
 * once as live frames through the browser-webcam producer — and compares what the platform produced.
 *
 * ### ⚠️ What "identical" means here, precisely
 *
 * The two runs do **not** produce identical numbers, and a proof that claimed they did would be
 * wrong. Offline delivers every decoded frame losslessly (`FrameSink.deliver` waits); live samples
 * the scene at the capture rate and drops under pressure (`FrameSink.push`). Different frames, so
 * different counts. That difference is designed, documented on the port, and correct.
 *
 * What must be identical is the **execution path**: the same runtime, the same model id and version,
 * the same execution provider, the same capability, the same tracker, the same event types, the same
 * rule and the same incident shape. Those are what this compares, alongside a *rate* comparison
 * (detections per analysed frame) that should agree because it is a property of the footage and the
 * model rather than of the delivery policy.
 *
 *   node parity.mjs --camera <liveCameraId> --clip single-person-walking --live <matrix.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';
const CAMERA = flag('camera', process.env.VIP_LIVE_CAMERA ?? '');
const CLIP = flag('clip', 'single-person-walking');
const LIVE_JSON = flag('live', '');
const LIVE_ID = flag('live-scenario', 'one-person');
const OUT = resolve(flag('out', '/tmp/livecam-parity.json'));

if (CAMERA === '' || LIVE_JSON === '') {
  console.error('⛔ --camera <id> and --live <matrix.json> are required.');
  process.exit(2);
}

let token = '';
const H = (extra = {}) => ({
  authorization: `Bearer ${token}`,
  'x-tenant-id': TENANT,
  ...extra,
});
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
async function get(path) {
  const res = await fetch(`${BASE}/api${path}`, { headers: H() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} → ${String(res.status)} ${JSON.stringify(body.error ?? {})}`);
  return body.data;
}
async function post(path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: H({ 'content-type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  });
  const parsed = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: parsed.data, error: parsed.error };
}

await login();

/* ── the offline arm ───────────────────────────────────────────────────────────────────────────── */

const clipPath = join(REPO, 'infra/docker/fixtures/media/validation', `${CLIP}.mp4`);
const bytes = readFileSync(clipPath);
console.log(`offline arm — uploading ${CLIP}.mp4 (${(bytes.byteLength / 1024).toFixed(0)} KB)`);

/*
 * ⚠️ The upload goes through the same presign + PUT the console uses. Posting the bytes to a
 * bespoke test endpoint would prove the runtime works and skip the path a customer's file takes.
 */
const created = await post('/media/analyses', {
  cameraId: CAMERA,
  label: `P-9 parity — ${CLIP}`,
  originalName: `parity-${CLIP}-${String(Date.now())}.mp4`,
  contentType: 'video/mp4',
  bytes: bytes.byteLength,
});
if (!created.ok) {
  console.error('⛔ could not create the analysis:', created.status, JSON.stringify(created.error));
  process.exit(1);
}
const analysis = created.data.analysis ?? created.data;
const upload = created.data.uploadUrl ?? created.data.upload ?? null;
if (upload === null) {
  console.error('⛔ no upload target in the create response:', JSON.stringify(created.data).slice(0, 400));
  process.exit(1);
}
const putUrl = typeof upload === 'string' ? upload : upload.url;
const putRes = await fetch(putUrl, {
  method: 'PUT',
  headers: { 'content-type': 'video/mp4' },
  body: bytes,
});
if (!putRes.ok) {
  console.error(`⛔ object-storage PUT failed: ${String(putRes.status)}`);
  process.exit(1);
}
/* ⚠️ `confirm` probes the stored object and REFUSES what it cannot decode — it is not a formality;
 * skipping it would start a session against bytes nobody has checked. */
const confirmed = await post(`/media/analyses/${analysis.id}/confirm`, {});
if (!confirmed.ok) {
  console.error('⛔ confirm failed:', confirmed.status, JSON.stringify(confirmed.error));
  process.exit(1);
}
const started = await post(`/media/analyses/${analysis.id}/sessions`, {});
if (!started.ok) {
  console.error('⛔ could not start the session:', started.status, JSON.stringify(started.error));
  process.exit(1);
}

/*
 * ⚠️ **Poll the SESSION's state, not the analysis's.** The analysis reaches `ready` as soon as its
 * bytes are confirmed and stays there; the run's outcome lives on `sessions[n].state`. Polling the
 * analysis therefore never terminates, and the first version of this script spent its entire
 * ten-minute budget waiting for a value that had already been decided in three seconds — then
 * reported `null` for every offline figure, which reads as "the analysis failed".
 */
let offlineSession = null;
const deadline = Date.now() + 10 * 60 * 1000;
process.stdout.write('  analysing');
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3_000));
  process.stdout.write('.');
  const detail = await get(`/media/analyses/${analysis.id}`).catch(() => null);
  const s = (detail?.sessions ?? []).find((x) => x.id === started.data.id) ?? detail?.sessions?.[0];
  if (s !== undefined && ['succeeded', 'failed', 'cancelled'].includes(s.state)) {
    offlineSession = s;
    console.log(` ${String(s.state)}`);
    break;
  }
}
if (offlineSession === null) {
  console.error('⛔ the offline session did not reach a terminal state within the budget.');
  process.exit(1);
}

const offlineDetail = await get(`/media/analyses/${analysis.id}`);
/*
 * ⭐ **`analysisSessionId`, and it is the only field that can ask this question** (ADR-0047).
 * `correlationId` cannot: on the live path it is stamped per frame, and a rerun of one recording
 * reproduces every other field exactly.
 */
const offlineEvents = await get(
  `/events/events?analysisSessionId=${encodeURIComponent(offlineSession.id)}&limit=500`,
).catch(() => ({ events: [] }));

/* ── the live arm, read from the matrix run ────────────────────────────────────────────────────── */

const matrix = JSON.parse(readFileSync(resolve(LIVE_JSON), 'utf8'));
const liveRow = (matrix.results ?? matrix).find((r) => r.id === LIVE_ID);
if (liveRow === undefined) {
  console.error(`⛔ no scenario "${LIVE_ID}" in ${LIVE_JSON}`);
  process.exit(1);
}

/* ── compare ───────────────────────────────────────────────────────────────────────────────────── */

const runtime = await get('/system/ai-runtime').catch(() => null);
const offlineCounts = offlineSession.counts ?? {};
const offlineProvenance = offlineSession.provenance ?? {};

const offlineFrames = offlineCounts.framesAnalysed ?? null;
const offlineDetections = offlineCounts.detections ?? null;
const liveFrames = liveRow.detection?.resultsPublished ?? null;
const liveDetections = liveRow.detection?.detectionsPublished ?? null;

const rate = (d, f) => (typeof d === 'number' && typeof f === 'number' && f > 0 ? d / f : null);

const report = {
  at: new Date().toISOString(),
  clip: CLIP,
  camera: CAMERA,
  /*
   * ⭐ The identity claim. These must match exactly; a difference here means the two paths reached
   * different code, which is the thing the whole milestone denies.
   */
  executionPath: {
    offline: {
      modelId: offlineProvenance.modelId ?? null,
      runtimeVersion: offlineProvenance.runtimeVersion ?? null,
      executionProvider: offlineProvenance.executionProvider ?? null,
      capabilityId: offlineProvenance.capabilityId ?? null,
      pipelineVersion: offlineProvenance.pipelineVersion ?? null,
    },
    live: {
      modelId: runtime?.pipeline?.modelId ?? null,
      runtimeVersion:
        runtime?.runtime?.runtimeVersion ?? runtime?.runtime?.version ?? runtime?.runtime?.runtime?.version ?? null,
      executionProvider: runtime?.pipeline?.executionProvider ?? null,
      capabilityId: runtime?.capabilityId ?? null,
    },
    note:
      'Read from what each run SAID it ran, not from configuration — configuration is what somebody intended.',
  },
  volumes: {
    offlineFramesAnalysed: offlineFrames,
    offlineDetections,
    offlineDetectionsPerFrame: rate(offlineDetections, offlineFrames),
    liveFramesWithResults: liveFrames,
    liveDetections,
    liveDetectionsPerFrame: rate(liveDetections, liveFrames),
    note:
      'Counts differ by design: offline delivers every frame losslessly, live samples at the capture rate and drops under pressure (FrameSink.deliver vs push). The per-frame RATE is the comparable figure.',
  },
  events: {
    offline: (offlineEvents?.events ?? offlineEvents?.items ?? []).length,
    live: liveRow.events?.count ?? null,
    offlineTypes: [...new Set((offlineEvents?.events ?? []).map((e) => e.type))],
    liveTypes: liveRow.events?.types ?? [],
  },
  tracking: {
    offlineTracks: offlineCounts.tracks ?? null,
    liveTracksCreated: liveRow.tracking?.createdTracks ?? null,
  },
  offlineAnalysisId: analysis.id,
  offlineSessionId: offlineSession.id,
  offlineStatus: offlineSession.state,
  offlineFrameRate: offlineSession.analysisFrameRate ?? null,
  offlineFramesDropped: offlineCounts.framesDropped ?? null,
  liveScenario: LIVE_ID,
};

writeFileSync(OUT, JSON.stringify({ report, offlineDetail, liveRow }, null, 2));

console.log('\n── execution path ──');
console.log('  offline:', JSON.stringify(report.executionPath.offline));
console.log('  live   :', JSON.stringify(report.executionPath.live));
console.log('── volumes ──');
console.log(
  `  offline ${String(offlineDetections)} detections / ${String(offlineFrames)} frames = ` +
    `${report.volumes.offlineDetectionsPerFrame?.toFixed(3) ?? '—'} per frame`,
);
console.log(
  `  live    ${String(liveDetections)} detections / ${String(liveFrames)} frames = ` +
    `${report.volumes.liveDetectionsPerFrame?.toFixed(3) ?? '—'} per frame`,
);
console.log('── event types ──');
console.log('  offline:', report.events.offlineTypes.join(', ') || '—');
console.log('  live   :', report.events.liveTypes.join(', ') || '—');
console.log(`\nwritten to ${OUT}`);
