/**
 * P-6.3 · the freeze pass in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/p63-freeze-ui.mjs
 *
 * D  **Navigation.** Deep link, refresh, back, forward, and arriving from another page. A settings
 *    screen is where people land from a link someone sent them, not only from the sidebar.
 * E  **Branding across pages.** Three pages open at once; change `branding.json` in the running
 *    container; refresh. Every page must agree, and the ones not refreshed must not half-change.
 * F  The one render state the earlier pass could not photograph: **unavailable**.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const CONTAINER = process.env.CONSOLE_CONTAINER ?? 'vip-prod-console-1';
const TMP = '/tmp/vip-branding-freeze.json';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const newSession = async () => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 160)}`),
  );
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page, errors };
};

/** The tenant name the settings form is actually showing. */
const shownName = (page) => page.locator('#tenant-name').inputValue();
/** The organisation name in the top bar — the other place the same fact is rendered. */
const topbarName = (page) =>
  page.evaluate(() => document.querySelector('header')?.textContent?.trim() ?? '');

console.log('\nP-6.3 · freeze pass in the browser\n');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D · navigation
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('D · navigation');

const { page, errors, context } = await newSession();

// D1 — a deep link. Somebody pasted /settings into a chat.
await page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
const deepLinked = await shownName(page);
check(deepLinked.length > 0, 'D1 · a direct deep link renders the populated form', deepLinked);

// D2 — refresh. The commonest thing an operator does when they are unsure.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === deepLinked, 'D2 · a refresh restores the same state');

// D3 — arriving from another page, through the sidebar rather than the URL bar.
await page.goto(`${B}/incidents`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
await page.getByRole('link', { name: /settings/i }).first().click();
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === deepLinked, 'D3 · arriving from another page renders the same');
check(new URL(page.url()).pathname === '/settings', 'D3 · and the URL is the deep link');

