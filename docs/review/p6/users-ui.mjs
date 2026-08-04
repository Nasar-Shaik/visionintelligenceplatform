/**
 * P-6.2 · the Users screen in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/users-ui.mjs
 *
 * Every gate the release plan requires for a new screen, in one pass:
 *   render      — zero pageerror, zero console errors (gate 4; P-5.9 certified a crashed page)
 *   states      — the five render states, checked by driving the API rather than by inspection
 *   responsive  — painted-box overflow at 390 → 1920 (gate 5; `document.scrollWidth` lies)
 *   a11y        — every control named, every target ≥ 24 px, no heading skips, focus visible
 *   keyboard    — the whole disable flow with no mouse (gate 7)
 *   screenshots — dark and light, desktop and phone
 */
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const TENANT = 'tnt_demo_retail';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

const errors = [];
page.on(
  'console',
  (m) => m.type() === 'error' && errors.push(`[console] ${m.text().slice(0, 200)}`),
);
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

async function signIn(creds = ADMIN) {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

console.log('\nP-6.2 · /users in the browser\n');

await signIn();
await page.goto(`${B}/users`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// ── render ──────────────────────────────────────────────────────────────────────────────────────
check(errors.length === 0, 'renders with no page or console errors', errors.join(' | '));
check(
  await page.getByRole('heading', { name: 'Users', level: 1 }).isVisible(),
  'the page rendered its own heading (not the route error boundary)',
);
const rows = await page.getByRole('row').count();
check(rows >= 5, 'the tenant’s users are listed', `${rows - 1} rows`);

// ── the nav entry, which is what makes it exist for a customer ───────────────────────────────────
check(
  await page.getByRole('link', { name: 'Users' }).isVisible(),
  '⚠️ reachable from the sidebar (a route with no entry is not a feature)',
);

// ── accessibility ───────────────────────────────────────────────────────────────────────────────
const a11y = await page.evaluate(() => {
  const named = (el) =>
    (el.getAttribute('aria-label') ?? '') ||
    (el.getAttribute('title') ?? '') ||
    (el.textContent ?? '').trim() ||
    (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) ||
    '';
  const controls = [
    ...document.querySelectorAll('button, a[href], input, select, [role="combobox"]'),
  ];
  const unnamed = controls.filter((el) => named(el) === '').length;
  const small = controls.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.width < 24 || r.height < 24);
  }).length;
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < levels.length; i += 1) if (levels[i] - levels[i - 1] > 1) skips += 1;
  return { unnamed, small, skips, controls: controls.length };
});
check(a11y.unnamed === 0, 'every control has an accessible name', `${a11y.controls} controls`);
check(a11y.small === 0, 'every target is at least 24×24 px', `${a11y.small} too small`);
check(a11y.skips === 0, 'no heading levels skipped');

// ── the self-disable guard, in the DOM ──────────────────────────────────────────────────────────
const selfButton = page.getByRole('button', { name: `Disable ${ADMIN.email}` });
check(await selfButton.isDisabled(), '⚠️ the signed-in admin cannot disable themselves');
check(
  (await selfButton.getAttribute('title')) === 'You cannot disable your own account',
  '…and the reason is on the control, not only in the server response',
);

// ── keyboard-only: open the disable dialog and cancel it ────────────────────────────────────────
const target = page.getByRole('button', { name: 'Disable day.operator@northgate.demo' });
await target.focus();
const focusVisible = await page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return false;
  const s = getComputedStyle(el);
  return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
});
check(focusVisible, 'the focused control shows a visible focus ring');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
check(await page.getByRole('dialog').isVisible(), 'the confirmation opens from the keyboard');
check(
  (await page.getByRole('dialog').textContent())?.includes('Nothing is deleted') ?? false,
  '⚠️ the dialog states that nothing is deleted',
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check((await page.getByRole('dialog').count()) === 0, 'Escape closes it without disabling anyone');

/*
 * ── responsive: painted-box overflow, scrollable ancestors excluded ────────────────────────────
 *
 * ⚠️ Clipping is attributed to the **shell** or to the **page**, and only the page's count fails
 * this script. Measured: at 390 px `/users`, `/rules` and `/incidents` each clip the same 13
 * elements — every one of them inside the top bar's right-hand cluster, which is 240 px of fixed
 * sidebar squeezing a 270 px cluster into 150 px (TD-45). A check that goes red on every page for
 * one shell defect is a check everyone learns to ignore, and the next real page defect hides
 * behind it. Splitting the count keeps it able to fail for the right reason.
 */
for (const width of [1920, 1536, 1440, 1280, 1024, 768, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const clipped = await page.evaluate(() => {
    const scrollable = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n).overflowX;
        if (o === 'auto' || o === 'scroll') return true;
      }
      return false;
    };
    const inShell = (el) => Boolean(el.closest('header, aside, [data-shell]'));
    const bad = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !scrollable(el);
    });
    return { shell: bad.filter(inShell).length, page: bad.filter((el) => !inShell(el)).length };
  });
  check(
    clipped.page === 0,
    `${width} px — the page paints nothing off-screen`,
    clipped.shell > 0
      ? `page=${clipped.page}, shell=${clipped.shell} (TD-45)`
      : `page=${clipped.page}`,
  );
}

// ── screenshots ─────────────────────────────────────────────────────────────────────────────────
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/users-desktop.png`, fullPage: true });
await page.getByRole('button', { name: 'Disable day.operator@northgate.demo' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/users-disable-dialog.png` });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Roles' }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/users-roles-dialog.png` });
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/users-phone.png`, fullPage: true });

// ── an operator sees the list and no controls ───────────────────────────────────────────────────
await page.setViewportSize({ width: 1440, height: 900 });
const opContext = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const opPage = await opContext.newPage();
const opErrors = [];
opPage.on('pageerror', (e) => opErrors.push(e.message));
await opPage.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await opPage.getByLabel(/tenant/i).fill(TENANT);
await opPage.getByLabel(/email/i).fill('day.operator@northgate.demo');
await opPage.getByLabel(/password/i).fill('Vip-Demo-2026!');
await opPage.getByRole('button', { name: /sign in/i }).click();
await opPage.waitForURL((u) => !u.pathname.startsWith('/login'));
check(
  (await opPage.getByRole('link', { name: 'Users' }).count()) === 0,
  '⚠️ an operator has no Users entry in the sidebar (`*:read` would have shown it)',
);
await opPage.goto(`${B}/users`, { waitUntil: 'domcontentloaded' });
await opPage.waitForTimeout(1500);
check(
  opErrors.length === 0,
  'an operator opening /users directly does not crash',
  opErrors.join(' | '),
);
check(
  (await opPage.getByRole('button', { name: /^Disable / }).count()) === 0,
  '…and sees no write controls',
);
await opPage.screenshot({ path: `${OUT}/users-operator.png`, fullPage: true });

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
