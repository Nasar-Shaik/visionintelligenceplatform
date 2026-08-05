/**
 * P-8 Phase 3 · **the AI Runtime page, in a real browser, against the production deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p8/runtime-ui.mjs
 *
 * The page reports on inference. So the run does the one thing that makes that testable: it starts
 * a camera pointed at a photograph of two people, watches the numbers appear, then **stops the
 * runtime underneath the open page** and watches them turn into an honest failure. Nobody refreshes
 * the browser — an operator watching a deploy does not know to.
 *
 * ### ⚠️ What is checked is the absence of invention
 *
 * A dashboard is the easiest place in a product to lie: a `0` where nothing was measured, a green
 * tick where nothing was asked, a "GPU 0%" on a machine with no GPU. Each of those is asserted
 * against here, on the rendered DOM, because they are all things that look right in a screenshot.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const REPO = process.env.REPO ?? '/Users/mac/projects/VisionIntelligencePlatform';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = { email: 'loss.prevention@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-rtsp-fixture';
const RUNTIME = 'vip-prod-inference-1';
const TAG = 'p8-ui';

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

/* ── a camera looking at two people, so the page has something true to say ────────────────────── */
console.log('\nP-8 Phase 3 · the AI Runtime page\n');

const login = await api('/identity/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
  body: JSON.stringify(ADMIN),
});
const H = { authorization: `Bearer ${login.json.data.accessToken}`, 'content-type': 'application/json' };

async function cleanup() {
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  for (const cam of (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG))) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
  }
  docker('rm', '-f', FIXTURE);
}
await cleanup();

docker(
  'run', '-d', '--rm', '--name', FIXTURE, '--network', 'vip-prod_default',
  '-v', `${REPO}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${REPO}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const made = await api('/camera/cameras', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    zoneId,
    name: `${TAG} scene`,
    protocol: 'rtsp',
    streamUrl: `rtsp://${FIXTURE}:8554/p8ui`,
    metadata: { tags: [TAG] },
  }),
});
const camId = made.json?.data?.id;
await api(`/media/streams/${camId}/start`, { method: 'POST', headers: H, body: '{}' });
await sleep(15000);

/* ── the browser ─────────────────────────────────────────────────────────────────────────────── */
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
const page = await context.newPage();

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 160)}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const polls = [];
page.on('request', (r) => r.url().includes('/api/system/ai-runtime') && polls.push(Date.now()));

/*
 * ⚠️ **The payload the PAGE received, not one this script fetches separately.**
 *
 * Section 2 asks whether every number on screen came from the deployment. Answering it with a fresh
 * API call is a race: the page renders a payload up to one poll interval old, so any counter that
 * moves — frames processed, detections, uptime — differs between the two reads and a truthful page
 * is reported as fabricating numbers. That produced exactly one false red before this was fixed.
 * Capturing the response the page itself consumed makes the comparison exact rather than tolerant,
 * and a tolerance wide enough to absorb the drift would be wide enough to absorb an invented number.
 */
const seen = { data: null, at: 0 };
page.on('response', async (r) => {
  if (!r.url().includes('/api/system/ai-runtime') || !r.ok()) return;
  try {
    const body = await r.json();
    if (body?.data) {
      seen.data = body.data;
      seen.at = Date.now();
    }
  } catch {
    /* a body that is not JSON is not this check's business */
  }
});

async function signIn(user) {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
}

