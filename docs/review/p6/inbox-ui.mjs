/**
 * P-6.5 · the inbox in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/inbox-ui.mjs
 *
 * The claim under test is that this stopped being a list and became a queue: one entry per incident,
 * the count that follows an operator around the console, a delivery failure that stays visible after
 * somebody takes the incident, and a filter the server answers rather than the browser.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const VIEWER = { email: `p65.viewer.${Date.now()}@northgate.demo`, password: 'Probe-Password-2026!' };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const newSession = async (creds = ADMIN, viewport = { width: 1440, height: 900 }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 140)}`));
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page, errors };
};

const entries = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('main ul > li')]
      .filter((li) => li.querySelector('a[href^="/workspace/"]'))
      .map((li) => ({
        title: li.querySelector('p')?.textContent?.trim() ?? '',
        bold: (li.querySelector('p')?.className ?? '').includes('font-semibold'),
        href: li.querySelector('a[href^="/workspace/"]')?.getAttribute('href') ?? '',
        text: li.textContent ?? '',
      })),
  );
const bellCount = (page) =>
  page.evaluate(() => {
    const link = document.querySelector('header a[href="/alerts"]');
    return link?.textContent?.trim() ?? '';
  });

/*
 * ⚠️ **The script supplies its own subject.** Acknowledging is one-way by design — there is no
 * un-ack, and there should not be — so a verification that consumes the demo queue works once and
 * then reports "there is nothing to take" forever after. The first run of this script did exactly
 * that. One disposable delivery is inserted for a synthetic incident, used, and removed; the demo
 * dataset is left exactly as it was.
 */
const PROBE_INCIDENT = randomUUID();
const PROBE_ID = randomUUID();
const mongosh = (script) =>
  execFileSync(
    'docker',
    [
      'exec', 'vip-prod-mongodb-1', 'mongosh',
      '-u', process.env.MONGO_USER ?? 'vip',
      '-p', process.env.MONGO_PASSWORD ?? '5c224c1dce92cba3b07ce2a4',
      '--authenticationDatabase', 'admin', '--quiet', '--eval', script,
    ],
    { encoding: 'utf8' },
  ).trim();

const now = new Date().toISOString();
mongosh(
  `db.getSiblingDB('vip').notifications.insertOne(${JSON.stringify({
    id: PROBE_ID,
    tenantId: TENANT,
    incidentId: PROBE_INCIDENT,
    channelId: `chan_${TENANT}_inapp`,
    channelType: 'in-app',
    status: 'delivered',
    severity: 'high',
    title: 'Verification probe — safe to ignore',
    correlationId: `p65-${PROBE_ID}`,
    causationId: PROBE_INCIDENT,
    attempts: 1,
    sentAt: now,
    deliveredAt: now,
    createdAt: now,
    updatedAt: now,
  })})`,
);

console.log('\nP-6.5 · the inbox in the browser\n');

const { page, errors, context } = await newSession();

// ── the shell badge ─────────────────────────────────────────────────────────────────────────────
console.log('A · the count that follows you');

await page.goto(`${B}/incidents`, { waitUntil: 'domcontentloaded' });
await sleep(2_500);
const onAnotherPage = await bellCount(page);
check(
  /\d/.test(onAnotherPage),
  'A1 · ⚠️ the waiting count is visible from another page entirely',
  `bell reads "${onAnotherPage}"`,
);
const label = await page.evaluate(
  () => document.querySelector('header a[href="/alerts"]')?.getAttribute('aria-label') ?? '',
);
check(
  /incident/i.test(label) && /waiting/i.test(label),
  'A1 · and says what the number means, for a screen reader too',
  label,
);
check(
  /Inbox/i.test(
    await page.evaluate(() => [...document.querySelectorAll('nav a')].map((a) => a.textContent).join(' ')),
  ),
  'A2 · the sidebar calls it an Inbox, not a log',
);

// ── the queue ───────────────────────────────────────────────────────────────────────────────────
console.log('\nB · the queue');

const requests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/notify/notifications?')) requests.push(new URL(r.url()).search);
});
await page.getByRole('link', { name: /^inbox/i }).first().click();
await page.waitForSelector('main ul > li', { timeout: 20_000 });
await sleep(800);

