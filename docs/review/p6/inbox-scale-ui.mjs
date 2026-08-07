/**
 * P-6.5 · the inbox at scale **in the browser**, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency), with the load harness
 * already applied:
 *   node docs/review/p6/inbox-scale.mjs load
 *   cd /private/tmp/pwrun && node <repo>/docs/review/p6/inbox-scale-ui.mjs
 *   node docs/review/p6/inbox-scale.mjs clean
 *
 * A server that answers in 10 ms says nothing about a screen an operator has had open since the
 * start of a shift. What is measured here is what that operator feels:
 *
 * 1  time to a usable queue — navigation to the first row, at 5,000 rows
 * 2  interaction latency — expanding an entry, changing the triage filter
 * 3  ⚠️ what paging deep costs *afterwards* — the poll runs against everything loaded
 * 4  DOM weight, and whether it grows without bound
 */
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const requests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/notify/notifications')) requests.push({ url: r.url(), at: Date.now() });
});

await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await page.getByLabel(/tenant/i).fill(TENANT);
await page.getByLabel(/email/i).fill(ADMIN.email);
await page.getByLabel(/password/i).fill(ADMIN.password);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });

console.log('\nP-6.5 · the inbox at scale, in the browser\n');

// ── 1 · time to a usable queue ──────────────────────────────────────────────────────────────────
console.log('1 · time to a usable queue');

const started = Date.now();
await page.goto(`${B}/alerts?triage=all`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main ul > li', { timeout: 30_000 });
const firstRow = Date.now() - started;
console.log(`  · navigation → first entry rendered: ${firstRow} ms`);
check(firstRow < 4_000, '1a · the queue is on screen quickly at 5,000 rows', `${firstRow} ms`);

const rows = await page.locator('main > div > ul > li').count();
console.log(`  · entries on screen: ${rows} (from one 50-delivery page)`);
/*
 * ⚠️ This is the number that decides whether virtualization is needed. Fifty deliveries group into
 * ~26 entries; the page renders one server page at a time and never the whole log, so the DOM is
 * bounded by how far the operator has *chosen* to page, not by the size of the dataset.
 */
check(rows > 0 && rows <= 50, '1b · one page renders one page — the 5,000-row log is not in the DOM', `${rows} entries`);

const nodes = await page.evaluate(() => document.querySelectorAll('*').length);
console.log(`  · DOM nodes: ${nodes}`);
check(nodes < 3_000, '1c · DOM weight is ordinary', `${nodes} nodes`);

// ── 2 · interaction latency ─────────────────────────────────────────────────────────────────────
console.log('\n2 · interaction latency');

const timeIt = async (label, fn) => {
  const t = Date.now();
  await fn();
  const ms = Date.now() - t;
  console.log(`  · ${label}: ${ms} ms`);
  return ms;
};

const expand = await timeIt('expand an entry (per-channel detail)', async () => {
  await page.getByRole('button', { name: /show delivery detail/i }).first().click();
  await page.waitForSelector('main ul li ul li', { timeout: 10_000 });
});
check(expand < 300, '2a · expansion is immediate — the detail is already loaded, not fetched', `${expand} ms`);

const collapse = await timeIt('collapse it again', async () => {
  await page.getByRole('button', { name: /hide delivery detail/i }).first().click();
  await page.waitForSelector('main ul li ul li', { state: 'detached', timeout: 10_000 });
});
check(collapse < 300, '2b · and so is collapsing', `${collapse} ms`);

/* ⚠️ The filter is a server round trip by design — measured as such, not excused. */
const filter = await timeIt('switch triage to "Needs attention"', async () => {
  await page.getByLabel('Triage filter').click();
  await page.getByRole('option', { name: 'Needs attention' }).click();
  await page.waitForFunction(() => !document.body.textContent.includes('Loading'), { timeout: 15_000 });
  await page.waitForTimeout(400);
});
check(filter < 2_500, '2c · the triage filter answers from the server within a beat', `${filter} ms`);

// ── 3 · ⚠️ what paging deep costs afterwards ────────────────────────────────────────────────────
console.log('\n3 · ⚠️ the cost of paging deep — measured after the fact, not at the click');

await page.goto(`${B}/alerts?triage=all`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main ul > li', { timeout: 30_000 });

/*
 * ⚠️ **Twenty-five clicks, not ten.** An infinite query refetches every page it has loaded on every
 * interval, so before P-6.5's final pass the background cost of this screen grew with each "Load
 * more" and never came back down — measured at 29 KB per tick with one page and 610 KB with twenty.
 * This presses the button past the cap on purpose: if somebody removes the cap, the clicking
 * continues and these checks go red.
 */
let clicks = 0;
for (let i = 0; i < 25; i += 1) {
  const more = page.getByRole('button', { name: /load more/i });
  if (!(await more.isVisible().catch(() => false))) break;
  await more.click();
  await page.waitForTimeout(700);
  clicks += 1;
}
const deepRows = await page.locator('main > div > ul > li').count();
const deepNodes = await page.evaluate(() => document.querySelectorAll('*').length);
console.log(`  · pressed "Load more" until it stopped: ${clicks} times → ${deepRows} entries, ${deepNodes} DOM nodes`);
check(clicks < 25, '3a · ⚠️ the queue is bounded — "Load more" stops', `stopped after ${clicks}`);
/*
 * ⚠️ Read from the DOM, not through `getByText`. The message is on screen — `main.textContent` ends
 * with "Showing the 500 most recent deliveries. There are older ones — …" — and `getByText` with a
 * regex still matched **nothing**, so the check went red against a sentence an operator can plainly
 * read. Three times, in fact: the number was interpolated mid-sentence and split the text node; the
 * locator then matched nothing anyway; and the regex itself expected "most recent 500 deliveries"
 * when the sentence reads "the **500 most recent** deliveries". ⚠️ When a query disagrees with the
 * page, believe the page — and read the words before asserting on them.
 */
const capMessage = await page.evaluate(
  () => document.querySelector('main')?.textContent ?? '',
);
check(
  /\d+ most recent deliveries/i.test(capMessage),
  '3b · ⚠️ and it says so on screen rather than simply disappearing',
  (capMessage.match(/Showing the[^.]*\./) ?? ['(no message)'])[0],
);

requests.length = 0;
const window = 25_000; // one 20-second interval, with room either side
await page.waitForTimeout(window);
const perPoll = requests.length;
console.log(`  · requests in ${window / 1000}s at the cap: ${perPoll}`);
check(
  perPoll <= 11,
  '3c · ⚠️ so the poll has a ceiling: pages loaded + the bell, and it cannot climb past it',
  `${perPoll} per 20s`,
);

const scroll = await timeIt('scroll to the bottom of the loaded queue', async () => {
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
});
check(scroll < 1_500, '3c · a deep queue still scrolls', `${scroll} ms`);

// ── 4 · memory ──────────────────────────────────────────────────────────────────────────────────
console.log('\n4 · memory');

const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
console.log(`  · JS heap with ${deepRows} entries loaded: ${(heap / 1024 / 1024).toFixed(1)} MB`);
check(heap === 0 || heap < 200 * 1024 * 1024, '4a · heap is not runaway', `${(heap / 1024 / 1024).toFixed(1)} MB`);

check(errors.length === 0, '4b · no page errors throughout', errors.join(' | '));

await browser.close();
console.log(`\n${failures === 0 ? '✓ inbox at scale (browser): all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
