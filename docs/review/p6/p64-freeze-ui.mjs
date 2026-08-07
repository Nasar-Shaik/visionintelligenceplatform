/**
 * P-6.4 · the freeze pass in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/p64-freeze-ui.mjs
 *
 * R  **The page is left open and six things are restarted underneath it** — gateway, MongoDB, NATS,
 *    MinIO, evidence, workflow. Every transition must appear on its own. ⚠️ Nobody refreshes the
 *    browser: an operator watching a restart does not know to.
 * P  **Polling, measured.** Requests are counted over a real minute, and counted again after
 *    navigating away, because the failure mode is a page that keeps polling forever in a forgotten
 *    tab.
 * N  Navigation — refresh, back, forward, a direct `/system` link.
 * S  Screenshots of every operational state, taken while the platform is genuinely in it.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 140)}`));
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

/** Every health request the page makes, timestamped. The polling budget is measured, not assumed. */
const polls = [];
page.on('request', (r) => {
  if (r.url().includes('/api/system/health')) polls.push(Date.now());
});

await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await page.getByLabel(/tenant/i).fill(TENANT);
await page.getByLabel(/email/i).fill(ADMIN.email);
await page.getByLabel(/password/i).fill(ADMIN.password);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });

const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('main li')].map((li) => ({
      label: li.querySelector('p')?.textContent?.trim() ?? '',
      state: [...li.querySelectorAll('span, div')]
        .map((n) => n.textContent?.trim() ?? '')
        .find((t) =>
          ['Healthy', 'Degraded', 'Unavailable', 'Not configured', 'Not built', 'Unknown'].includes(t),
        ),
    })),
  );
const headline = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('main p')]
        .map((n) => n.textContent?.trim() ?? '')
        .find((t) => /report(s)? (healthy|nothing)|not answering|not fully|healthy\.$/.test(t)) ?? '',
  );
const stamp = () => page.locator('main time').first().getAttribute('datetime').catch(() => null);

/** Wait for the page to change on its own — no reload, no click. */
async function settles(predicate, { timeout = 70_000, label = '' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const current = await rows().catch(() => []);
    if (await predicate(current)) return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
    await sleep(2_000);
  }
  return { ok: false, seconds: Math.round((Date.now() - started) / 1000), label };
}

console.log('\nP-6.4 · freeze pass in the browser\n');

await page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main li', { timeout: 20_000 });
await sleep(500);
check((await rows()).length >= 19, 'S0 · the page is open and populated', `${(await rows()).length} rows`);
await page.screenshot({ path: `${OUT}/freeze-health-01-healthy.png`, fullPage: true });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// R · six restarts, and nobody touches the browser
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('R · restarts, with the page left open');

/*
 * R1 — the gateway. ⚠️ The page's own source of truth disappears; it must not pretend otherwise.
 *
 * ⚠️ **Stopped and started, not `docker restart`.** The first version of this section restarted each
 * container and asserted the page noticed. Every one of those checks failed, and the page was right:
 * a container that is down for three seconds, behind a five-second server cache, sampled every
 * fifteen seconds, is **invisible by arithmetic**. The check was demanding that a sampled reading
 * report an event shorter than its own interval. Holding the outage open long enough to be sampled
 * is what makes the assertion about the product rather than about luck — and the sampling limit
 * itself is recorded as L-28.
 */
docker('stop', 'vip-prod-gateway-1');
const gatewayGone = await settles(async () => {
  const text = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
  return /could not be refreshed|couldn.t load/i.test(text);
}, { timeout: 60_000 });
check(gatewayGone.ok, 'R1 · the page notices its own source of truth is gone', `${gatewayGone.seconds}s`);
/*
 * ⚠️ And it keeps the last reading rather than blanking. Found by doing exactly this: the report was
 * replaced by "Couldn't load · Request failed (502)", so the operator lost every row during the one
 * outage the page exists to report.
 */
const kept = await rows();
check(
  kept.length >= 19,
  'R1 · ⚠️ and keeps the last known reading rather than blanking the page',
  `${kept.length} rows survived`,
);
check(
  /Last known:/.test(await headline().catch(() => '')) ||
    (await page.evaluate(() => /last known/i.test(document.querySelector('main')?.textContent ?? ''))),
  'R1 · …labelled as a past reading, not presented as current',
);
await page.screenshot({ path: `${OUT}/freeze-health-02-gateway-down.png`, fullPage: true });

docker('start', 'vip-prod-gateway-1');
const gatewayBack = await settles(async (r) => r.length >= 19 && r.every((x) => x.state !== undefined), {
  timeout: 120_000,
});
check(gatewayBack.ok, 'R1 · ⚠️ and recovers on its own, with no browser refresh', `${gatewayBack.seconds}s`);