const queue = await entries(page);
check(queue.length > 0, 'B1 · the queue renders', `${queue.length} incidents`);
check(
  requests.some((q) => q.includes('acknowledged=false')),
  'B1 · ⚠️ filtered by the server, not by the browser',
  requests[0],
);
check(
  new Set(queue.map((e) => e.href)).size === queue.length,
  'B2 · ⚠️ one entry per incident — no incident appears twice',
);
check(
  queue.every((e) => e.bold),
  'B3 · everything waiting is visually distinct from what is handled',
);
/*
 * ⚠️ Including the entry that reached **nothing**. A failed-only delivery reads "reached no channel"
 * rather than "reached 0 of 1", and the first version of this check demanded the numeric form — so
 * it went red against the one entry whose wording matters most.
 */
check(
  queue.every((e) => /reached (\d+ of \d+ channel|no channel)/.test(e.text)),
  'B4 · each says how many channels it actually reached',
  queue.find((e) => !/reached (\d+ of \d+ channel|no channel)/.test(e.text))?.text.slice(0, 60),
);
await page.screenshot({ path: `${OUT}/inbox-01-queue.png`, fullPage: true });

// ── delivery failures ───────────────────────────────────────────────────────────────────────────
console.log('\nC · a delivery that never arrived');

const failureBanner = await page.evaluate(
  () => document.querySelector('main [role="alert"]')?.textContent ?? '',
);
check(
  /never arrived/i.test(failureBanner),
  'C1 · a failed delivery is called out above the queue',
  failureBanner.slice(0, 80),
);
check(
  /Acknowledging an alert does not fix this/i.test(failureBanner),
  'C1 · ⚠️ and says plainly that taking the incident will not fix it',
);

const withFailure = queue.find((e) => /failed/i.test(e.text));
check(withFailure !== undefined, 'C2 · the entry itself is marked', withFailure?.title);
const toggles = page.getByRole('button', { name: /show delivery detail/i });
await toggles.nth(queue.findIndex((e) => e === withFailure)).click();
await sleep(600);
/*
 * ⚠️ **This check could not pass, and it took the freeze close-out to notice.** It matched
 * `/ETIMEDOUT|ECONNREFUSED|timeout/` — the wording of the *fabricated* demo failure P-6.5 removed,
 * along with the retry count it described. The deployment now says "no response within 5s" and "the
 * endpoint's host name could not be resolved", so the check went red against a screen that was
 * doing exactly what the exit criterion asks. An assertion pinned to a string is pinned to the day
 * it was written; what is owed is that the reason is **there and actionable**.
 */
