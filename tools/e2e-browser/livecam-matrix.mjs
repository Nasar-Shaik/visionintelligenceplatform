/**
 * The live-capture scenario matrix (P-9), driven through a real browser against the deployment.
 *
 * ### ⭐ What is real here, and it is almost everything
 *
 * A fresh Chromium per scenario, launched with `--use-file-for-fake-video-capture` so the **camera
 * device** is a file and nothing else is substituted: real HTTPS through Caddy, real login with a
 * real password, the real console bundle, a real `getUserMedia`, a real `<video>` decode, a real
 * canvas draw, a real JPEG encode, a real upload across the gateway, the real media service, the
 * real ONNX runtime, the real tracker, the real rule engine and the real incident pipeline.
 *
 * ### ⚠️ Why a new browser per scenario, when one would be faster
 *
 * `--use-file-for-fake-video-capture` is a **launch** flag; Chrome reads it once. Reusing a browser
 * would mean every scenario after the first ran against the first scenario's footage while the
 * report attributed the numbers to the file named in the row — the worst possible failure for a
 * matrix, because every row would be internally consistent and wrong.
 *
 * ### ⚠️ Deltas, not totals
 *
 * Tracking counters are lifetime per camera and the runtime keeps them across scenarios. Every
 * tracking figure below is `after − before`, sampled either side of the run. A row reporting
 * `createdTracks: 47` when the scene held one person would be reporting the whole afternoon.
 *
 *   node livecam-matrix.mjs --y4m <dir> --camera <cameraId> [--seconds 25] [--fps 4] [--only id,id]
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from '../validation/livecam/scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

/*
 * ⚠️ The edge terminates TLS with Caddy's **internal CA** — a genuine certificate from a CA this
 * machine has not been told to trust. Accepting it is what lets this tool read the API over the same
 * HTTPS path the browser uses, rather than through a plaintext side door that would not exercise the
 * edge at all. Identical reasoning to `ignoreHTTPSErrors` in `playwright.config.ts`, and scoped the
 * same way: this file, a validation tool, never the application.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE = process.env.VIP_BASE_URL ?? 'https://localhost';
const TENANT = process.env.VIP_TENANT ?? 'tnt_demo_retail';
const EMAIL = process.env.VIP_EMAIL ?? 'security.manager@northgate.demo';
const PASSWORD = process.env.VIP_PASSWORD ?? '12345678';
const Y4M = resolve(flag('y4m', '/tmp/vip-livecam-y4m'));
const CAMERA = flag('camera', process.env.VIP_LIVE_CAMERA ?? '');
const SECONDS = Number(flag('seconds', 25));
const FPS = Number(flag('fps', 4));
const ONLY = flag('only', '')
  .split(',')
  .filter((s) => s !== '');
const OUT = resolve(flag('out', join(HERE, 'artifacts/livecam')));

if (CAMERA === '') {
  console.error('⛔ --camera <cameraId> is required: the matrix ingests into a real camera.');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

/* ── platform reads, through the ordinary API ──────────────────────────────────────────────────── */

let token = '';
async function login() {
  const res = await fetch(`${BASE}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed ${String(res.status)}: ${JSON.stringify(body)}`);
  token = body.data.accessToken;
}

/**
 * ⛔ **Re-authenticates on a 401, and this was found the expensive way.**
 *
 * A matrix run takes ~30 minutes; the access token does not last that long. Without this, every
 * platform read after the token expired returned `{ __error: '401 …' }`, which the callers turned
 * into `null` — so the last scenarios reported `detections: —`, `createdTracks: null` and
 * `events: 0`. ⚠️ **The browser half kept working**, because each scenario logs in through the UI
 * with fresh credentials, so the run looked healthy and only the numbers were missing.
 *
 * A single retry, once per call. A loop would turn a genuinely wrong password into an infinite one.
 */
async function api(path, retry = true) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': TENANT },
  });
  if (res.status === 401 && retry) {
    await login();
    return api(path, false);
  }
  const body = await res.json().catch(() => ({}));
  return res.ok ? body.data : { __error: `${String(res.status)} ${JSON.stringify(body.error ?? {})}` };
}

/** The runtime's per-camera tracking counters, or `null` when they cannot be read. */
async function trackingFor(cameraId) {
  const listing = await api('/tracking/cameras');
  const row = (listing?.cameras ?? []).find((c) => c.cameraId === cameraId);
  return row ?? null;
}

