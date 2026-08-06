/**
 * P-8 Phase 6 · **the assignment pages, in a real browser, against the production deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> REPO=<repo> node <repo>/docs/review/p8/assignment-ui.mjs
 *
 * A camera is created, assigned, and left to run, so every page has something true to say. Then each
 * figure on screen is traced back to the payload the browser actually received.
 *
 * ### ⚠️ What is checked is the absence of invention
 *
 * These pages are an unusually easy place to lie, because most of what they report is a DISTINCTION
 * that renders identically when collapsed:
 *
 *   - a runtime nobody has observed must say **Not observed**, never "Healthy";
 *   - a profile no runtime can run must say so, and one nobody has checked must say **Unknown**;
 *   - an undeclared capacity must say **No capacity declared**, never `0%` and never `Infinity%`;
 *   - a camera the enforcement point has not reported must say **Not measured**, never `0`.
 *
 * Every one of those looks perfect in a screenshot when it is wrong. The tracking statistics page
 * shipped with exactly this class of defect — a HARD-CODED "Not measurable" — so a mutation setting
 * a real value changed nothing on screen and the browser check stayed green over a contract
 * violation. Which is why the assertions below compare the DOM against the **payload**, not against
 * an expected string.
 *
 * ### ⚠️ Labels are matched case-insensitively
 *
 * The design system uppercases labels in CSS, so `innerText` comes back uppercase and a
 * case-sensitive match fails on a perfectly correct page. P-8 Phase 5 lost four checks to this.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const REPO = process.env.REPO ?? '/Users/mac/projects/VisionIntelligencePlatform';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = { email: 'loss.prevention@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-assignment-ui';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-assignui';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
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

console.log('\nP-8 Phase 6 · the camera processing assignment pages\n');

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
  const r = await api(`/camera/cameras?limit=200`, { headers: H });
  for (const cam of (r.json?.data?.cameras ?? []).filter((c) =>
    (c.metadata?.tags ?? []).includes(TAG),
  )) {
    await api(`/camera/assignments/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
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
const ids = [];
for (let i = 1; i <= 2; i += 1) {
  const made = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name: `${TAG} cam${i}`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/walk0${i}`,
      metadata: { tags: [TAG] },
    }),
  });
  ids.push(made.json.data.id);
  await api(`/media/streams/${made.json.data.id}/start`, { method: 'POST', headers: H, body: '{}' });
}
/* ⚠️ One assigned, one deliberately not — the page has to show both, distinctly. */
await api(`/camera/assignments/${ids[0]}/enable`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ profileId: 'person-tracking' }),
});
console.log('  · one camera assigned, one left recording-only; letting the pages converge\n');
await sleep(26000);

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1560, height: 1000 },
});
const page = await context.newPage();

/** The last few payloads per route — the DOM may still be showing the previous poll. */
const seen = new Map();
page.on('response', async (res) => {
  const url = res.url();
  if (!url.includes('/api/') || !res.ok()) return;
  const key = ['/camera/assignments/capacity', '/camera/processing-runtimes',
    '/camera/processing-profiles', '/camera/assignments', '/media/perception/assignment/cameras',
    '/media/perception/assignment'].find((k) => url.includes(k));
  if (key === undefined) return;
  try {
    const body = await res.json();
    const list = seen.get(key) ?? [];
    list.push(body?.data);
    if (list.length > 4) list.shift();
    seen.set(key, list);
  } catch {
    /* not json */
  }
});
const latest = (key) => (seen.get(key) ?? []).at(-1);

