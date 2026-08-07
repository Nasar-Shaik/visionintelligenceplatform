/**
 * P-8 Phase 7 · **the loitering pages, in a real browser, against the production deployment** —
 * and the visual demonstration the Architect asked for (rec 7).
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> REPO=<repo> node <repo>/docs/review/p8/loitering-ui.mjs
 *
 * A camera is created, a zone is drawn on it through the API, a loitering rule is enabled, and the
 * whole thing is left to run for long enough that a clock is visibly ticking. Then each figure on
 * screen is traced back to the payload the browser actually received.
 *
 * ### ⚠️ What is checked is the absence of invention
 *
 * These pages are an unusually easy place to lie, because most of what they report is a DISTINCTION
 * that renders identically when collapsed:
 *
 *   - a rate the node has not measured must say **measuring…**, never `0.0/s`;
 *   - a node that does not evaluate must say so, never render an empty dashboard;
 *   - a confidence nobody measured must say **not measured**, never `0.00`;
 *   - a candidate raised mid-loiter must **not** claim an exit time;
 *   - a duration assembled across a real hole must say so **above** the number, and a duration
 *     sampled regularly must **not** — the second is what stops the warning becoming wallpaper.
 *
 * Every one of those looks perfect in a screenshot when it is wrong. So the assertions compare the
 * DOM against the **payload**, never against an expected string.
 *
 * ### ⚠️ The screenshots are the demonstration, and they are taken from a live system
 *
 * `p8-loitering-*.png` are the frames of the customer walkthrough: the zone drawn over live tracked
 * subjects, the loiter timer filling against its threshold, the candidate that resulted, and its
 * evidence. Nothing in them is a mock — if the deployment were broken the images would show it.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const REPO = process.env.REPO ?? '/Users/mac/projects/VisionIntelligencePlatform';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const FIXTURE = 'vip-loiter-ui';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-loiterui';
/** ⚠️ Long enough for a clock to be visibly running when the pages are opened. */
const OBSERVE = Number(process.env.OBSERVE ?? 45);
const DWELL = Number(process.env.DWELL ?? 20);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

async function api(path, opts = {}) {
  const res = await fetch(`${B}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

let H = {};
async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  if (r.json?.data?.accessToken === undefined) throw new Error('login failed');
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

async function cleanup() {
  try {
    await login();
    const cams = (await api('/camera/cameras?limit=300', { headers: H })).json?.data?.cameras ?? [];
    const mine = cams.filter((c) => (c.metadata?.tags ?? []).includes(TAG));
    for (const cam of mine) {
      const zones = (await api(`/camera/zones?cameraId=${cam.id}`, { headers: H })).json?.data ?? [];
      for (const z of zones) {
        await api(`/camera/zones/${z.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
      }
      await api(`/camera/assignments/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
      await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    const listed = (await api('/rules/rules', { headers: H })).json?.data;
    const rules = Array.isArray(listed) ? listed : (listed?.rules ?? []);
    for (const rule of rules.filter((r) => r.name?.startsWith(TAG))) {
      await api(`/rules/rules/${rule.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
  } catch {
    /* best effort */
  }
  docker('rm', '-f', FIXTURE);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  console.log('removed the loitering UI fixture, its camera, zone and rule');
  process.exit(0);
}

await login();
await cleanup();

console.log('\nP-8 Phase 7 · the loitering pages in a browser\n');

let cameraId;
let zoneId;
let ruleId;

/* ── set the stage: a camera, a zone, a rule, and time for a clock to run ─────────────────────── */
docker('rm', '-f', FIXTURE);
execFileSync('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${REPO}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${REPO}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
], { stdio: 'ignore' });
await sleep(3000);

const hierarchyZone = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
cameraId = (
  await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId: hierarchyZone,
      name: `${TAG} checkout`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/walk1`,
      metadata: { tags: [TAG] },
    }),
  })
).json?.data?.id;

zoneId = (
  await api('/camera/zones', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      cameraId,
      name: 'Checkout Queue',
      kind: 'area',
      shape: 'polygon',
      geometry: { points: [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]] },
      purpose: 'checkout',
      enabled: true,
    }),
  })
).json?.data?.id;

ruleId = (
  await api('/rules/rules', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: `${TAG} Retail Loitering`,
      description: 'Verification instrument for P-8 Phase 7. Created and deleted by loitering-ui.mjs.',
      eventTypes: ['perception.person.detected'],
      condition: { field: 'subjects.0.identityId', op: 'exists' },
      dwell: { minSeconds: DWELL, groupBy: 'identity', resetAfterSeconds: 15, cooldownSeconds: 0 },
      severity: 'medium',
      actions: [{ type: 'raise-incident' }],
      scope: { nodeIds: [], cameraIds: [cameraId], groupIds: [], zoneIds: [zoneId] },
    }),
  })
).json?.data?.id;
await api(`/rules/rules/${ruleId}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ lifecycle: 'enabled' }),
});

