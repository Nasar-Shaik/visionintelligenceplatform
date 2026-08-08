/**
 * Stage-by-stage latency for the live path (P-9 requirement 4).
 *
 * ### ⛔ "Do not report only end-to-end latency" — and the reason is diagnostic, not decorative
 *
 * An end-to-end number is a budget nobody can spend. "1.2 seconds from camera to incident" tells an
 * engineer nothing about which of nine hops to look at, and tells a customer's architect nothing
 * about what a faster model, a faster network or a bigger box would buy. This tool runs one real
 * browser capture and then attributes the time.
 *
 * ### ⚠️ Three kinds of number, never mixed, always labelled
 *
 *   **measured**  — a stopwatch around exactly this stage, on one clock.
 *                   capture · encode · upload · transport · media→runtime · browser render
 *   **reported**  — the component's own measurement of itself, on its own clock.
 *                   inference (runtime) · tracking (runtime)
 *   **derived**   — the remainder after subtracting the measured parts from a span.
 *                   publish→persist · rules→incident
 *
 * ⛔ A derived stage inherits the error of everything it was subtracted from, and can come out
 * **negative** when two clocks disagree — which is information, not a bug to clamp away. A negative
 * remainder printed as `0` would be a silent claim that the stage is instant. They are reported as
 * they fall, with the clock offset alongside so a reader can judge.
 *
 *   node livecam-latency.mjs --camera <id> [--seconds 90] [--fps 4] [--out file.json]
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Caddy's internal CA — same scoping as `playwright.config.ts`'s `ignoreHTTPSErrors`. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HERE = dirname(fileURLToPath(import.meta.url));
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
const SECONDS = Number(flag('seconds', 90));
const FPS = Number(flag('fps', 4));
const Y4M = flag('y4m', '');
const OUT = resolve(flag('out', join(HERE, 'artifacts/livecam/latency.json')));

if (CAMERA === '') {
  console.error('⛔ --camera <cameraId> is required.');
  process.exit(2);
}
mkdirSync(dirname(OUT), { recursive: true });

let token = '';
const H = () => ({ authorization: `Bearer ${token}`, 'x-tenant-id': TENANT });
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
  return res.ok ? body.data : null;
}

const pctl = (sorted, p) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];

/** min/avg/p95/max, or `null` when nothing was measured. ⚠️ Never a zeroed record (ADR-0039). */
function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: Number(sorted[0].toFixed(2)),
    avg: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(2)),
    p95: Number(pctl(sorted, 95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

await login();

/* ── one real browser capture ──────────────────────────────────────────────────────────────────── */

const launchArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (Y4M !== '') launchArgs.push(`--use-file-for-fake-video-capture=${resolve(Y4M)}`);

const browser = await chromium.launch({ args: launchArgs });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  permissions: ['camera'],
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

console.log(`latency run — ${String(SECONDS)} s at ${String(FPS)} fps into ${CAMERA}`);
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.getByLabel(/tenant/i).fill(TENANT);
await page.getByLabel(/email/i).fill(EMAIL);
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('navigation').waitFor({ timeout: 30_000 });

await page.goto(`${BASE}/live/webcam`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('livecam-camera').selectOption(CAMERA);
await page.getByRole('button', { name: `${String(FPS)} fps` }).click();

const startedAt = new Date().toISOString();
await page.getByTestId('livecam-start').click();
await page.getByTestId('livecam-stop').waitFor({ timeout: 30_000 });

/**
 * ⭐ **Browser render latency, sampled during the run rather than derived afterwards.**
 *
 * The overlay's age is `now − newest track lastSeen`: how far behind the preview the boxes are. It
 * is the only stage a user can *see*, and it is bounded below by the track poll interval — so a
 * sample is meaningful and a single reading at the end is not. Sampled every 2 s from the page's own
 * text, which is the number an operator is reading.
 */
const renderSamples = [];
const deadline = Date.now() + SECONDS * 1000;
while (Date.now() < deadline) {
  await page.waitForTimeout(2_000);
  const text = (await page.getByTestId('livecam-overlay-age').textContent()) ?? '';
  const m = /boxes are ([\d.]+) s behind/.exec(text);
  if (m !== null) renderSamples.push(Number(m[1]) * 1000);
}

const browserStages = await page.evaluate(() => {
  const out = {};
  for (const tr of document.querySelectorAll('table tbody tr')) {
    const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
    if (cells.length === 6) {
      out[cells[0]] = {
        count: Number(cells[1]),
        min: Number(cells[2]),
        avg: Number(cells[3]),
        p95: Number(cells[4]),
        max: Number(cells[5]),
      };
    }
  }
  return out;
});
const clockText = (await page.getByTestId('livecam-clock').textContent().catch(() => null)) ?? null;

await page.getByTestId('livecam-stop').click();
const endedAt = new Date().toISOString();
/* The pipeline is asynchronous; the last frames are still in flight when Stop is pressed. */
await page.waitForTimeout(8_000);
await context.close();
await browser.close();

/* ── platform stages, from the data the run produced ───────────────────────────────────────────── */

const perception = await get('/system/ai-runtime').catch(() => null);
const pipelineRows = await get('/media/perception/assignment/cameras');
const mine = (pipelineRows ?? []).find((r) => r.cameraId === CAMERA) ?? null;
const trackingRows = await get('/tracking/cameras');
const trackingMine = (trackingRows?.cameras ?? []).find((c) => c.cameraId === CAMERA) ?? null;

const eventsData = await get(`/events/events?cameraId=${CAMERA}&limit=500`);
const eventRows = (eventsData?.events ?? eventsData?.items ?? []).filter(
  (e) => e.occurredAt >= startedAt && e.occurredAt <= endedAt,
);
const incidentsData = await get('/workflow/incidents?limit=200');
const incidentRows = (incidentsData?.items ?? incidentsData?.incidents ?? []).filter(
  (i) => (i.triggeredBy?.occurredAt ?? '') >= startedAt && (i.triggeredBy?.occurredAt ?? '') <= endedAt,
);

/*
 * ⚠️ `occurredAt` is the frame's time as MEDIA stamped it (the platform clock, never the browser's),
 * and `ingestedAt` is when the events service persisted it. The span between them therefore contains
 * media's queue wait, the runtime round trip, tracking, the publish, the broker hop and the write.
 * Subtracting the parts that were measured directly leaves the publish+broker+persist remainder.
 */
const occurredToIngested = eventRows.map((e) => Date.parse(e.ingestedAt) - Date.parse(e.occurredAt));

const eventById = new Map(eventRows.map((e) => [e.id, e]));
const ingestToIncident = [];
const occurredToIncident = [];
for (const inc of incidentRows) {
  const raisedAt = inc.history?.[0]?.at ?? inc.createdAt ?? null;
  if (raisedAt === null) continue;
  const raised = Date.parse(raisedAt);
  const source = eventById.get(inc.triggeredBy?.eventId);
  if (source !== undefined) ingestToIncident.push(raised - Date.parse(source.ingestedAt));
  const occurred = Date.parse(inc.triggeredBy?.occurredAt ?? '');
  if (Number.isFinite(occurred)) occurredToIncident.push(raised - occurred);
}

const capture = browserStages['Capture (video → canvas)'] ?? null;
const encode = browserStages['Encode (canvas → JPEG)'] ?? null;
const upload = browserStages['Upload (round trip)'] ?? null;
const transport = browserStages['Transport (service-measured)'] ?? null;

const mediaToRuntime = mine?.processingLatencyMs ?? null;
const inferenceMs = perception?.pipeline?.inferenceMsAvg ?? null;
const trackingMs = trackingMine?.averageTrackingMs ?? null;

const occurredToIngestedStats = stats(occurredToIngested);
/*
 * The remainder: everything between the frame being stamped and the event being persisted that is
 * not the runtime round trip. ⚠️ Derived, so it carries the error of both terms — and negative is a
 * legitimate outcome when the two averages come from overlapping but not identical frame sets.
 */
const publishRemainderAvg =
  occurredToIngestedStats === null || mediaToRuntime === null
    ? null
    : Number((occurredToIngestedStats.avg - mediaToRuntime).toFixed(2));

const report = {
  at: new Date().toISOString(),
  camera: CAMERA,
  window: { startedAt, endedAt, seconds: SECONDS, fps: FPS },
  clock: clockText,
  counts: {
    framesAccepted: upload?.count ?? null,
    events: eventRows.length,
    incidents: incidentRows.length,
  },
  stages: [
    { stage: 'Capture (video → canvas)', kind: 'measured', where: 'browser', ms: capture },
    { stage: 'JPEG encode (canvas → blob)', kind: 'measured', where: 'browser', ms: encode },
    { stage: 'HTTP upload (round trip)', kind: 'measured', where: 'browser', ms: upload },
    {
      stage: 'Transport (capture → media accept)',
      kind: 'measured',
      where: 'media service clock',
      ms: transport,
      note: 'Includes browser↔platform clock skew; see `clock`.',
    },
    {
      stage: 'Media ingest → runtime round trip',
      kind: 'measured',
      where: 'media service',
      ms: mediaToRuntime === null ? null : { count: null, min: null, avg: mediaToRuntime, p95: null, max: null },
      note: 'Rolling mean only — the sink keeps an average, not a distribution.',
    },
    {
      stage: 'Runtime inference',
      kind: 'reported',
      where: 'AI runtime',
      ms: inferenceMs === null ? null : { count: null, min: null, avg: inferenceMs, p95: null, max: null },
      note: 'A component of the round trip above, not additional to it.',
    },
    {
      stage: 'Tracking',
      kind: 'reported',
      where: 'AI runtime',
      ms: trackingMs === null ? null : { count: null, min: null, avg: trackingMs, p95: null, max: null },
      note: 'A component of the round trip above, not additional to it.',
    },
    {
      stage: 'Frame stamped → event persisted',
      kind: 'measured',
      where: 'media + events clocks',
      ms: occurredToIngestedStats,
      note: 'Contains the runtime round trip; the remainder below is the publish + broker + write.',
    },
    {
      stage: 'Publish + broker + persist (remainder)',
      kind: 'derived',
      where: 'subtraction',
      ms: publishRemainderAvg === null ? null : { count: null, min: null, avg: publishRemainderAvg, p95: null, max: null },
      note: 'Derived: (frame → event persisted) − (media → runtime). Inherits both errors.',
    },
    {
      stage: 'Event persisted → incident raised',
      kind: 'measured',
      where: 'events + workflow clocks',
      ms: stats(ingestToIncident),
      note: 'Rule evaluation, candidate dedup and incident creation.',
    },
    {
      stage: 'END TO END — frame stamped → incident raised',
      kind: 'measured',
      where: 'platform clocks',
      ms: stats(occurredToIncident),
    },
    {
      stage: 'Browser render (overlay behind preview)',
      kind: 'measured',
      where: 'browser',
      ms: stats(renderSamples),
      note: 'Bounded below by the 2 s track poll — this is presentation lag, not pipeline lag.',
    },
  ],
  raw: {
    browserStages,
    pipeline: mine,
    tracking: trackingMine,
    renderSamples,
    occurredToIngested,
    ingestToIncident,
    occurredToIncident,
  },
};

writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(`\n${'stage'.padEnd(42)} ${'kind'.padEnd(9)} ${'n'.padStart(5)} ${'min'.padStart(8)} ${'avg'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}`);
for (const s of report.stages) {
  const m = s.ms;
  console.log(
    `${s.stage.padEnd(42)} ${s.kind.padEnd(9)} ` +
      (m === null
        ? '   —  not measured'
        : `${String(m.count ?? '—').padStart(5)} ${String(m.min ?? '—').padStart(8)} ${String(m.avg ?? '—').padStart(8)} ${String(m.p95 ?? '—').padStart(8)} ${String(m.max ?? '—').padStart(8)}`),
  );
}
console.log(`\n${clockText ?? 'clock offset not measured'}`);
console.log(`written to ${OUT}`);