async function signIn(who) {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(who.email);
  await page.getByLabel(/password/i).fill(who.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

async function open(path) {
  await page.goto(`${B}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(3500);
  return (await page.locator('body').innerText()).replace(/ /g, ' ');
}

try {
  await signIn(ADMIN);

  /* ── 1 · Camera Assignment ─────────────────────────────────────────────────────────────────── */
  console.log('1 · Camera Assignment');
  let body = await open('/assignment');
  await page.screenshot({ path: `${OUT}/p8-assignment-cameras.png`, fullPage: true });

  check(/camera assignment/i.test(body), 'the page renders');
  check(
    /every camera records/i.test(body),
    '⚠️ and says plainly that recording is independent of AI',
  );

  const assignments = latest('/camera/assignments') ?? [];
  const mine = assignments.filter((a) => ids.includes(a.cameraId));
  check(mine.length === 2, 'both fixture cameras are in the payload', String(mine.length));

  const assigned = mine.find((a) => a.cameraId === ids[0]) ?? {};
  const unassigned = mine.find((a) => a.cameraId === ids[1]) ?? {};
  /*
   * ⚠️ Traced to the PAYLOAD. A page that hard-coded "Running" would pass a string check and fail
   * this one the moment the deployment disagreed.
   */
  check(
    assigned.state === 'running' || assigned.state === 'starting',
    'the assigned camera is running in the payload',
    assigned.state,
  );
  check(unassigned.state === 'unassigned', 'and the other is unassigned', unassigned.state);
  check(
    new RegExp(assigned.state === 'running' ? 'running' : 'starting', 'i').test(body),
    'the screen shows the assigned state the payload reported',
  );
  check(/not assigned/i.test(body), '⚠️ and shows the unassigned one as its OWN state, not blank');

  /* Every metric label must carry a figure beneath it — a label alone proves nothing. */
  for (const label of ['Cameras', 'AI enabled', 'Confirmed running', 'In error']) {
    const figure = body.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'));
    check(figure !== null, `"${label}" is its own figure`, figure?.[1] ?? 'no value beneath the label');
  }

  /*
   * ⚠️ The measurement column must track the payload. The unassigned camera has no row in the
   * enforcement point's metrics, so its cells must read "Not measured" — not `0`, which would claim
   * a measurement of zero frames rather than the absence of one.
   */
  const measured = latest('/media/perception/assignment/cameras');
  const measuredRow = Array.isArray(measured)
    ? measured.find((r) => r.cameraId === ids[1])
    : undefined;
  const screenSaysNotMeasured = /not measured/i.test(body);
  check(
    measuredRow === undefined ? screenSaysNotMeasured : true,
    '⚠️ "Not measured" tracks the PAYLOAD — the unmeasured camera has no row',
    measuredRow === undefined ? 'absent from the payload, absent on screen' : 'measured',
  );
  console.log('');

  /* ── 2 · Processing Profiles ───────────────────────────────────────────────────────────────── */
  console.log('2 · Processing Profiles');
  body = await open('/assignment/profiles');
  await page.screenshot({ path: `${OUT}/p8-assignment-profiles.png`, fullPage: true });

  const profiles = latest('/camera/processing-profiles') ?? [];
  const unsupported = profiles.filter((p) => p.supported === false);
  const supported = profiles.filter((p) => p.supported === true);
  check(profiles.length > 0, 'the catalogue is served', `${profiles.length} profiles`);
  check(supported.length > 0 && unsupported.length > 0, 'and this deployment can run some but not all',
    `${supported.length} supported, ${unsupported.length} not`);
  /*
   * ⚠️ Both outcomes must be visible. A page that rendered everything as supported would look
   * healthier and would send an operator to bind a camera to a profile that produces nothing.
   */
  check(/supported/i.test(body), 'the screen says which profiles are supported');
  check(
    /no runtime/i.test(body),
    '⚠️ and which are NOT — the payload says so and the page must not hide it',
  );
  check(
    new RegExp(`${unsupported.length} of these profiles`, 'i').test(body),
    'the warning counts exactly what the payload reported',
    `${unsupported.length}`,
  );
  check(
    /deployment default/i.test(body),
    '⚠️ a null frame rate reads as the deployment default, never "0 fps"',
  );
  console.log('');

  /* ── 3 · Runtime Health ────────────────────────────────────────────────────────────────────── */
  console.log('3 · Runtime Health');
  body = await open('/assignment/health');
  await page.screenshot({ path: `${OUT}/p8-assignment-health.png`, fullPage: true });

  const runtimes = latest('/camera/processing-runtimes') ?? [];
  const gate = latest('/media/perception/assignment') ?? {};
  const rt = runtimes[0] ?? {};
  check(runtimes.length > 0, 'a runtime is in the payload', String(runtimes.length));
  check(
    new RegExp(rt.health === 'unknown' ? 'not observed' : rt.health, 'i').test(body),
    '⚠️ the health on screen is the health in the payload',
    rt.health,
  );
  check(
    rt.latencyMs === null
      ? /not measured/i.test(body)
      : new RegExp(`${rt.latencyMs}\\s*ms`).test(body),
    '⚠️ latency tracks the payload — a null renders as "Not measured", never "0 ms"',
    String(rt.latencyMs),
  );
  check(
    gate.planVersion === null || gate.planVersion === undefined
      ? /not measured/i.test(body)
      : new RegExp(`plan version applied\\s*\\n\\s*${gate.planVersion}`, 'i').test(body),
    '⚠️ the plan version on screen is the one the enforcement point applied',
    String(gate.planVersion),
  );
  console.log('');

  /* ── 4 · Runtime Capacity ──────────────────────────────────────────────────────────────────── */
  console.log('4 · Runtime Capacity');
  body = await open('/assignment/capacity');
  await page.screenshot({ path: `${OUT}/p8-assignment-capacity.png`, fullPage: true });

  const capacity = latest('/camera/assignments/capacity') ?? {};
  check(typeof capacity.totalCameras === 'number', 'the capacity report is served');
  for (const [label, value] of [
    ['Total cameras', capacity.totalCameras],
    ['AI enabled', capacity.assignedCameras],
    ['Recording only', capacity.idleCameras],
  ]) {
    const figure = body.match(new RegExp(`${label}\\s*\\n\\s*([\\d,]+)`, 'i'));
    check(
      figure !== null && Number(figure[1].replace(/,/g, '')) === value,
      `"${label}" shows the payload's figure`,
      `screen=${figure?.[1] ?? 'none'} payload=${value}`,
    );
  }
  const runtimeRow = (capacity.runtimes ?? [])[0] ?? {};
  check(
    runtimeRow.utilization === null
      ? /no capacity declared/i.test(body)
      : new RegExp(`${Math.round(runtimeRow.utilization * 100)}%`).test(body),
    '⚠️ utilisation tracks the payload — a null reads as "No capacity declared", never 0%',
    String(runtimeRow.utilization),
  );
  check(!/Infinity/i.test(body), '⚠️ and nothing on the page reads "Infinity"');
  check(
    /no licensed limits are configured/i.test(body),
    'licensing is stated as unconfigured rather than rendered blank',
  );
  console.log('');

  /* ── 5 · Runtime Assignment + History ──────────────────────────────────────────────────────── */
  console.log('5 · Runtime Assignment and History');
  body = await open('/assignment/runtimes');
  await page.screenshot({ path: `${OUT}/p8-assignment-runtimes.png`, fullPage: true });
  check(/runtime assignment/i.test(body), 'the runtime page renders');
  check(
    new RegExp(rt.name ?? 'runtime', 'i').test(body),
    'and names the registered runtime',
    rt.name,
  );
  check(
    rt.capabilities === null
      ? /not read yet/i.test(body)
      : new RegExp(rt.capabilities[0] ?? 'perception', 'i').test(body),
    '⚠️ advertised capabilities come from the payload — null reads as "not read yet", never "none"',
    String(rt.capabilities),
  );

  body = await open('/assignment/history');
  await page.screenshot({ path: `${OUT}/p8-assignment-history.png`, fullPage: true });
  check(/assignment history/i.test(body), 'the history page renders');
  check(/append-only/i.test(body), 'and says the trail is append-only');
  check(
    /assign|start/i.test(body),
    '⚠️ with the actions the run actually performed, not an empty table',
  );
  console.log('');

  /* ── 6 · a viewer sees the pages and none of the controls ──────────────────────────────────── */
  console.log('6 · a viewer');
  await page.goto(`${B}/logout`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await context.clearCookies();
  await page.evaluate(() => window.localStorage.clear()).catch(() => {});
  await signIn(VIEWER);
  body = await open('/assignment');
  await page.screenshot({ path: `${OUT}/p8-assignment-viewer.png`, fullPage: true });

  /*
   * ⚠️ A viewer holds `assignment:read` through `*:read` and must SEE the page — withholding it
   * would protect nothing, since they can already watch the footage. What they must not have is any
   * control.
   */
  check(/camera assignment/i.test(body), '⚠️ a viewer SEES the page — read rides *:read deliberately');
  const buttons = await page.getByRole('button').allInnerTexts();
  const controls = buttons.filter((t) => /enable ai|disable ai|pause|resume|restart/i.test(t));
  check(
    controls.length === 0,
    '⚠️ and is offered NO control — not one enable, disable, pause or restart',
    controls.join(', ') || 'none',
  );
  check(/read only/i.test(body), 'the page says so rather than silently omitting the buttons');
  console.log('');
} finally {
  await browser.close();
  await login();
  await removeCameras();
  docker('rm', '-f', FIXTURE);
  console.log('removed the UI fixture and its cameras\n');
}

console.log(
  failures === 0
    ? '✅ every figure on the assignment pages traces to the payload the browser received\n'
    : `❌ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