/* R2–R6 — one dependency at a time. Each must show a transition and return, unattended. */
const restarts = [
  ['MongoDB', 'vip-prod-mongodb-1', (r) => r.some((x) => x.state === 'Unavailable' || x.state === 'Unknown')],
  ['NATS', 'vip-prod-nats-1', (r) => r.some((x) => x.state !== 'Healthy' && x.state !== 'Not built')],
  ['MinIO', 'vip-prod-minio-1', (r) => r.some((x) => x.state === 'Degraded' || x.state === 'Unavailable')],
  ['evidence', 'vip-prod-evidence-1', (r) => r.some((x) => x.label === 'Evidence' && x.state === 'Unavailable')],
  ['workflow', 'vip-prod-workflow-1', (r) => r.some((x) => x.label === 'Incidents' && x.state === 'Unavailable')],
];

for (const [name, container, broken] of restarts) {
  docker('stop', container);
  const dipped = await settles(async (r) => broken(r), { timeout: 75_000 });
  check(dipped.ok, `R · ${name} going down shows on the page unattended`, `${dipped.seconds}s`);
  if (name === 'MinIO' && dipped.ok) {
    await page.screenshot({ path: `${OUT}/freeze-health-03-partial-degradation.png`, fullPage: true });
  }
  if (name === 'MongoDB' && dipped.ok) {
    await page.screenshot({ path: `${OUT}/freeze-health-04-mixed.png`, fullPage: true });
  }
  docker('start', container);
  const back = await settles(async (r) => r.every((x) => x.state === 'Healthy' || x.state === 'Not built'), {
    timeout: 150_000,
  });
  check(back.ok, `R · …and ${name} returning shows on the page unattended`, `${back.seconds}s`);
}

/*
 * ⚠️ Transport failures are **expected** here — six components were deliberately taken away, and a
 * browser that logged nothing while the gateway was stopped would mean the page had stopped asking.
 * What must not appear is a crash or a React error: the page has to survive its own subject failing.
 */
const crashes = errors.filter((e) => !/Failed to load resource|net::ERR|502|503|504/i.test(e));
check(crashes.length === 0, 'R · no crash or render error across six outages', crashes.join(' | ').slice(0, 160));
console.log(`      (${errors.length - crashes.length} expected transport errors while components were down)`);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// P · the polling budget, measured
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nP · polling');

polls.length = 0;
await sleep(62_000);
const inAMinute = polls.length;
/* 15-second interval ⇒ 4 in a minute. Anything near 60 is a page that would flatten the gateway. */
check(
  inAMinute >= 2 && inAMinute <= 6,
  'P1 · the page polls on its stated interval, and no faster',
  `${inAMinute} requests in 62s`,
);

/* ⚠️ The failure mode nobody notices: a tab left on another page still polling for system health. */
await page.goto(`${B}/incidents`, { waitUntil: 'domcontentloaded' });
await sleep(2_000);
polls.length = 0;
await sleep(35_000);
check(polls.length === 0, 'P2 · ⚠️ and stops entirely once the page is left', `${polls.length} requests in 35s`);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// N · navigation
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nN · navigation');

await page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main li', { timeout: 20_000 });
const deepLinked = (await rows()).length;
check(deepLinked >= 19, 'N1 · a direct /system link renders the report', `${deepLinked} rows`);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('main li', { timeout: 20_000 });
check((await rows()).length === deepLinked, 'N2 · a refresh restores the same state');

await page.goBack({ waitUntil: 'domcontentloaded' });
await sleep(1_500);
check(new URL(page.url()).pathname === '/incidents', 'N3 · back returns to the previous page', page.url());
const backRendered = await page.evaluate(() => document.querySelectorAll('main *').length);
check(backRendered > 20, 'N3 · and that page renders', `${backRendered} nodes`);

await page.goForward({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('main li', { timeout: 20_000 });
check((await rows()).length === deepLinked, 'N4 · forward restores the report');

await page.getByRole('link', { name: /system health/i }).first().click();
await page.waitForSelector('main li', { timeout: 20_000 });
check(new URL(page.url()).pathname === '/system', 'N5 · the sidebar entry lands on the same page');
check(await stamp(), 'N5 · with a reading, not an empty shell');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// S · the remaining screenshots
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nS · states');

docker('stop', 'vip-prod-minio-1');
try {
  const degraded = await settles(async (r) => r.some((x) => x.state === 'Degraded'), { timeout: 60_000 });
  check(degraded.ok, 'S1 · a dependency outage reaches the page unattended', `${degraded.seconds}s`);
  const shown = await rows();
  check(
    shown.some((x) => x.label === 'Object storage' && x.state === 'Unavailable'),
    'S1 · the dependency itself reads Unavailable',
    shown.find((x) => x.label === 'Object storage')?.state,
  );
  check(
    shown.some((x) => x.state === 'Healthy'),
    'S1 · ⚠️ while the rest of the platform is still reported healthy — a mixed state, not a red screen',
  );
  await page.screenshot({ path: `${OUT}/freeze-health-05-dependency-unavailable.png`, fullPage: true });
} finally {
  docker('start', 'vip-prod-minio-1');
}
const healed = await settles(async (r) => r.every((x) => x.state === 'Healthy' || x.state === 'Not built'), {
  timeout: 120_000,
});
check(healed.ok, 'S1 · and clears on its own once storage returns', `${healed.seconds}s`);

await browser.close();
console.log(
  `\n${failures === 0 ? '✓ P-6.4 browser freeze pass: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
