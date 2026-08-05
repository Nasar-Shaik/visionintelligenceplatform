/**
 * P-8 Phase 5 · **the Event Bridge page, in a real browser, against the production deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> REPO=<repo> node <repo>/docs/review/p8/event-bridge-ui.mjs
 *
 * A camera is started on the walking-person clip so the page has something true to say, and then
 * every number on screen is traced back to the payload the browser actually received.
 *
 * ### ⚠️ What is checked is the absence of invention
 *
 * This page is an unusually easy place to lie, because most of what it reports is an ABSENCE:
 *
 *   - a publisher that has published nothing must say the broker state is **unknown**, never "up";
 *   - an average nothing has measured must render as **Not measured**, never `0.00 ms`;
 *   - four different reasons a frame did not publish must stay four numbers, not one.
 *
 * Every one of those looks perfect in a screenshot when it is wrong. The tracking statistics page
 * shipped with exactly this class of defect — it HARD-CODED "Not measurable" — so a mutation setting
 * a real value changed nothing on screen and the browser check stayed green while the page was
 * covering up a contract violation. Which is why the assertions below compare the DOM against the
 * payload rather than against an expected string.
 *
 * ### ⚠️ Traced against the payloads the page RECEIVED
 *
 * Not against a fresh API call. The bridge publishes continuously, so a value fetched after the
 * paint legitimately differs from the one on screen — and comparing against it produces a check that
 * fails at random and is then ignored. Responses are captured as the page makes them and the last
 * few are kept, because the DOM may still be showing the previous poll.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const REPO = process.env.REPO ?? '/Users/mac/projects/VisionIntelligencePlatform';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = { email: 'loss.prevention@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-bridge-ui';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-bridgeui';

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

console.log('\nP-8 Phase 5 · the Event Bridge page\n');

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
console.log('  · a camera is publishing; letting the bridge accumulate something to report\n');
await sleep(14000);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

/** The last few payloads, not the last one — the DOM may still show the previous poll. */
const seen = [];
page.on('response', async (res) => {
  if (!res.url().includes('/api/system/event-bridge') || !res.ok()) return;
  try {
    const body = await res.json();
    seen.push(body?.data);
    if (seen.length > 4) seen.shift();
  } catch {
    /* not json */
  }
});

async function signIn(who) {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  /* ⚠️ Three inputs, not two — the tenant slug is typed by hand (D-1, TD-40). */
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
}

