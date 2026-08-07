/**
 * P-6.6 · **the camera screens in a real browser, against the deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cp docs/review/p6/cameras-ui.mjs /private/tmp/pwrun/ && cd /private/tmp/pwrun && node cameras-ui.mjs
 *
 * With `SCALE=1` the estate is loaded to 5 000 first (see `camera-scale.mjs`), which is the only
 * honest way to answer "does this need virtualization" — measured in the browser, not reasoned about.
 *
 * 1  the list: server search, filters, paging, and a count that is the estate's
 * 2  the detail page: it has an address, and every field states how it is known
 * 3  ⚠️ two operators editing one camera — the conflict an operator actually sees
 * 4  permissions: an operator reads, an administrator writes
 * 5  responsive + accessibility on both screens
 */
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const OPERATOR = { email: 'day.operator@northgate.demo', password: '12345678' };

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();

async function session(creds, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page, errors };
}

console.log('\nP-6.6 · the camera screens\n');

const admin = await session(ADMIN);
const requests = [];
admin.page.on('request', (r) => {
  if (r.url().includes('/api/camera/cameras')) requests.push(new URL(r.url()).searchParams);
});

// ── 1 · the list ────────────────────────────────────────────────────────────────────────────────
console.log('1 · the list');

const started = Date.now();
await admin.page.goto(`${B}/cameras`, { waitUntil: 'domcontentloaded' });
await admin.page.waitForSelector('main table tbody tr', { timeout: 30_000 });
const firstRow = Date.now() - started;
console.log(`  · navigation → first row: ${firstRow} ms`);
check(firstRow < 4_000, '1a · the estate is on screen quickly', `${firstRow} ms`);

const rows = await admin.page.locator('main table tbody tr').count();
const nodes = await admin.page.evaluate(() => document.querySelectorAll('*').length);
console.log(`  · rows rendered: ${rows} · DOM nodes: ${nodes}`);
/*
 * ⚠️ This is the number that decides whether virtualization is needed. The page renders one server
 * page at a time and stops at ten, so the DOM is bounded by how far the operator has *chosen* to
 * page — never by the size of the estate.
 */
check(rows > 0 && rows <= 50, '1b · one page renders one page — the estate is not in the DOM', `${rows}`);
check(nodes < 4_000, '1c · DOM weight is ordinary', `${nodes} nodes`);

const countLine = await admin.page.locator('[data-testid="camera-count"]').textContent();
console.log(`  · the page says: "${countLine?.trim()}"`);
check(
  /of \d+ camera/i.test(countLine ?? ''),
  '1d · ⚠️ and it says how many cameras there are, from the server’s own count',
  countLine?.trim(),
);

/* Search reaches the server. */
requests.length = 0;
await admin.page.getByPlaceholder('Search cameras…').fill('Scale camera 4');
await admin.page.waitForTimeout(1_200);
check(
  requests.some((q) => q.get('search')?.startsWith('Scale camera')),
  '1e · ⚠️ typing a search asks the **server**, rather than filtering the browser’s copy',
  `${requests.length} request(s)`,
);
check(
  requests.every((q) => q.get('limit') !== null),
  '1f · and every request is a page, never "give me everything"',
);
await admin.page.getByPlaceholder('Search cameras…').fill('');
await admin.page.waitForTimeout(1_000);

/* Paging. */
const more = admin.page.getByRole('button', { name: /load more cameras/i });
if (await more.isVisible().catch(() => false)) {
  const beforeRows = await admin.page.locator('main table tbody tr').count();
  await more.click();
  await admin.page.waitForTimeout(1_200);
  const afterRows = await admin.page.locator('main table tbody tr').count();
  check(afterRows > beforeRows, '1g · "Load more" adds a page', `${beforeRows} → ${afterRows}`);
} else {
  check(true, '1g · the estate fits on one page here — nothing to page through');
}