/**
 * ⛔ **The event count is NOT a detection count, and the first version of this matrix used it as
 * one.**
 *
 * `services/events` deduplicates on `tenant|type|camera|zone|trackId|10s-bucket` (L-57). A person
 * standing in view for eighteen seconds at 4 fps produces ~72 detections, ~72 published results and
 * **two** stored events. A shorter window, or a track whose events fall either side of a bucket
 * boundary, produces **zero** — and a matrix row reading `events: 0` then means "detection is
 * working perfectly", which is the opposite of how anyone would read it.
 *
 * Measured before it reached a report: `crowd` (eight people, eight active tracks) and
 * `partial-occlusion` (one track created) both reported `events: 0`. The bridge's own counters were
 * clean — `droppedQueueFull: 0`, `failed: 0` — so nothing was lost; the instrument was wrong.
 *
 * The bridge's `detectionsPublished` is upstream of that dedup and counts every detection in every
 * published result. It is the honest presence signal; the event count stays alongside it, because
 * "how many events did an operator get" is a real and different question.
 */
async function bridgeCounters() {
  const b = await api('/media/perception/event-bridge');
  if (b === null || b.__error !== undefined) return null;
  return {
    offered: b.offered ?? null,
    published: b.published ?? null,
    suppressed: b.suppressed ?? null,
    detectionsPublished: b.detectionsPublished ?? null,
    droppedQueueFull: b.droppedQueueFull ?? null,
    droppedOutOfOrder: b.droppedOutOfOrder ?? null,
    failed: b.failed ?? null,
  };
}

/** Container CPU/memory, sampled once. ⚠️ `docker stats` blocks for a full second per call. */
function containerStats(names) {
  try {
    const raw = execFileSync(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', ...names],
      { encoding: 'utf8' },
    );
    const out = {};
    for (const line of raw.trim().split('\n')) {
      const [name, cpu, mem] = line.split('\t');
      if (name === undefined) continue;
      out[name] = { cpu: Number((cpu ?? '0').replace('%', '')), mem: (mem ?? '').split(' / ')[0] };
    }
    return out;
  } catch {
    /* ⚠️ An absent sample is `null`, never a zeroed record. A CPU reading of 0 % during a run that
     * loaded the machine would be a measurement that lies in the safe direction. */
    return null;
  }
}

const CONTAINERS = ['vip-prod-media-1', 'vip-prod-inference-1', 'vip-prod-events-1', 'vip-prod-rules-1'];

/* ── one scenario ──────────────────────────────────────────────────────────────────────────────── */

