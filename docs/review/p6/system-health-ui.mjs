/**
 * P-6.4 · System Health in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/system-health-ui.mjs
 *
 * ⚠️ **Three of the five screenshots are taken while the platform is actually broken.** A health
 * page photographed only against a healthy deployment proves the layout, not the product: the whole
 * value of the surface is what an operator sees at the moment something is wrong, so a service is
 * stopped and the database is paused to produce those moments for real.
 *
 * States: healthy · one service down · a total database outage · permission denied · loading ·
 *         phone. Plus responsive, accessibility, and keyboard operation of the one control.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const VIEWER = {
  email: `p64.ui.viewer.${Date.now()}@northgate.demo`,
  password: 'Probe-Password-2026!',
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const browser = await chromium.launch();
const newSession = async (creds = ADMIN, viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  const page = await context.newPage();
  const errors = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 160)}`),
  );
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page, errors };
};

/** Every component row as the operator reads it: the label and the state word beside it. */
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('main li')].map((li) => ({
      label: li.querySelector('p')?.textContent?.trim() ?? '',
      state: [...li.querySelectorAll('span, div')]
        .map((n) => n.textContent?.trim() ?? '')
        .find((t) =>
          ['Healthy', 'Degraded', 'Unavailable', 'Not configured', 'Not built', 'Unknown'].includes(
            t,
          ),
        ),
    })),
  );
/*
 * ⚠️ The summary line, not the page description. `main p` picks the `PageHeader` subtitle first,
 * which never changes — so a check written against it reports "unchanged" for a page that changed
 * completely. Matched by what the summary actually says instead.
 */
const headline = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('main p')]
        .map((n) => n.textContent?.trim() ?? '')
        .find((t) => /report(s)? (healthy|nothing)|not answering|not fully/.test(t)) ?? '',
  );

console.log('\nP-6.4 · System Health in the browser\n');

const { page, errors, context } = await newSession();

// ── loading ─────────────────────────────────────────────────────────────────────────────────────
/*
 * ⚠️ The one place the network is slowed rather than stubbed. The response is the **real** one from
 * the deployment; only its arrival is delayed, because a 3 ms round trip cannot be photographed.
 */
let delayFirst = true;
await page.route('**/api/system/health', async (route) => {
  if (delayFirst) {
    delayFirst = false;
    await sleep(2_000);
  }
  await route.continue().catch(() => {});
});
const navigation = page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await sleep(900);
const loading = await page.evaluate(() => ({
  shimmer: document.querySelectorAll('[class*="shimmer"]').length,
  rows: document.querySelectorAll('main li').length,
}));
check(loading.shimmer > 0 && loading.rows === 0, 'L1 · a shape-matched skeleton, not a spinner', `${loading.shimmer} shimmer`);
await page.screenshot({ path: `${OUT}/health-01-loading.png` });
await navigation;

// ── healthy ─────────────────────────────────────────────────────────────────────────────────────
console.log('A · a healthy deployment');
await page.waitForSelector('main li', { timeout: 20_000 });
await sleep(400);

const healthy = await rows(page);
check(healthy.length >= 19, 'A1 · every component has a row', `${healthy.length}`);
check(
  healthy.every((r) => r.state !== undefined),
  'A1 · ⚠️ every row names its state in words, not only in colour',
  healthy.filter((r) => r.state === undefined).map((r) => r.label).join(', '),
);
const headlineText = (await headline(page)) ?? '';
check(
  /report healthy/.test(headlineText),
  'A2 · the summary claims only what the rows support',
  headlineText.slice(0, 80),
);
check(
  !/all systems operational/i.test(headlineText),
  'A2 · ⚠️ and never the sentence that is true only by omission',
);
check(
  healthy.some((r) => r.state === 'Not built'),
  'A3 · what the release does not contain is on the page, not hidden',
  healthy.filter((r) => r.state === 'Not built').map((r) => r.label).join(', '),
);
await page.screenshot({ path: `${OUT}/health-02-healthy.png`, fullPage: true });

// ── one service down ────────────────────────────────────────────────────────────────────────────
console.log('\nB · with one service stopped');
docker('stop', 'vip-prod-notify-1');
try {
  await sleep(6_500);
  await page.getByRole('button', { name: /refresh/i }).click();
  await sleep(1_500);

  const down = await rows(page);
  const notify = down.find((r) => r.label === 'Notifications');
  check(notify?.state === 'Unavailable', 'B1 · the stopped service reads "Unavailable"', notify?.state);
  check(
    down.indexOf(notify) < down.findIndex((r) => r.state === 'Healthy'),
    'B2 · ⚠️ and it sorts above everything that is fine',
  );
  const banner = await page.evaluate(
    () => document.querySelector('main [role="alert"]')?.textContent ?? '',
  );
  check(/needs attention/.test(banner) && /Notifications/.test(banner), 'B3 · the banner names it', banner.slice(0, 80));
  await page.screenshot({ path: `${OUT}/health-03-service-down.png`, fullPage: true });
} finally {
  docker('start', 'vip-prod-notify-1');
}
await sleep(9_000);

