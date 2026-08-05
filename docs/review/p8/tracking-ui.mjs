/**
 * P-8 Phase 4 · **the four tracking pages, in a real browser, against the production deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p8/tracking-ui.mjs
 *
 * A camera is started on the walking-person clip, so the pages have something true to say, and then
 * every number on screen is traced back to the payload the browser actually received.
 *
 * ### ⚠️ What is checked is the absence of invention
 *
 * A tracking page is an easy place to lie: a `0.000 fw/s` where nothing was measured, a confident
 * direction for an object that has not moved, a "speed" that reads as metres per second. Each of
 * those looks perfect in a screenshot, so each is asserted against the rendered DOM.
 *
 * ### ⚠️ The numbers are traced against the payloads the page RECEIVED
 *
 * Not against a fresh API call. The tracked scene moves at two frames a second, so a value fetched
 * after the paint legitimately differs from the one on screen — and comparing against it produces a
 * verification that fails at random and is then ignored. Responses are captured as the page makes
 * them, and the last few are kept, because the DOM may still be showing the previous poll.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const REPO = process.env.REPO ?? '/Users/mac/projects/VisionIntelligencePlatform';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = { email: 'loss.prevention@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-tracking-ui';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-trackui';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const api = async (path, opts = {}) => {
  const res = await fetch(`${B}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
};

console.log('\nP-8 Phase 4 · the tracking pages\n');

let H = {};
async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

async function removeCameras() {
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  for (const cam of (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG))) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
  }
}

await login();
await removeCameras();

docker('rm', '-f', FIXTURE);
docker('run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${REPO}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${REPO}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg');
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const made = await api('/camera/cameras', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    zoneId,
    name: `${TAG} walk`,
    protocol: 'rtsp',
    streamUrl: `rtsp://${FIXTURE}:8554/walk01`,
    metadata: { tags: [TAG] },
  }),
});
const cameraId = made.json.data.id;
await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });
console.log('  · a camera is watching one walking person; letting identities form\n');
await sleep(12000);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

/**
 * ⚠️ The last few payloads, not the last one. The DOM is painted from one poll and the next may land
 * before the assertion reads it — a race that produced a real false failure on the AI Runtime page
 * (`Uptime="51s"` against a payload reporting 56).
 */
const seen = { list: [], overview: [], detail: [], cameras: [] };
page.on('response', async (res) => {
  const url = res.url();
  const bucket = url.includes('/api/tracking/tracks/')
    ? 'detail'
    : url.includes('/api/tracking/tracks')
      ? 'list'
      : url.endsWith('/api/tracking/cameras')
        ? 'cameras'
        : url.endsWith('/api/tracking')
          ? 'overview'
          : null;
  if (bucket === null || !res.ok()) return;
  try {
    const body = await res.json();
    seen[bucket].push(body?.data);
    if (seen[bucket].length > 4) seen[bucket].shift();
  } catch {
    /* not json */
  }
});

async function signIn(who) {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  /*
   * ⚠️ The TENANT field is not optional. Sign-in has three inputs, not two — the tenant slug is typed
   * by hand (D-1, TD-40). A version of this that filled only email and password timed out at
   * `waitForURL` with an empty log, which reads as "the app never navigated" rather than "the form
   * refused to submit". Matched to `runtime-ui.mjs`, which had already solved this.
   */
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
}