try {
  await signIn(ADMIN);

  /* ── 1 · the page reports the running bridge ───────────────────────────────────────────────── */
  console.log('1 · the page');
  await page.goto(`${B}/system/event-bridge`, { waitUntil: 'domcontentloaded' });
  await page
    .getByText('Broker reachable')
    .or(page.getByText('The broker has not been contacted yet'))
    .or(page.getByText('The event bridge is not enabled here'))
    .first()
    .waitFor({ timeout: 25_000 });
  await sleep(3000);
  await page.screenshot({ path: `${OUT}/event-bridge.png`, fullPage: true });

  const body = await page.locator('body').innerText();
  const payload = seen[seen.length - 1];
  check(payload !== undefined, 'the page fetched the bridge endpoint', payload === undefined ? 'no payload seen' : 'payload captured');
  check(payload?.enabled === true, 'the bridge is enabled in this deployment');
  check(/Broker reachable/.test(body), 'and the page says the broker is reachable');

  /* ── 2 · every number traces to a payload ──────────────────────────────────────────────────── */
  console.log('\n2 · nothing on screen is invented');
  /*
   * ⚠️ The published count is compared against ANY of the recent payloads, not the last one. The
   * page polls every five seconds and the bridge publishes continuously, so pinning to one payload
   * is a race that fails at random — and a check that fails at random is a check nobody reads.
   */
  /*
   * ⚠️ Case-INSENSITIVE, because `innerText` returns RENDERED text and every label on this page
   * carries Tailwind's `uppercase`. The DOM says "Published" and the screen says "PUBLISHED"; a
   * case-sensitive match fails against a page that is entirely correct, and reads as "the figure is
   * missing". `textContent` would return the source text — but the point of a browser check is what
   * an operator actually sees.
   */
  const publishedOnScreen = (body.match(/published\s*\n\s*([\d,]+)/i) ?? [])[1]?.replace(/,/g, '');
  const publishedInPayloads = new Set(seen.map((p) => String(p?.published)));
  check(
    publishedOnScreen !== undefined && publishedInPayloads.has(publishedOnScreen),
    'the published count on screen came from a payload the page received',
    `screen ${publishedOnScreen} · payloads ${[...publishedInPayloads].join(', ')}`,
  );

  const latencyOnScreen = (body.match(/([\d.]+) ms/) ?? [])[1];
  const latencyInPayloads = new Set(
    seen.filter((p) => p?.publishMsAvg !== null && p?.publishMsAvg !== undefined).map((p) => p.publishMsAvg.toFixed(2)),
  );
  check(
    latencyOnScreen === undefined || latencyInPayloads.has(latencyOnScreen),
    'so did the publish latency',
    latencyOnScreen === undefined ? 'not rendered' : `screen ${latencyOnScreen} ms`,
  );

  /*
   * ⚠️ THE assertion of this file, and the one the tracking statistics page failed.
   *
   * When the payload says `null`, the screen must say "Not measured" — and when it says a number,
   * the screen must NOT. A page that hard-codes either answer passes half of this and fails the
   * other half, which is exactly what a hard-coded string cannot do.
   */
  const latencyIsNull = payload?.publishMsAvg === null || payload?.publishMsAvg === undefined;
  const screenSaysNotMeasured = /Not measured/.test(body);
  check(
    latencyIsNull === screenSaysNotMeasured || (!latencyIsNull && !screenSaysNotMeasured),
    '⚠️ "Not measured" tracks the PAYLOAD — it is neither hard-coded nor suppressed',
    `payload publishMsAvg=${payload?.publishMsAvg ?? 'null'} · screen ${screenSaysNotMeasured ? 'says' : 'does not say'} "Not measured"`,
  );
  check(
    !(latencyIsNull && /0\.00 ms/.test(body)),
    '⚠️ an unmeasured average is never rendered as 0.00 ms (ADR-0039)',
  );

  /* ── 3 · the four reasons stay four ────────────────────────────────────────────────────────── */
  console.log('\n3 · four reasons a frame did not publish, kept apart');
  /*
   * ⚠️ Each label must be followed by ITS OWN NUMBER, not merely appear somewhere on the page. The
   * first version tested for the word alone — and "Suppressed" passed on the explanatory paragraph
   * beneath the card ("Suppressed and out-of-order are normal") while the figure above it was not
   * being read at all. A check that a page mentions a word is not a check that it reports a value.
   */
  for (const label of ['Rejected', 'Suppressed', 'Dropped', 'Out of order']) {
    const figure = body.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'));
    check(figure !== null, `"${label}" is its own figure`, figure?.[1] ?? 'no value beneath the label');
  }
  check(
    /Only .*failed.* is a fault/i.test(body.replace(/[“”"']/g, '')),
    '⚠️ and the page says which one of them is a fault',
  );

  /* ── 4 · the queue depth is shown against its bound ────────────────────────────────────────── */
  console.log('\n4 · the queue depth carries its bound');
  const depthOnScreen = (body.match(/(\d+) \/ (\d+)/) ?? []).slice(1);
  check(
    depthOnScreen.length === 2 && Number(depthOnScreen[1]) === payload?.queuePerCamera,
    '⚠️ the depth is rendered against the deployment’s own bound, not a constant',
    depthOnScreen.length === 2 ? `${depthOnScreen[0]} / ${depthOnScreen[1]}` : 'not rendered',
  );

  /* ── 5 · versions are three separate answers ───────────────────────────────────────────────── */
  console.log('\n5 · versions');
  check(
    payload?.publisherVersion !== undefined && body.includes(payload.publisherVersion),
    'the publisher version on screen is the one the payload reported',
    payload?.publisherVersion,
  );
  check(
    payload?.payloadSchemaVersion === undefined
      ? /Not observed/.test(body)
      : body.includes(payload.payloadSchemaVersion),
    '⚠️ the payload schema version is REPORTED or said to be unobserved — never assumed',
    payload?.payloadSchemaVersion ?? 'not observed',
  );

  /* ── 6 · the page steers nothing ───────────────────────────────────────────────────────────── */
  console.log('\n6 · no operator controls');
  /*
   * ⚠️ Counted in the CONTENT REGION, not the whole document — the shell's navigation and sign-out
   * are buttons and would make this assertion impossible to satisfy on a page that is entirely
   * read-only. What must not exist is a flush, drain, retry or per-camera toggle.
   */
  const main = page.locator('main').first();
  const controls = await main.locator('button, input, select, textarea').count();
  const controlText = await main.locator('button').allInnerTexts();
  check(controls === 0, 'the page carries no control at all', `${controls} found: ${controlText.join(' · ') || 'none'}`);
  check(/Reported, not editable/.test(body), 'and says so, rather than leaving it to be inferred');
  check(!/flush|drain|retry now|restart/i.test(body), 'no flush, drain or retry action is offered');

  /* ── 7 · a viewer cannot read deployment state ─────────────────────────────────────────────── */
  console.log('\n7 · permission');
  await page.goto(`${B}/logout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await context.clearCookies();
  await signIn(VIEWER);
  await page.goto(`${B}/system/event-bridge`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const viewerBody = await page.locator('body').innerText();
  await page.screenshot({ path: `${OUT}/event-bridge-viewer.png`, fullPage: true });
  check(
    /Not authorized/i.test(viewerBody),
    '⚠️ a viewer is refused — this is deployment state behind system:inspect',
  );
  check(
    !/Broker reachable/.test(viewerBody),
    'and sees no bridge numbers at all',
  );
} finally {
  await browser.close().catch(() => {});
  await login();
  await removeCameras();
  docker('rm', '-f', FIXTURE);
}

console.log(
  failures === 0
    ? '\nthe event bridge page reports only what the publisher measured\n'
    : `\n${failures} browser check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