console.log('1 · the page renders what the deployment is doing');
await signIn(ADMIN);
await page.goto(`${B}/system/ai-runtime`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('text=Execution provider', { timeout: 20_000 });
await sleep(2500);

{
  const body = await page.locator('main').innerText();
  check(/AI Runtime/.test(body), 'the page is titled for what it reports');
  check(/CPUExecutionProvider/.test(body), 'the execution provider is the measured one', 'CPUExecutionProvider');
  check(/yolox-nano/.test(body), 'the loaded model is named');
  check(/READY/.test(body), 'the capability state is shown');
  check(/Healthy/.test(body), 'health is derived, not asserted');
  check(/person/.test(body), '⚠️ and it shows what was actually SEEN — `person`, from a real photograph');
  check(/Apache-2\.0/.test(body), 'the registered model’s licence is visible to whoever operates it');
  check(/letterbox-416x416/.test(body), 'the preprocessing fingerprint is rendered, so a result can be reproduced');

  // ⚠️ The three ways a dashboard lies, asserted against the rendered DOM.
  check(/none in this deployment/.test(body), '⚠️ GPU says “none in this deployment”, not “0%”');
  check(!/NaN|undefined|\[object Object\]/.test(body), 'nothing rendered as NaN, undefined or [object Object]');
  check(errors.length === 0, 'the browser logged no errors', errors.join(' | ').slice(0, 200));

  await page.screenshot({ path: `${OUT}/p8-ai-runtime-healthy.png`, fullPage: true });
}

console.log('\n2 · every number on the page came from the runtime');
{
  /*
   * ⚠️ **Traced per value cell, not by scraping the page for digits.**
   *
   * A dashboard's characteristic failure is not a crash — it is a plausible number that nothing
   * produced, invisible in a screenshot. So every value the operator can read must be findable in
   * the payload the page received.
   *
   * ⚠️ The first version regex-matched every number in `main.innerText()` and reported the version
   * string `0.1.0` and the pieces of a rendered date (`2026`, `54`, `11`) as fabrications. It was
   * wrong in the direction that matters least — a false alarm — but a check that cries wolf is one
   * that gets deleted, so it now reads `<dt>`/`<dd>` pairs and explains a cell by **any** of:
   * a number in the payload, a string in the payload (versions, ids, fingerprints), or a date that
   * parses to a payload timestamp. A fabricated number is none of those.
   */
  const shown = await page.locator('main').innerText();
  check(seen.data !== null, 'the page fetched the runtime view and this run captured it');

  const numbers = [];
  const strings = [];
  const walk = (node) => {
    if (typeof node === 'number') numbers.push(node);
    else if (typeof node === 'string') strings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(seen.data ?? {});
  const timestamps = strings
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t));

  const cells = await page.locator('main dl > div').evaluateAll((nodes) =>
    nodes.map((n) => ({
      label: n.querySelector('dt')?.textContent?.trim() ?? '',
      value: n.querySelector('dd')?.textContent?.trim() ?? '',
    })),
  );

  const explains = (value) => {
    const text = value.trim();
    if (text === '') return true;
    // A string the deployment reported — a version, a model id, a preprocessing fingerprint.
    if (strings.some((s) => s === text || text.includes(s))) return true;
    // A rendered timestamp that resolves to one the deployment reported (a minute of slack for
    // formatting and the poll interval).
    const asDate = Date.parse(text);
    if (!Number.isNaN(asDate) && timestamps.some((t) => Math.abs(t - asDate) < 60_000)) return true;
    // Otherwise every number in the cell must trace to a number in the payload.
    const found = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    if (found.length === 0) return true;
    return found.every((v) =>
      numbers.some(
        (source) =>
          source === v ||
          Math.round(source) === v ||
          Number(source.toFixed(1)) === v ||
          Number(source.toFixed(2)) === v ||
          Math.round(source / 60) === v ||
          Math.round(source % 60) === v,
      ),
    );
  };

  const unexplained = cells.filter((c) => !explains(c.value));
  check(
    cells.length > 0,
    'the page renders labelled value cells to check',
    `${cells.length} cell(s)`,
  );
  check(
    unexplained.length === 0,
    '⚠️ every number rendered traces to a value the deployment reported',
    unexplained.length
      ? `unexplained: ${unexplained.slice(0, 5).map((c) => `${c.label}="${c.value}"`).join(', ')}`
      : `${cells.length} cells checked`,
  );

  // ⚠️ Scoped to the GPU row, not the whole page. A blanket "no 0 %" ban fires on a truthful page
  // the moment any genuinely-measured percentage is zero — a dropped-frame rate of 0 % is the
  // platform working, and a check that calls that a fabrication trains people to ignore it.
  const gpuCell = cells.find((c) => /gpu/i.test(c.label));
  check(
    gpuCell !== undefined && !/%/.test(gpuCell.value),
    'no "0 %" stands in for a thing that does not exist',
    gpuCell ? `GPU = "${gpuCell.value}"` : 'no GPU row found',
  );
  check(
    /not measured|none in this deployment/.test(shown),
    'the page has a vocabulary for "nothing produced this"',
  );
}

console.log('\n3 · the polling budget, measured over a real minute');
{
  polls.length = 0;
  await sleep(60_000);
  // 5s interval → ~12 in a minute. The assertion is an upper bound: a page that polls faster than
  // it says it does is load on the one service that writes evidence.
  check(polls.length >= 8 && polls.length <= 16, 'the page polls at the interval it claims', `${polls.length} requests/min`);

  await page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  polls.length = 0;
  await sleep(15_000);
  check(polls.length === 0, '⚠️ and stops when the operator navigates away', `${polls.length} requests`);
  await page.goto(`${B}/system/ai-runtime`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Execution provider', { timeout: 20_000 });
}

console.log('\n4 · the runtime is stopped underneath the open page');
{
  docker('stop', RUNTIME);
  // ⚠️ Nobody refreshes. The page must reach the truth on its own, within its own poll interval.
  await page.waitForSelector('text=/not answering/i', { timeout: 30_000 }).catch(() => {});
  await sleep(2000);
  const body = await page.locator('main').innerText();
  check(/not answering/i.test(body), '⚠️ the page says so without being refreshed');
  check(
    /Recording and evidence are unaffected/i.test(body),
    '⚠️ and says the thing an operator actually needs — perception failing is not recording failing',
  );
  check(!/Healthy/.test(body), 'it does not still claim health');
  await page.screenshot({ path: `${OUT}/p8-ai-runtime-unreachable.png`, fullPage: true });

  docker('start', RUNTIME);
  await page.waitForSelector('text=Execution provider', { timeout: 60_000 }).catch(() => {});
  await sleep(3000);
  const recovered = await page.locator('main').innerText();
  check(/CPUExecutionProvider/.test(recovered), 'and recovers on its own when the runtime returns');
}

console.log('\n5 · a viewer is refused, and told so plainly');
{
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear()).catch(() => {});
  await signIn(VIEWER);
  await page.goto(`${B}/system/ai-runtime`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const body = await page.locator('main').innerText();
  check(/Not authorized/i.test(body), 'the page refuses a viewer');
  check(
    /says nothing about whether inference is working/i.test(body),
    '⚠️ and does not let the refusal read as an all-clear',
  );
  check(!/yolox-nano|CPUExecutionProvider/.test(body), 'and leaks no runtime detail to them');

  const nav = await page.locator('nav').innerText();
  check(!/AI Runtime/.test(nav), 'the sidebar does not advertise a page they cannot open');
  await page.screenshot({ path: `${OUT}/p8-ai-runtime-forbidden.png`, fullPage: true });
}

await browser.close();
await cleanup();
console.log(failures === 0 ? '\n✓ the AI Runtime page verified in a browser\n' : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