try {
  await signIn(ADMIN);

  /* ── 1 · Live Tracks ────────────────────────────────────────────────────────────────────────── */
  console.log('1 · Live Tracks');
  await page.goto(`${B}/tracking`, { waitUntil: 'domcontentloaded' });
  /*
   * ⚠️ `.or()`, not a comma-joined selector. Playwright's CSS engine cannot parse `text=` in the same
   * string, and the error it raises ("Unexpected token = while parsing css selector") names the
   * punctuation rather than the mistake.
   */
  await page
    .locator('table tbody tr')
    .or(page.getByText('Nothing is being tracked'))
    .first()
    .waitFor({ timeout: 25_000 });
  await sleep(2500);
  await page.screenshot({ path: `${OUT}/tracking-live.png`, fullPage: true });

  const rows = await page.locator('table tbody tr').count();
  check(rows > 0, 'the page lists a live track', `${rows} row(s)`);

  const body = await page.locator('body').innerText();
  check(/fw\/s/.test(body), '⚠️ speed carries its unit, so it cannot be read as m/s',
    (body.match(/[\d.]+ fw\/s/) ?? ['none'])[0]);
  check(/frame widths/.test(body), 'the page explains that distances are not metres');
  check(!/\bm\/s\b/.test(body), 'nothing on the page claims metres per second');

  /*
   * ⚠️ Every rendered speed must appear in a payload the page received. A page that computed or
   * rounded a number differently from the API is inventing, and the invention is invisible.
   */
  const speeds = [...body.matchAll(/([\d.]+) fw\/s/g)].map((m) => m[1]);
  const payloadSpeeds = new Set();
  for (const payload of seen.list) {
    for (const track of payload?.tracks ?? []) {
      if (track.motion) {
        payloadSpeeds.add(track.motion.currentSpeedNormalized.toFixed(3));
        payloadSpeeds.add(track.motion.averageSpeedNormalized.toFixed(3));
      }
    }
  }
  const untraceable = speeds.filter((s) => !payloadSpeeds.has(s));
  check(untraceable.length === 0, 'every speed on screen traces to a payload the page received',
    untraceable.length === 0 ? `${speeds.length} value(s) traced` : `untraceable: ${untraceable.join(', ')}`);

  /* ── 2 · Track Detail ───────────────────────────────────────────────────────────────────────── */
  console.log('\n2 · Track Detail');
  await page.locator('table tbody tr a').first().click();
  await page.getByText(/duration/i).first().waitFor({ timeout: 20_000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/tracking-detail.png`, fullPage: true });

  const detail = await page.locator('body').innerText();
  /*
   * ⚠️ Case-insensitive, because `innerText` returns RENDERED text and these labels carry Tailwind's
   * `uppercase`. The page says "Duration" in the DOM and "DURATION" on screen; a case-sensitive
   * assertion fails against a page that is entirely correct, and the failure reads as "the field is
   * missing". `textContent` would return the source text — but the point of a browser check is what
   * an operator actually sees.
   */
  check(/duration/i.test(detail) && /travelled/i.test(detail), 'duration and travelled distance are shown');
  check(/dwell/i.test(detail), 'dwell is shown');
  check(/Geometry only/.test(detail), '⚠️ dwell is labelled geometry, not loitering');
  const loiterMentions = (detail.match(/loiter\w*/gi) ?? []).length;
  check(loiterMentions <= 1 && /not loitering/i.test(detail),
    'the only mention of loitering is the denial', `${loiterMentions} mention(s)`);
  check(await page.locator('svg[role="img"]').count() > 0, 'the travelled path is drawn');
  check(/evidence is never cached outside approved storage/.test(detail),
    '⚠️ the path says why there is no video frame behind it');

  /* ── 3 · Track Timeline ─────────────────────────────────────────────────────────────────────── */
  console.log('\n3 · Track Timeline');
  await page.locator('a:has-text("Lifecycle timeline")').click();
  await page.getByText(/track timeline/i).first().waitFor({ timeout: 20_000 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/tracking-timeline.png`, fullPage: true });
  const timeline = await page.locator('body').innerText();
  check(/Created|Confirmed|Tentative/.test(timeline), 'the lifecycle is rendered', timeline.slice(0, 0) || 'states shown');

  /* ── 4 · Runtime Track Statistics ───────────────────────────────────────────────────────────── */
  console.log('\n4 · Runtime Track Statistics');
  await page.goto(`${B}/tracking/statistics`, { waitUntil: 'domcontentloaded' });
  await page.getByText('predictive-iou').first().waitFor({ timeout: 25_000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/tracking-statistics.png`, fullPage: true });

  const stats = await page.locator('body').innerText();
  check(/predictive-iou/.test(stats), 'the deployed associator is named');
  check(/Fragmentation is not accuracy/.test(stats),
    '⚠️ the page states that fragmentation is not an accuracy score');
  check(/Reported, not editable/.test(stats), 'the engine settings are declared read-only');

  /*
   * ⚠️ No control anywhere configures the engine. Camera Processing Assignment and tracker tuning
   * are deployment settings, and a slider backed by nothing is worse than an absent one
   * (DEFINITION_OF_DONE: no UI configures functionality that is not implemented).
   */
  const inputs = await page.locator('main input, main select, main textarea').count();
  check(inputs === 0, '⚠️ nothing on the statistics page configures anything', `${inputs} input(s)`);

  /*
   * ⚠️ Traced the same way as the speeds. "Not measured" is the value this whole feature is built
   * around, and a page that prints 0.00 where the API sent null is the exact failure.
   */
  const overview = seen.overview[seen.overview.length - 1];
  if (overview?.stats) {
    /*
     * ⚠️ TWO kinds of null, rendered with two different words, and conflating them is the bug this
     * split exists to prevent. A derived average is `null` because nothing has been tracked YET —
     * "Not measured", and it will fill in. The three ground-truth metrics are `null` because this
     * runtime can NEVER measure them — "Not measurable", permanently. One word for both would tell
     * an operator to wait for a number that is never coming.
     */
    const truthKeys = new Set(overview.stats.groundTruth?.metrics ?? []);
    const nulls = Object.entries(overview.stats)
      .filter(([k, v]) => v === null && !truthKeys.has(k))
      .map(([k]) => k);
    const notMeasured = (stats.match(/Not measured/g) ?? []).length;
    check(nulls.length === 0 || notMeasured >= nulls.length,
      '⚠️ every null the API sent renders as "Not measured", never as a number',
      `${nulls.length} null field(s) → ${notMeasured} "Not measured" on screen`);

    /* ── the ADR-0039 surface ──────────────────────────────────────────────────────────────── */
    if (truthKeys.size > 0) {
      const notMeasurable = (stats.match(/Not measurable/g) ?? []).length;
      check(notMeasurable >= truthKeys.size,
        '⚠️ every ground-truth metric renders as "Not measurable" — visible, not hidden',
        `${truthKeys.size} unmeasurable metric(s) → ${notMeasurable} on screen`);
      check(/absent, never zero/i.test(stats),
        '⚠️ the page says they are absent rather than zero, and why');
      /*
       * ⚠️ Case-insensitive, because `innerText` returns RENDERED text and the labels carry Tailwind's
       * `uppercase`. The page is correct and a case-sensitive assertion is simply wrong about it —
       * the same trap that failed this file once before.
       */
      check(/identity switches/i.test(stats),
        'identity switches appear by name rather than being silently omitted');
      /*
       * ⚠️ The failure this guards: a `0` where the API sent `null`. Read from the `dd` that FOLLOWS
       * the label — not from an ancestor `div`, which matches the whole page and made this check
       * pass or fail on unrelated text.
       */
      const switchValue = await page
        .locator('dt', { hasText: /^identity switches$/i })
        .first()
        .locator('xpath=following-sibling::dd[1]')
        .innerText()
        .catch(() => '');
      check(switchValue !== '' && !/\d/.test(switchValue),
        '⚠️ no ground-truth metric renders as a number the runtime cannot know',
        switchValue.trim() || 'value not found');
    }
  }

  /*
   * ⚠️ Per-camera rows are a VIEW. The obvious next control here is a per-camera enable switch, and
   * that switch is Camera Processing Assignment (C-14c), which is not built. The `inputs === 0`
   * check above already covers the page; this asserts the rows themselves arrived.
   */
  const cameraPayload = seen.cameras[seen.cameras.length - 1];
  check(cameraPayload !== undefined, 'the page fetched per-camera metrics', '/api/tracking/cameras');
  const cameraRows = await page.locator('table tbody tr').count();
  if ((cameraPayload?.cameras ?? []).length > 0) {
    check(/Per camera/i.test(stats), 'per-camera metrics are on the page', `${cameraRows} row(s)`);
    check(/Tracking fps/i.test(stats), "the per-camera table reports each camera's tracking rate");
    check(cameraRows === cameraPayload.cameras.length,
      '⚠️ every camera row on screen came from the payload — none invented, none dropped',
      `${cameraPayload.cameras.length} in payload → ${cameraRows} rendered`);
    for (const camera of cameraPayload.cameras) {
      check(stats.includes(camera.cameraId), `camera ${camera.cameraId} is named on the page`);
    }
  } else {
    console.log('  · no camera has tracked anything in this runtime, so there are no per-camera rows');
    check(cameraRows === 0, '⚠️ an empty payload renders no rows rather than a placeholder',
      `${cameraRows} row(s)`);
  }

  /* ── 5 · permission ─────────────────────────────────────────────────────────────────────────── */
  console.log('\n5 · permission');
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await context.clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await signIn(VIEWER);
  await page.goto(`${B}/tracking`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const viewerBody = await page.locator('body').innerText();
  /*
   * ⚠️ A viewer holds `*:read`, so `track:read` is granted — and that is correct rather than an
   * oversight: they can already watch the footage a track is derived from, so withholding the
   * derived, anonymous path while showing the video would protect nothing.
   */
  check(!/Not authorized/.test(viewerBody), 'a viewer can read tracks — they can already watch the footage');
  await page.screenshot({ path: `${OUT}/tracking-viewer.png`, fullPage: true });
} finally {
  await browser.close();
  await login();
  await removeCameras();
  docker('rm', '-f', FIXTURE);
}

console.log('');
console.log(failures === 0 ? 'the tracking pages report what the runtime measured\n' : `${failures} browser check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