const detail = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
const reason =
  /no response within|rejected it \(HTTP|connection refused|could not be resolved|closed the connection/i.test(
    detail,
  ) && !/fetch failed|operation was aborted/i.test(detail);
check(reason, 'C2 · ⚠️ expanding it shows the reason — the 0.5 exit criterion, on screen');
await page.screenshot({ path: `${OUT}/inbox-02-delivery-failure.png`, fullPage: true });

// ── acknowledging ───────────────────────────────────────────────────────────────────────────────
console.log('\nD · taking an incident');

const before = await entries(page);
const beforeBell = await bellCount(page);
const ackButtons = page.getByRole('button', { name: /^acknowledge$/i });
const ackable = await ackButtons.count();
check(ackable > 0, 'D0 · there is something to take', `${ackable}`);
await ackButtons.first().click();
await sleep(3_000);

const after = await entries(page);
check(after.length < before.length, 'D1 · it leaves the queue', `${before.length} → ${after.length}`);
const afterBell = await bellCount(page);
check(
  afterBell !== beforeBell,
  'D2 · ⚠️ and the count in the top bar follows, without a reload',
  `${beforeBell} → ${afterBell}`,
);
await page.screenshot({ path: `${OUT}/inbox-03-after-acknowledge.png`, fullPage: true });

// ── the handled view ────────────────────────────────────────────────────────────────────────────
console.log('\nE · what has been handled');

await page.getByLabel('Triage filter').click();
await page.getByRole('option', { name: 'Acknowledged' }).click();
await page.waitForTimeout(2_000);
const handled = await entries(page);
check(handled.length > 0, 'E1 · the handled view lists what somebody took', `${handled.length}`);
/*
 * ⚠️ Asserted on **the acknowledgement this run just made**, not on every historical record. The
 * deployment still holds acknowledgements written before `ackedBy` came from the authenticated
 * principal, and they are genuinely unattributed — an `every` here would report that permanent past
 * as a present defect, which is how a check stops being read.
 */
const justTaken = handled.find((e) => e.href === before.find((b) => !after.some((a) => a.href === b.href))?.href);
check(
  justTaken !== undefined && /taken by \S+@/i.test(justTaken.text),
  'E1 · ⚠️ and names who took it — a queue nobody signs is a queue nobody owns',
  justTaken?.text.match(/taken by [^·]*/i)?.[0]?.trim(),
);
check(handled.every((e) => !e.bold), 'E2 · handled entries are no longer emphasised');
await page.screenshot({ path: `${OUT}/inbox-04-handled.png`, fullPage: true });

// ── empty queue ─────────────────────────────────────────────────────────────────────────────────
console.log('\nF · an empty queue');

/*
 * ⚠️ A **real** empty answer, not a stubbed one. The first version of this check intercepted the
 * request and reported the live queue as empty because the interception never matched — so it was
 * asserting against the page's cache. Filtering to an incident that does not exist makes the
 * deployment return an empty page for real, which is also closer to what an operator sees on a quiet
 * morning.
 */
await page.goto(`${B}/alerts?incidentId=${PROBE_INCIDENT}`, { waitUntil: 'domcontentloaded' });
let empty = '';
for (let i = 0; i < 15; i += 1) {
  await sleep(1_000);
  empty = await page.evaluate(() => document.querySelector('main')?.textContent ?? '');
  if (/Nothing is waiting/i.test(empty)) break;
}
check(
  /Nothing is waiting/i.test(empty),
  'F1 · an empty queue is good news, and reads as good news',
  empty.replace(/\s+/g, ' ').slice(0, 80),
);
check(
  !/No alerts/i.test(empty),
  'F1 · ⚠️ and is not confused with "this product has never sent one"',
);
await page.screenshot({ path: `${OUT}/inbox-05-empty-queue.png`, fullPage: true });
await page.goto(`${B}/alerts`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2_000);

// ── responsive + accessibility ──────────────────────────────────────────────────────────────────
console.log('\nG · responsive, accessible');

await page.getByLabel('Triage filter').click();
await page.getByRole('option', { name: 'Everything' }).click();
await page.waitForTimeout(1_500);
await page.setViewportSize({ width: 390, height: 844 });
await sleep(1_200);
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
check(clipped === 0, 'G1 · nothing painted off-screen at 390 px', `${clipped} elements`);
await page.screenshot({ path: `${OUT}/inbox-06-phone.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(800);

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
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  let skips = 0;
  for (let i = 1; i < levels.length; i += 1) if (levels[i] - levels[i - 1] > 1) skips += 1;
  return { unnamed, small, skips };
});
check(a11y.unnamed === 0, 'G2 · every control is named', `${a11y.unnamed}`);
check(a11y.small === 0, 'G2 · no target below 24 px', `${a11y.small}`);
check(a11y.skips === 0, 'G2 · no heading level is skipped', `${a11y.skips}`);
check(errors.length === 0, 'G3 · no console or page errors', errors.join(' | ').slice(0, 160));

// ── a viewer ────────────────────────────────────────────────────────────────────────────────────
console.log('\nH · a viewer');

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
check(created === 201 || created === 200, 'H0 · a viewer probe account is created', `HTTP ${created}`);

const viewer = await newSession(VIEWER);
await viewer.page.goto(`${B}/alerts`, { waitUntil: 'domcontentloaded' });
await sleep(2_500);
const viewerEntries = await entries(viewer.page);
check(viewerEntries.length > 0, 'H1 · a viewer can read the queue', `${viewerEntries.length}`);
check(
  (await viewer.page.getByRole('button', { name: /^acknowledge$/i }).count()) === 0,
  'H2 · ⚠️ and cannot clear it — taking an alert is a decision, not a read',
);
await viewer.page.screenshot({ path: `${OUT}/inbox-07-viewer.png`, fullPage: true });
console.log(`      (probe account left behind: ${VIEWER.email})`);

await context.close();
await browser.close();
mongosh(`db.getSiblingDB('vip').notifications.deleteMany({ id: '${PROBE_ID}' })`);
check(
  mongosh(`db.getSiblingDB('vip').notifications.countDocuments({ id: '${PROBE_ID}' })`) === '0',
  '· the probe delivery is removed — the demo queue is left as it was',
);
console.log(
  `\n${failures === 0 ? '✓ P-6.5 browser verification: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