// ── a total database outage ─────────────────────────────────────────────────────────────────────
console.log('\nC · with the database paused');
docker('pause', 'vip-prod-mongodb-1');
try {
  await sleep(6_500);
  await page.getByRole('button', { name: /refresh/i }).click();
  await sleep(3_000);

  const outage = await rows(page);
  const mongo = outage.find((r) => r.label === 'MongoDB');
  check(
    outage.filter((r) => r.state === 'Unavailable').length >= 8,
    'C1 · the outage is visible across the services',
    `${outage.filter((r) => r.state === 'Unavailable').length} unavailable`,
  );
  /*
   * ⚠️ The row that had vanished. Before the fix this section photographed ten red services and no
   * mention of the database — the one fact worth having.
   */
  check(mongo?.state === 'Unknown', 'C2 · ⚠️ MongoDB is still on the page, as Unknown', mongo?.state ?? 'MISSING');
  await page.screenshot({ path: `${OUT}/health-04-database-outage.png`, fullPage: true });
} finally {
  docker('unpause', 'vip-prod-mongodb-1');
}
await sleep(12_000);
await page.getByRole('button', { name: /refresh/i }).click();
await sleep(2_000);
check(
  /report healthy/.test((await headline(page)) ?? ''),
  'C3 · and the page returns to healthy once the database does',
  ((await headline(page)) ?? '').slice(0, 60),
);

// ── responsive + accessibility + keyboard ───────────────────────────────────────────────────────
console.log('\nD · responsive, accessible, operable');

await page.setViewportSize({ width: 390, height: 844 });
await sleep(900);
const clipped = await page.evaluate(() => {
  const scroller = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
    return false;
  };
  return [...document.querySelectorAll('main *')].filter(
    (el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !scroller(el),
  ).length;
});
check(clipped === 0, 'D1 · nothing painted off-screen at 390 px', `${clipped} elements`);
await page.screenshot({ path: `${OUT}/health-05-phone.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(600);

const a11y = await page.evaluate(() => {
  const controls = [...document.querySelectorAll('button, a[href], input, select')];
  const unnamed = controls.filter(
    (el) =>
      (el.textContent ?? '').trim() === '' &&
      !el.getAttribute('aria-label') &&
      !el.getAttribute('aria-labelledby') &&
      !el.getAttribute('title'),
  ).length;
  const small = controls.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.width < 24 || r.height < 24);
  }).length;
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) =>
    Number(h.tagName[1]),
  );
  let skips = 0;
  for (let i = 1; i < levels.length; i += 1) if (levels[i] - levels[i - 1] > 1) skips += 1;
  return { unnamed, small, skips };
});
check(a11y.unnamed === 0, 'D2 · every control is named', `${a11y.unnamed}`);
check(a11y.small === 0, 'D2 · no target below 24 px', `${a11y.small}`);
check(a11y.skips === 0, 'D2 · no heading level is skipped', `${a11y.skips}`);

/* The page has one control. It must be reachable and operable without a mouse. */
let reached = false;
for (let i = 0; i < 25 && !reached; i += 1) {
  await page.keyboard.press('Tab');
  reached = await page.evaluate(() =>
    /refresh/i.test(document.activeElement?.textContent ?? ''),
  );
}
check(reached, 'D3 · Refresh is reachable by keyboard alone');
if (reached) {
  const stamp = () => page.locator('main time').first().getAttribute('datetime');
  const before = await stamp();
  /*
   * ⚠️ Two presses, spaced past the server-side cache window. One press inside it legitimately
   * returns the same snapshot — a check that expected a new timestamp from a single press would be
   * asserting that the cache does not work.
   */
  let after = before;
  for (let i = 0; i < 6 && after === before; i += 1) {
    await page.keyboard.press('Enter');
    await sleep(3_000);
    after = await stamp();
  }
  check(before !== after, 'D3 · …and operating it re-reads the report', `${before} -> ${after}`);
}

check(errors.length === 0, 'D4 · no console or page errors throughout', errors.join(' | '));

// ── permission denied ───────────────────────────────────────────────────────────────────────────
console.log('\nE · a viewer');

const token = await page.evaluate(async ([base, tenant, creds]) => {
  const res = await fetch(`${base}/api/identity/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenant },
    body: JSON.stringify(creds),
  });
  return (await res.json()).data.accessToken;
}, [B, TENANT, ADMIN]);

const created = await page.evaluate(
  async ([base, tok, user]) => {
    const res = await fetch(`${base}/api/identity/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ email: user.email, password: user.password, roles: ['viewer'] }),
    });
    return res.status;
  },
  [B, token, VIEWER],
);
check(created === 201 || created === 200, 'E0 · a viewer probe account is created', `HTTP ${created}`);

const viewer = await newSession(VIEWER);
await viewer.page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await sleep(1_500);
const denied = await viewer.page.evaluate(() => document.querySelector('main')?.textContent ?? '');
check(/not authorized/i.test(denied), 'E1 · the page says the restriction is about permission');
check(
  /says nothing about whether the platform is healthy/i.test(denied),
  'E1 · ⚠️ and explicitly not an all-clear',
);
const navLinks = await viewer.page.evaluate(() =>
  [...document.querySelectorAll('nav a')].map((a) => a.textContent?.trim() ?? ''),
);
check(
  !navLinks.some((l) => /system health/i.test(l)),
  'E2 · ⚠️ and the sidebar does not advertise a page it will refuse',
  navLinks.join(' · ').slice(0, 90),
);
await viewer.page.screenshot({ path: `${OUT}/health-06-forbidden.png`, fullPage: true });
console.log(`      (probe account left behind: ${VIEWER.email})`);

await context.close();
await browser.close();
console.log(
  `\n${failures === 0 ? '✓ P-6.4 browser verification: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