// D4 — back, to the page we came from.
await page.goBack({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
check(new URL(page.url()).pathname === '/incidents', 'D4 · back returns to the previous page');
const backRendered = await page.evaluate(() => document.querySelectorAll('main *').length);
check(backRendered > 20, 'D4 · ⚠️ and that page renders — not a blank shell', `${backRendered} nodes`);

// D5 — forward, back into settings.
await page.goForward({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === deepLinked, 'D5 · forward restores the populated form');

/*
 * D6 — the sequence that actually breaks products: save, then immediately navigate away and come
 * back. A cache that was invalidated but never refetched shows the old value here, and only here.
 */
const probeName = `${deepLinked} (nav probe)`;
await page.locator('#tenant-name').fill(probeName);
await page.getByRole('button', { name: /save/i }).first().click();
await page.waitForTimeout(1200);

await page.goto(`${B}/incidents`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
await page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === probeName, 'D6 · a saved change survives leaving and returning');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === probeName, 'D6 · and a hard refresh immediately after the save');
check(
  (await topbarName(page)).includes(probeName),
  'D6 · ⚠️ and the top bar agrees — one fact, one value, two renderings',
);

// Restore the tenant name before anything else runs.
await page.locator('#tenant-name').fill(deepLinked);
await page.getByRole('button', { name: /save/i }).first().click();
await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#tenant-name', { timeout: 15_000 });
check((await shownName(page)) === deepLinked, 'D · the tenant name is restored', deepLinked);
check(errors.length === 0, 'D · no console or page errors throughout', errors.join(' | '));

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E · branding, with several pages open at once
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nE · runtime branding across pages');

const root = (() => {
  for (const candidate of ['/usr/share/nginx/html', '/srv', '/app/dist', '/usr/share/caddy']) {
    try {
      execFileSync('docker', ['exec', CONTAINER, 'ls', `${candidate}/index.html`], {
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
})();
if (root === null) {
  console.error(`could not locate the served root inside ${CONTAINER}`);
  process.exit(1);
}
const target = `${root}/branding.json`;
let originalBranding = null;
try {
  originalBranding = execFileSync('docker', ['exec', CONTAINER, 'cat', target], {
    encoding: 'utf8',
  });
} catch {
  /* absent is a valid starting state */
}
const writeBranding = (value) => {
  writeFileSync(TMP, JSON.stringify(value, null, 2));
  execFileSync('docker', ['cp', TMP, `${CONTAINER}:${target}`]);
};

const NEW_NAME = 'Freeze Pass Control Room';
const tabs = [];
for (const path of ['/settings', '/incidents', '/cameras']) {
  const p = await context.newPage();
  await p.goto(`${B}${path}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(900);
  tabs.push({ path, page: p });
}

/*
 * ⚠️ `document.title`, not the sidebar text. Branding writes the product name to the tab title, the
 * sidebar heading and the login screen; the title is the one that is unambiguous to read, and the
 * first version of this check read `nav` — which is the *navigation items* — and reported "no
 * change" against branding that had in fact changed.
 */
const productName = (p) => p.evaluate(() => document.title);
const before = await Promise.all(tabs.map((t) => productName(t.page)));
check(
  new Set(before).size === 1,
  'E1 · three pages open agree on the product name before the change',
  before[0],
);

writeBranding({
  productName: NEW_NAME,
  productTagline: 'Sign in to continue',
  logoUrl: '',
  favicon: '🧪',
  brandColor: '#1d4ed8',
  footerNote: 'P-6.3 freeze pass',
});

/*
 * ⚠️ Deliberately checked *before* refreshing. Branding is read once at boot, so a tab that has been
 * open across the change must still show the old value — a page that half-updated would mean the
 * name and the colour could disagree inside one screen.
 */
const unrefreshed = await Promise.all(tabs.map((t) => productName(t.page)));
check(
  unrefreshed.every((n) => n === before[0]),
  'E2 · ⚠️ tabs open across the change do not half-update',
);

for (const t of tabs) {
  await t.page.reload({ waitUntil: 'domcontentloaded' });
  await t.page.waitForTimeout(900);
}
const after = await Promise.all(tabs.map((t) => productName(t.page)));
check(
  after.every((n) => n.includes(NEW_NAME)),
  'E3 · every page reflects the new branding after refresh',
  after.map((n, i) => `${tabs[i].path}:${n}`).join(' · '),
);

/*
 * ⚠️ `--color-brand`, which is the token `theme.css` defines and Tailwind's utilities read. There is
 * no `--brand`; asking for it returns an empty string for every page, which looks exactly like
 * "every page agrees" if the check only compares them to each other. The same trap the branding
 * implementation records having fallen into once already.
 */
const accents = await Promise.all(
  tabs.map((t) =>
    t.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim(),
    ),
  ),
);
check(
  new Set(accents).size === 1 && accents[0] !== '',
  'E3 · and every page resolves the same accent token',
  accents[0],
);
await tabs[0].page.screenshot({ path: `${OUT}/freeze-branding-multipage.png`, fullPage: true });

// Put the deployment back exactly as it was, then prove it took.
if (originalBranding === null) {
  try {
    execFileSync('docker', ['exec', CONTAINER, 'rm', '-f', target]);
  } catch {
    /* nothing to remove */
  }
} else {
  writeFileSync(TMP, originalBranding);
  execFileSync('docker', ['cp', TMP, `${CONTAINER}:${target}`]);
}
try {
  unlinkSync(TMP);
} catch {
  /* already gone */
}
await tabs[0].page.reload({ waitUntil: 'domcontentloaded' });
await tabs[0].page.waitForTimeout(900);
check(
  (await productName(tabs[0].page)) === before[0],
  'E · the deployment branding is restored',
  before[0],
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// F · the unavailable state
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nF · the unavailable state');

/*
 * ⚠️ **The one capture in this milestone that is not reachable through the product, and it is
 * labelled rather than quietly staged.**
 *
 * `/settings` renders "unavailable" when the session carries no tenant. Sign-in requires a tenant,
 * so no real session can be in that state — the branch exists because a *future* sign-in flow
 * (D-1, tenant discovery at login) can produce one, and a page that renders nothing at all in that
 * case would be a white screen. The login response is rewritten in flight to produce it.
 */
const stub = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const stubbed = await stub.newPage();
/*
 * The session's tenant comes from the **principal** (`/auth/me`), not from the login form or the
 * token pair — so every identity response is rewritten, recursively, rather than guessing which one
 * carries it. Guessing is what the first attempt did, and the page rendered normally.
 */
await stubbed.route('**/api/identity/auth/**', async (route) => {
  const response = await route.fetch();
  let body;
  try {
    body = await response.json();
  } catch {
    await route.fulfill({ response });
    return;
  }
  const blank = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'tenantId' && typeof value === 'string') node[key] = '';
      else blank(value);
    }
  };
  blank(body);
  await route.fulfill({ response, body: JSON.stringify(body) });
});
await stubbed.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await stubbed.getByLabel(/tenant/i).fill(TENANT);
await stubbed.getByLabel(/email/i).fill(ADMIN.email);
await stubbed.getByLabel(/password/i).fill(ADMIN.password);
await stubbed.getByRole('button', { name: /sign in/i }).click();
await stubbed.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
await stubbed.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await stubbed.waitForTimeout(1200);

const unavailable = await stubbed.evaluate(() => ({
  text: document.querySelector('main')?.textContent ?? '',
  form: document.querySelectorAll('#tenant-name').length,
}));
check(unavailable.form === 0, 'F1 · no editable form is offered when the tenant is unknown');
check(
  /unavailable|no tenant|not available/i.test(unavailable.text),
  'F1 · ⚠️ and the screen says so, rather than rendering an empty page',
  unavailable.text.replace(/\s+/g, ' ').slice(0, 90),
);
await stubbed.screenshot({ path: `${OUT}/settings-10-unavailable.png`, fullPage: true });

await browser.close();
console.log(
  `\n${failures === 0 ? '✓ P-6.3 browser freeze pass: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