const heap = await admin.page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
console.log(`  · JS heap: ${(heap / 1048576).toFixed(1)} MB`);
check(heap === 0 || heap < 200 * 1048576, '1h · heap is not runaway', `${(heap / 1048576).toFixed(1)} MB`);

await admin.page.screenshot({ path: `${OUT}/p66-cameras-01-list.png`, fullPage: true });

// ── 2 · the detail page ─────────────────────────────────────────────────────────────────────────
console.log('\n2 · one camera');

const firstLink = admin.page.locator('main table tbody tr a[href^="/cameras/"]').first();
const href = await firstLink.getAttribute('href');
await firstLink.click();
await admin.page.waitForURL(/\/cameras\/.+/, { timeout: 15_000 });
await admin.page.waitForSelector('h1', { timeout: 15_000 });
check(
  admin.page.url().includes(href ?? 'never'),
  '2a · ⚠️ a camera has an address — it can be linked to, refreshed and gone back from',
  admin.page.url().replace(B, ''),
);

/* A reload must land on the same camera, not back at the list. */
await admin.page.reload({ waitUntil: 'domcontentloaded' });
await admin.page.waitForSelector('h1', { timeout: 15_000 });
check(admin.page.url().includes(href ?? 'never'), '2b · and a refresh stays on it');

const capabilities = await admin.page.locator('[data-capability]').count();
check(capabilities >= 12, '2c · every capability is listed, not only the ones that are true', `${capabilities} rows`);

const aiRow = await admin.page.locator('[data-capability="ai"]').textContent();
check(
  /not built/i.test(aiRow ?? ''),
  '2d · ⚠️ AI analysis says **not built** rather than leaving an operator to assume',
  (aiRow ?? '').slice(0, 80).replace(/\s+/g, ' '),
);
const ptzRow = await admin.page.locator('[data-capability="ptz"]').textContent();
check(
  /declared|unknown/i.test(ptzRow ?? ''),
  '2e · ⚠️ and a declared capability is not dressed as a measured one',
  (ptzRow ?? '').slice(0, 80).replace(/\s+/g, ' '),
);

const recording = await admin.page.locator('section[aria-labelledby="recording"]').textContent();
check(
  /no stream worker|recording|not recording|unknown/i.test(recording ?? ''),
  '2f · recording state is stated, including when there is no worker',
  (recording ?? '').slice(0, 70).replace(/\s+/g, ' '),
);

await admin.page.screenshot({ path: `${OUT}/p66-cameras-02-detail.png`, fullPage: true });

// ── 3 · two operators, one camera ───────────────────────────────────────────────────────────────
console.log('\n3 · ⚠️ two administrators editing the same camera');

const second = await session(ADMIN);
await second.page.goto(`${B}${href}`, { waitUntil: 'domcontentloaded' });
await second.page.waitForSelector('h1', { timeout: 15_000 });

/* Both open the editor on the same record. */
await admin.page.getByRole('button', { name: /^edit$/i }).click();
await second.page.getByRole('button', { name: /^edit$/i }).click();
/* ⚠️ `getByLabel('Notes')` matches the *section* as well as the field — the dialog's textarea is
   what an operator types into, so the locator says so. */
const notesOf = (page) => page.getByRole('textbox', { name: 'Notes' });
await notesOf(admin.page).fill('first administrator was here');
await notesOf(second.page).fill('second administrator was here');

/* The first save wins. */
await admin.page.getByRole('button', { name: /save changes/i }).click();
await admin.page.waitForTimeout(1_500);
await second.page.getByRole('button', { name: /save changes/i }).click();
await second.page.waitForTimeout(1_500);

const conflict = await second.page.locator('text=/somebody else changed this camera/i').count();
check(conflict > 0, '3a · ⚠️ the second administrator is told, rather than overwriting silently');
const kept = await notesOf(second.page).inputValue();
check(
  kept === 'second administrator was here',
  '3b · ⚠️ and their typing is still in the box — a refusal must not cost them their work',
  kept,
);
await second.page.screenshot({ path: `${OUT}/p66-cameras-03-conflict.png` });
await second.context.close();