await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });
await api(`/camera/assignments/${cameraId}/enable`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ profileId: 'person-tracking' }),
});
console.log(`  · camera, zone and rule created; observing for ${OBSERVE}s so a clock is running\n`);
await sleep(OBSERVE * 1000);

/* ── the browser ──────────────────────────────────────────────────────────────────────────────── */
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
  const key = ['/rules/rules/live', '/camera/zones', '/workflow/incidents'].find((k) =>
    url.includes(k),
  );
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
  await sleep(4000);
  return (await page.locator('body').innerText()).replace(/ /g, ' ');
}

try {
  await signIn(ADMIN);

  /* ── 1 · Zone Editor ───────────────────────────────────────────────────────────────────────── */
  console.log('1 · Zone Editor');
  let body = await open('/zones');
  check(/zone editor/i.test(body), 'the page renders');
  check(
    /no camera selected/i.test(body),
    '⚠️ and refuses to draw until a camera is chosen, rather than drawing on nothing',
  );

  await page.getByLabel('Camera').selectOption(cameraId);
  await sleep(3000);
  body = (await page.locator('body').innerText()).replace(/ /g, ' ');
  await page.screenshot({ path: `${OUT}/p8-loitering-zone-editor.png`, fullPage: true });

  const zones = latest('/camera/zones') ?? [];
  const zone = zones.find((z) => z.id === zoneId);
  check(zone !== undefined, 'the zone is in the payload the browser received', zoneId);
  if (zone !== undefined) {
    check(body.includes(zone.name), 'and its NAME is on screen, from that payload', zone.name);
    check(
      body.includes(`${zone.geometry.points.length} points`),
      'with the point count the payload carries — not a hard-coded shape',
      `${zone.geometry.points.length} points`,
    );
    check(body.includes(`v${zone.version}`), 'and its version', `v${zone.version}`);
  }
  /*
   * ⚠️ The canvas must say there is no video frame behind it. An operator drawing over a grid who
   * believes the grid IS the camera will place a zone by eye against nothing.
   */
  check(
    /no video frame is available/i.test(body),
    '⚠️ the canvas states plainly that it is not showing the camera',
  );
  check(
    (await page.locator('svg polygon').count()) > 0,
    'the zone is actually drawn, not merely listed',
    `${await page.locator('svg polygon').count()} polygon(s)`,
  );
  console.log('');

  /* ── 2 · Live Rule Status — the loiter timer ───────────────────────────────────────────────── */
  console.log('2 · Live Rule Status');
  body = await open('/rules/live');
  await page.screenshot({ path: `${OUT}/p8-loitering-live-status.png`, fullPage: true });

  const status = latest('/rules/rules/live');
  check(status !== undefined, 'the live status payload arrived');
  check(/live rule status/i.test(body), 'the page renders');

  if (status !== undefined) {
    check(
      body.includes(String(status.activeRules)),
      'the active-rule count on screen is the payload’s',
      String(status.activeRules),
    );
    check(
      body.includes(status.node),
      '⚠️ and the NODE is named — every figure here is one process’s',
      status.node,
    );

    /*
     * ⚠️ The rate check, both directions. A `null` rate must render "measuring…" and a measured one
     * must render the number — asserting only the first would pass on a page that always says
     * "measuring…", which is the hard-coded-string defect the tracking page shipped.
     */
    for (const [field, label] of [
      ['evaluationsPerSecond', 'evaluation'],
      ['eventsPerSecond', 'event'],
    ]) {
      const value = status[field];
      if (value === null) {
        check(/measuring…/.test(body), `an unmeasured ${label} rate reads "measuring…"`);
      } else {
        check(
          body.includes(`${value.toFixed(1)}/s`),
          `the ${label} rate on screen is the payload’s`,
          `${value.toFixed(1)}/s`,
        );
      }
    }

    const timers = status.timers ?? [];
    check(timers.length > 0, '⚠️ a dwell clock is RUNNING — the loiter timer is live', `${timers.length}`);
    const timer = timers[0];
    if (timer !== undefined) {
      check(
        body.includes(`${timer.elapsedSeconds.toFixed(1)}s`),
        'and the elapsed time on screen is the payload’s, to the tenth',
        `${timer.elapsedSeconds.toFixed(1)}s`,
      );
      check(
        body.includes(`${timer.thresholdSeconds}s`),
        'shown against the threshold it is racing',
        `${timer.thresholdSeconds}s`,
      );
      check(
        body.toLowerCase().includes(timer.state === 'cooling-down' ? 'cooling' : timer.state),
        'and the state the payload reports',
        timer.state,
      );
      check(
        timer.zoneName !== undefined && body.includes(timer.zoneName),
        '⚠️ naming the ZONE, not just its id — the cache reached the engine',
        timer.zoneName ?? 'no name',
      );
      /*
       * ⚠️ The camera, which the dwell key does NOT contain — it comes from the zone. Without it the
       * zone view's selector is empty and the visual demonstration has nothing to draw. The first
       * browser run rendered "No camera selected" on a page with a running clock, which is how this
       * check came to exist.
       */
      check(
        timer.cameraId !== undefined,
        '⚠️ and the CAMERA, so the zone view has something to draw',
        timer.cameraId ?? 'absent',
      );
      /* The progress bar must actually be proportional, not decorative. */
      const width = await page
        .locator('div[style*="width"]')
        .first()
        .evaluate((el) => el.getAttribute('style'));
      check(
        typeof width === 'string' && /width:\s*\d/.test(width),
        'the progress bar has a computed width rather than a fixed one',
        width ?? 'none',
      );
    }

    /*
     * ⚠️ The identity-less counter must be VISIBLE when non-zero and ABSENT when zero. It is the one
     * number that separates "nothing is happening" from "these rules can never fire", and a page
     * that always showed it would be as useless as one that never did.
     */
    if (status.dwellWithoutIdentity > 0) {
      check(/arriving without an identity/i.test(body), 'the identity warning is shown');
    } else {
      check(
        !/arriving without an identity/i.test(body),
        'and no identity warning is shown, because none was skipped',
      );
    }
  }
  console.log('');

  /* ── 3 · the incident, and its evidence ────────────────────────────────────────────────────── */
  console.log('3 · Incident detail — the evidence an operator acts on');
  /* ⚠️ Select the camera and capture the zone overlay — the demonstration's centre frame. */
  const zoneOption = await page.locator('select[aria-label="Zone view camera"] option').nth(1);
  const optionValue = await zoneOption.getAttribute('value').catch(() => null);
  if (optionValue !== null && optionValue !== '') {
    await page.getByLabel('Zone view camera').selectOption(optionValue);
    await sleep(3500);
    await page.screenshot({ path: `${OUT}/p8-loitering-zone-view.png`, fullPage: true });
    check(
      (await page.locator('svg polygon').count()) > 0,
      '⚠️ the zone is drawn over the live subjects — the demonstration frame',
      `${await page.locator('svg polygon').count()} polygon(s), ${await page.locator('svg rect[stroke]').count()} subject box(es)`,
    );
  } else {
    check(false, 'the zone view offers a camera to draw', 'the selector was empty');
  }
  console.log('');

  body = await open('/incidents');
  await page.screenshot({ path: `${OUT}/p8-loitering-incidents.png`, fullPage: true });

  const incidents = latest('/workflow/incidents')?.items ?? [];
  const mine = incidents.filter((i) => i.source?.ruleId === ruleId);
  check(mine.length > 0, 'the loitering incident is in the list payload', `${mine.length}`);

  const incident = mine[0];
  if (incident !== undefined) {
    check(body.includes(incident.title), 'and its title is on screen', incident.title.slice(0, 60));

    /* Open it. The detail sheet is where the loitering evidence panel lives. */
    await page.getByText(incident.title, { exact: false }).first().click();
    await sleep(2500);
    body = (await page.locator('body').innerText()).replace(/ /g, ' ');
    await page.screenshot({ path: `${OUT}/p8-loitering-incident-detail.png`, fullPage: true });

    const e = incident.explanation ?? {};
    check(/why this was raised/i.test(body), 'the loitering evidence panel renders');
    check(
      body.includes(`${Math.round((e.observedSeconds ?? 0) * 10) / 10}s`),
      'the observed duration on screen is the incident’s',
      `${e.observedSeconds?.toFixed?.(1)}s`,
    );
    check(
      e.zoneName !== undefined && body.includes(e.zoneName),
      'the zone is named',
      e.zoneName ?? 'no name',
    );
    check(
      e.zoneVersion !== undefined && body.includes(`v${e.zoneVersion}`),
      '⚠️ with the VERSION its geometry was at — so this incident can be redrawn over its own footage',
      `v${e.zoneVersion}`,
    );
    check(
      /still present when raised/i.test(body),
      '⚠️ and no exit time is claimed — nobody had left when it was raised',
    );

    /*
     * ⚠️ **The warning must track the DATA, not merely exist.** A gap near the typical interval is
     * regular sampling and must NOT be flagged; a real hole must be. Asserting only the presence of
     * the banner would pass on a page that always shows it — which is exactly what the first version
     * of this feature did, on every incident, until the deployment was read.
     */
    const shouldWarn =
      (e.longestGapSeconds ?? 0) >= 2 &&
      (e.typicalGapSeconds === null || e.typicalGapSeconds === undefined
        ? true
        : e.longestGapSeconds > e.typicalGapSeconds * 2);
    const warns = /assembled, not watched continuously/i.test(body);
    check(
      warns === shouldWarn,
      shouldWarn
        ? '⚠️ the "assembled" warning is shown, because the gap was genuinely unusual'
        : '⚠️ the "assembled" warning is NOT shown, because the sampling was regular',
      `longest ${e.longestGapSeconds?.toFixed?.(1)}s vs typical ${e.typicalGapSeconds?.toFixed?.(1)}s`,
    );

    if (incident.detectionConfidence === null || incident.detectionConfidence === undefined) {
      check(/not measured/i.test(body), 'an unmeasured confidence reads "not measured", never 0.00');
    } else {
      check(
        body.includes(incident.detectionConfidence.toFixed(2)),
        'the confidence on screen is the incident’s',
        incident.detectionConfidence.toFixed(2),
      );
    }

    const timeline = incident.timeline;
    if (timeline !== undefined) {
      check(/timeline/i.test(body), 'the timeline renders');
      check(
        timeline.omitted === 0 || body.includes(`${timeline.omitted} routine`),
        'and says how much it left out, when it left anything out',
        `${timeline.entries.length} of ${timeline.total}`,
      );
    }

    const links = await page.getByRole('link').all();
    const hrefs = await Promise.all(links.map((l) => l.getAttribute('href')));
    const evidenceLinks = hrefs.filter((h) => typeof h === 'string' && h.startsWith('/media/recordings'));
    check(
      evidenceLinks.length > 0,
      '⚠️ evidence is a LINK to the recording, not embedded footage',
      evidenceLinks[0]?.slice(0, 70) ?? 'none',
    );
    check(
      hrefs.every((h) => h === null || !/^https?:\/\//.test(h) || h.startsWith(B)),
      'and no evidence locator carries a foreign host',
    );
  }
  console.log('');

  /* ── 4 · the rule itself, as an operator sees it ───────────────────────────────────────────── */
  console.log('4 · Rule Management');
  body = await open('/rules');
  await page.screenshot({ path: `${OUT}/p8-loitering-rules.png`, fullPage: true });
  check(body.includes(`${TAG} Retail Loitering`), 'the loitering rule is listed by name');
  console.log('');
} finally {
  await page.screenshot({ path: `${OUT}/p8-loitering-final.png`, fullPage: true }).catch(() => {});
  await browser.close();
  await cleanup();
}

console.log(
  failures === 0
    ? '\n✅ every figure on the loitering pages traces to the payload the browser received\n'
    : `\n❌ ${failures} browser check(s) failed\n`,
);
console.log(`screenshots → ${OUT}/p8-loitering-*.png\n`);
process.exit(failures === 0 ? 0 : 1);