async function runScenario(scenario) {
  const y4m = join(Y4M, `${scenario.id}.y4m`);
  if (!existsSync(y4m)) {
    return { id: scenario.id, status: 'skipped', reason: `no Y4M at ${y4m}` };
  }

  const browser = await chromium.launch({
    args: [
      /* Auto-accepts the camera prompt. Without it the page blocks on a dialog nobody can click. */
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ['camera'],
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });

  const before = await trackingFor(CAMERA);
  const bridgeBefore = await bridgeCounters();
  const startedAt = new Date().toISOString();
  const cpuSamples = [];
  /*
   * ⛔ **Chrome LOOPS the Y4M, and the loop point is a scene cut.**
   *
   * Measured, not assumed: a 20-second file with one person in it produced `createdTracks: 2` for a
   * 20-second capture. The subject reaches the right edge, the file restarts, and it reappears at
   * the left — which is a teleport, so the tracker correctly ends one track and starts another. The
   * matrix would have reported "one person, two tracks" for every scenario and it would have read as
   * tracker fragmentation.
   *
   * Chrome begins playing at LAUNCH, not at capture start, so the margin that matters is the whole
   * browser lifetime, not the capture window. This records it and the report refuses any row where
   * it was not met, rather than quietly publishing an inflated count.
   */
  const browserLaunchedAt = Date.now();
  const clipSeconds = Number(process.env.VIP_Y4M_SECONDS ?? 30);

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel(/tenant/i).fill(TENANT);
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.getByRole('navigation').waitFor({ timeout: 30_000 });

    await page.goto(`${BASE}/live/webcam`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('livecam-camera').waitFor({ timeout: 20_000 });
    await page.getByTestId('livecam-camera').selectOption(CAMERA);
    await page.getByRole('button', { name: `${String(FPS)} fps` }).click();
    await page.getByTestId('livecam-start').click();

    /* The Stop button only exists once the loop is running — waiting for it is waiting for `live`. */
    await page.getByTestId('livecam-stop').waitFor({ timeout: 30_000 });

    const deadline = Date.now() + SECONDS * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(4_000);
      const sample = containerStats(CONTAINERS);
      if (sample !== null) cpuSamples.push(sample);
    }

    /* Read the browser's own stage table before stopping — it is cleared with the loop. */
    const browserStages = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')];
      const out = {};
      for (const tr of rows) {
        const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
        if (cells.length === 6) {
          out[cells[0]] = {
            count: Number(cells[1]),
            min: Number(cells[2]),
            avg: Number(cells[3]),
            p95: Number(cells[4]),
            max: Number(cells[5]),
          };
        } else if (cells.length === 2) {
          out[cells[0]] = null;
        }
      }
      return out;
    });
    const overlayText = await page.getByTestId('livecam-overlay-age').textContent();
    const clockText = await page.getByTestId('livecam-clock').textContent().catch(() => null);
    const counters = await page.evaluate(() => {
      const out = {};
      for (const dl of document.querySelectorAll('dl')) {
        for (const row of dl.children) {
          const dt = row.querySelector('dt')?.textContent?.trim();
          const dd = row.querySelector('dd')?.textContent?.trim();
          if (dt !== undefined && dd !== undefined) out[dt] = dd;
        }
      }
      return out;
    });

    await page.getByTestId('livecam-stop').click();
    await page.getByTestId('livecam-start').waitFor({ timeout: 20_000 });

    const endedAt = new Date().toISOString();
    const browserLifetimeSeconds = (Date.now() - browserLaunchedAt) / 1000;
    /* ⚠️ The pipeline is asynchronous: the last frames are still in flight when Stop is pressed. */
    await page.waitForTimeout(6_000);

    const after = await trackingFor(CAMERA);
    const bridgeAfter = await bridgeCounters();
    const events = await api(
      `/events/events?cameraId=${CAMERA}&from=${startedAt}&to=${new Date().toISOString()}&limit=200`,
    );
    const incidents = await api('/workflow/incidents?limit=50');
    const processing = await api('/media/perception/assignment/cameras');
    const mine = (processing ?? []).find?.((c) => c.cameraId === CAMERA) ?? null;

    const eventRows = events?.events ?? events?.items ?? [];
    const inWindow = eventRows.filter(
      (e) => e.occurredAt >= startedAt && e.occurredAt <= endedAt,
    );
    const incidentRows = (incidents?.items ?? incidents?.incidents ?? []).filter(
      (i) => (i.occurredAt ?? i.raisedAt ?? '') >= startedAt,
    );

    const delta = (key) =>
      before === null || after === null ? null : (after[key] ?? 0) - (before[key] ?? 0);

    return {
      id: scenario.id,
      title: scenario.title,
      group: scenario.group,
      clip: scenario.clip,
      expectedPeople: scenario.expect,
      status: 'ran',
      startedAt,
      endedAt,
      seconds: SECONDS,
      fps: FPS,
      /*
       * ⚠️ The loop guard. `looped: true` means the footage restarted during this run, so every
       * track count in the row includes at least one discontinuity that is an artefact of the
       * harness. The report prints the flag next to the count rather than dropping the row.
       */
      clipSeconds,
      browserLifetimeSeconds: Number(browserLifetimeSeconds.toFixed(1)),
      looped: browserLifetimeSeconds > clipSeconds,
      browserStages,
      browserCounters: counters,
      overlayText,
      clockText,
      tracking: {
        createdTracks: delta('createdTracks'),
        confirmedTracks: delta('confirmedTracks'),
        recoveredTracks: delta('recoveredTracks'),
        occlusionsSurvived: delta('occlusionsSurvived'),
        framesTracked: delta('framesTracked'),
        outOfOrderFrames: delta('outOfOrderFrames'),
        activeTracksAtEnd: after?.activeTracks ?? null,
        trackingFps: after?.trackingFps ?? null,
        averageTrackingMs: after?.averageTrackingMs ?? null,
      },
      pipeline: mine,
      /**
       * ⭐ **The detection presence signal, upstream of event dedup.** See `bridgeCounters()`.
       * `detectionsPublished` counts every detection in every published result; `resultsPublished`
       * counts frames that carried at least one. `suppressed` is frames the publisher declined
       * because they carried none — which is how an empty scene proves itself.
       */
      detection:
        bridgeBefore === null || bridgeAfter === null
          ? null
          : {
              detectionsPublished:
                (bridgeAfter.detectionsPublished ?? 0) - (bridgeBefore.detectionsPublished ?? 0),
              resultsPublished: (bridgeAfter.published ?? 0) - (bridgeBefore.published ?? 0),
              resultsOffered: (bridgeAfter.offered ?? 0) - (bridgeBefore.offered ?? 0),
              suppressedNoDetections: (bridgeAfter.suppressed ?? 0) - (bridgeBefore.suppressed ?? 0),
              droppedQueueFull:
                (bridgeAfter.droppedQueueFull ?? 0) - (bridgeBefore.droppedQueueFull ?? 0),
              droppedOutOfOrder:
                (bridgeAfter.droppedOutOfOrder ?? 0) - (bridgeBefore.droppedOutOfOrder ?? 0),
              failed: (bridgeAfter.failed ?? 0) - (bridgeBefore.failed ?? 0),
            },
      events: {
        count: inWindow.length,
        distinctTrackIds: new Set(inWindow.map((e) => e.subjects?.[0]?.trackId).filter(Boolean)).size,
        types: [...new Set(inWindow.map((e) => e.type))],
        note: 'Deduplicated at 10 s per track (L-57) — NOT a detection count. See `detection`.',
      },
      incidents: { count: incidentRows.length, titles: incidentRows.slice(0, 5).map((i) => i.title) },
      cpuSamples,
      consoleErrors,
    };
  } catch (err) {
    /* ⚠️ A screenshot on failure or the finding is unactionable the next morning. */
    await page.screenshot({ path: join(OUT, `${scenario.id}-FAILED.png`) }).catch(() => undefined);
    return {
      id: scenario.id,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      consoleErrors,
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/* ── the run ───────────────────────────────────────────────────────────────────────────────────── */

await login();
const chosen = SCENARIOS.filter((s) => (ONLY.length === 0 ? true : ONLY.includes(s.id)));
const results = [];

console.log(`livecam matrix — ${String(chosen.length)} scenarios, ${String(SECONDS)} s each at ${String(FPS)} fps\n`);

for (const scenario of chosen) {
  if (scenario.manual === true) {
    console.log(`  ${scenario.id.padEnd(22)} NOT EXECUTED — ${scenario.note ?? 'manual only'}`);
    results.push({ id: scenario.id, title: scenario.title, status: 'manual', note: scenario.note });
    continue;
  }
  process.stdout.write(`  ${scenario.id.padEnd(22)} `);
  const result = await runScenario(scenario);
  results.push(result);
  if (result.status === 'ran') {
    const d = result.detection;
    console.log(
      `det=${String(d?.detectionsPublished ?? '—')}/${String(d?.resultsPublished ?? '—')}f ` +
        `empty=${String(d?.suppressedNoDetections ?? '—')} ` +
        `tracks+${String(result.tracking.createdTracks)} active=${String(result.tracking.activeTracksAtEnd)} ` +
        `events=${String(result.events.count)} incidents=${String(result.incidents.count)} ` +
        `expected=${result.expectedPeople === null ? 'n/a' : String(result.expectedPeople)}`,
    );
  } else {
    console.log(`${result.status.toUpperCase()} — ${result.reason ?? result.error ?? ''}`);
  }
  writeFileSync(join(OUT, 'matrix.json'), JSON.stringify({ results }, null, 2));
  /* ⚠️ A gap between scenarios longer than the tracker's `reentryGapSeconds` (12 s), so one
   * scenario's departing subjects are never linked to the next scenario's arriving ones. Without it
   * every row after the first would report recoveries that belong to the previous clip. */
  await new Promise((r) => setTimeout(r, 14_000));
}

writeFileSync(
  join(OUT, 'matrix.json'),
  JSON.stringify(
    { base: BASE, camera: CAMERA, seconds: SECONDS, fps: FPS, at: new Date().toISOString(), results },
    null,
    2,
  ),
);
const ran = results.filter((r) => r.status === 'ran').length;
const failed = results.filter((r) => r.status === 'failed');
console.log(`\n${String(ran)} ran · ${String(failed.length)} failed · written to ${join(OUT, 'matrix.json')}`);
for (const f of failed) console.log(`  ⛔ ${f.id}: ${f.error}`);