/* Put the camera back. */
await admin.page.getByRole('button', { name: /^edit$/i }).click().catch(() => {});
await notesOf(admin.page).fill('').catch(() => {});
await admin.page.getByRole('button', { name: /save changes/i }).click().catch(() => {});
await admin.page.waitForTimeout(1_200);

// ── 4 · permissions ─────────────────────────────────────────────────────────────────────────────
console.log('\n4 · what an operator may do');

const operator = await session(OPERATOR);
await operator.page.goto(`${B}${href}`, { waitUntil: 'domcontentloaded' });
await operator.page.waitForSelector('h1', { timeout: 15_000 });
const opEdit = await operator.page.getByRole('button', { name: /^edit$/i }).count();
check(opEdit === 0, '4a · ⚠️ an operator is not offered an edit they would be refused', `${opEdit} buttons`);
const opSees = await operator.page.locator('[data-capability]').count();
check(opSees >= 12, '4b · and still sees everything the camera can do', `${opSees} rows`);
await operator.context.close();

// ── 5 · responsive + accessibility ──────────────────────────────────────────────────────────────
console.log('\n5 · four screens, and the keyboard');

for (const [name, size] of [
  ['desktop', { width: 1920, height: 1080 }],
  ['laptop', { width: 1440, height: 900 }],
  ['tablet', { width: 820, height: 1180 }],
  ['phone', { width: 390, height: 844 }],
]) {
  await admin.page.setViewportSize(size);
  await admin.page.waitForTimeout(500);
  /*
   * ⚠️ **The platform's definition, not a new one.** The first version of this check counted every
   * element extending past `main` and reported 242 "clipped" elements on a phone — all of them
   * inside an `overflow-x: auto` table, which is a *scrollable* table and the correct treatment for
   * a dense grid on a narrow screen. `overflow.mjs` settled this at P-5.9 and it settles it here:
   * only content the operator **cannot reach** counts, and a wide table they can scroll is reachable.
   */
  const overflow = await admin.page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const reachable = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
        if (ox === 'hidden') return false;
      }
      return false;
    };
    const clippedEls = [...document.querySelectorAll('main *')].filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 40 && b.right > vw + 1 && !reachable(el);
    });
    return {
      scroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      clipped: clippedEls.length,
      first: clippedEls[0]?.tagName.toLowerCase() ?? '',
    };
  });
  check(!overflow.scroll, `5·${name} — the page does not scroll sideways`);
  check(
    overflow.clipped === 0,
    `5·${name} — nothing an operator cannot reach is painted off-screen`,
    `${overflow.clipped}${overflow.first ? ` · first: <${overflow.first}>` : ''}`,
  );
}
await admin.page.setViewportSize({ width: 1440, height: 900 });

const a11y = await admin.page.evaluate(() => {
  const controls = [...document.querySelectorAll('button, a[href], input, select, textarea')];
  const unnamed = controls.filter((el) => {
    const label =
      el.getAttribute('aria-label') ??
      el.textContent?.trim() ??
      (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : '');
    return !label || label.trim() === '';
  });
  const small = controls.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.width < 24 || r.height < 24);
  });
  return {
    total: controls.length,
    unnamed: unnamed.length,
    small: small.length,
    /* ⚠️ Name it. "1 target below 24 px" sends somebody hunting; this says which one. */
    smallest: small
      .slice(0, 3)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}"${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`;
      })
      .join(' · '),
  };
});
check(a11y.unnamed === 0, '5a · every control on the camera page has an accessible name', `${a11y.total} controls`);
check(a11y.small === 0, '5b · no target is below 24 px', a11y.smallest || `${a11y.small}`);

check(admin.errors.length === 0, '5c · no page errors throughout', admin.errors.join(' | '));

await browser.close();
console.log(`\n${failures === 0 ? '✓ camera screens: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
