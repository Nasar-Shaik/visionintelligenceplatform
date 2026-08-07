/**
 * P-6.3 · the Settings screen in a real browser, against the production deployment.
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/settings-ui.mjs
 *
 * Render states are captured by driving the **real API**, not by stubbing the page — a screenshot
 * of a mocked state proves the component renders, not that the product reaches it. The two
 * exceptions are labelled where they occur and say why.
 *
 * States: loading · populated · validation error · saving · conflict · permission denied ·
 *         backend failure · saved
 * Plus:   multi-tab conflict, browser refresh, cache consistency, branding contrast, responsive,
 *         accessibility, keyboard-only save.
 */
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const NOBODY = {
  email: `p63.norole.${Date.now()}@northgate.demo`,
  password: 'Probe-Password-2026!',
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();
const newSession = async (creds = ADMIN) => {
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
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { context, page, errors };
};

console.log('\nP-6.3 · /settings in the browser\n');

const { page, errors } = await newSession();

// ── loading ─────────────────────────────────────────────────────────────────────────────────────
/*
 * ⚠️ The one place the network is slowed rather than stubbed. The response is the **real** one from
 * the deployment; only its arrival is delayed, because a 7 ms round trip cannot be photographed.
 * The skeleton is therefore the real skeleton for the real request.
 */
let delayFirstRead = true;
await page.route('**/api/tenant/tenants/*', async (route) => {
  if (delayFirstRead && route.request().method() === 'GET') {
    delayFirstRead = false;
    await new Promise((r) => setTimeout(r, 2000));
  }
  /* The route may already be resolved if the page navigated away mid-flight. */
  await route.continue().catch(() => {});
});
const navigation = page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
const loading = await page.evaluate(() => ({
  shimmer: document.querySelectorAll('[class*="shimmer"]').length,
  field: document.querySelectorAll('#tenant-name').length,
  spinner: document.querySelectorAll('[class*="animate-spin"]').length,
}));
check(
  loading.shimmer > 0 && loading.field === 0,
  'loading — a shape-matched skeleton, not a spinner over a blank page',
  `${loading.shimmer} skeleton blocks, ${loading.spinner} spinners, field mounted: ${loading.field > 0}`,
);
await page.screenshot({ path: `${OUT}/settings-01-loading.png` });
await navigation;
await page.waitForTimeout(2000);
await page.unroute('**/api/tenant/tenants/*');

// ── populated ───────────────────────────────────────────────────────────────────────────────────
const field = page.getByLabel('Organisation name');
const originalName = await field.inputValue();
check(originalName.length > 0, 'populated — the tenant loaded', originalName);
check(errors.length === 0, 'no page or console errors', errors.join(' | '));
check(
  await page.getByText(/Immutable\. Used as a key and namespace prefix/).isVisible(),
  '⚠️ the immutable fields say *why* they are immutable',
);
check(
  await page.getByText(/applies to the whole deployment/i).isVisible(),
  '⚠️ branding is stated to be deployment-wide, not per-tenant',
);
check(
  (await page.getByRole('combobox', { name: /status/i }).count()) === 0,
  '⚠️ status is not editable — it is stored and enforced nowhere (L-24)',
);
await page.screenshot({ path: `${OUT}/settings-02-populated.png`, fullPage: true });

// ── branding contrast, reported rather than asserted ────────────────────────────────────────────
const contrastLine = await page.locator('text=/WCAG AA|built-in accent/').first().textContent();
check(
  contrastLine !== null,
  'branding reports its WCAG position on screen',
  contrastLine?.trim().slice(0, 90),
);

// ── validation error ────────────────────────────────────────────────────────────────────────────
await field.fill('');
check(
  await page.getByRole('button', { name: /save changes/i }).isDisabled(),
  'validation — Save is refused on an empty name',
);
check(await page.getByText('A name is required.').isVisible(), '…and says which rule was broken');
await page.screenshot({ path: `${OUT}/settings-03-validation.png` });

await field.fill('x'.repeat(201));
check(
  await page.getByText(/Too long — 201 of 200 characters/).isVisible(),
  'validation — an over-long name reports the count, not just "invalid"',
);

// ── saving (the in-flight state) ────────────────────────────────────────────────────────────────
await field.fill('Northgate Retail Group (P-6.3 probe)');
await page.route('**/api/tenant/tenants/*', async (route) => {
  if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 1200));
  await route.continue().catch(() => {});
});
const saveButton = page.getByRole('button', { name: /save changes/i });
await saveButton.click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/settings-04-saving.png` });
await page.waitForTimeout(1600);
await page.unroute('**/api/tenant/tenants/*');
check(
  await page
    .getByText(/Renamed to Northgate Retail Group \(P-6\.3 probe\)/)
    .isVisible()
    .catch(() => false),
  'saved — the result is confirmed, not left to be inferred',
);
await page.screenshot({ path: `${OUT}/settings-05-saved.png` });

// ── cache consistency + browser refresh ─────────────────────────────────────────────────────────
check(
  (await field.inputValue()) === 'Northgate Retail Group (P-6.3 probe)',
  'cache — the field shows what was saved, with no reload',
);
/*
 * ⚠️ The header is the cache-consistency check that matters, because it is a *different consumer*
 * of the same query. The field could be right simply because it is where the response landed.
 * (The top bar used to show the raw tenant id, so nothing about a rename was visible anywhere in
 * the shell — and the Settings page's own description said otherwise.)
 */
const headerAfterSave = await page.locator('header span[title]').first().textContent();
check(
  headerAfterSave?.trim() === 'Northgate Retail Group (P-6.3 probe)',
  '⚠️ cache — the top bar reflects the rename immediately, with no reload',
  headerAfterSave?.trim(),
);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
check(
  (await page.getByLabel('Organisation name').inputValue()) ===
    'Northgate Retail Group (P-6.3 probe)',
  '⚠️ refresh — the saved value survives a full reload (no stale cache, no stale optimistic UI)',
);
const brandingAfterReload = await page.evaluate(() => document.title);
check(
  brandingAfterReload.length > 0,
  'refresh — runtime branding still applied after reload',
  brandingAfterReload,
);
check(
  await page.getByRole('link', { name: 'Settings' }).isVisible(),
  'refresh — navigation is unchanged',
);
const headerAfterReload = await page.locator('header span[title]').first().textContent();
check(
  headerAfterReload?.trim() === 'Northgate Retail Group (P-6.3 probe)',
  '⚠️ refresh — and the top bar still shows it after a full reload',
  headerAfterReload?.trim(),
);

// ── multi-tab conflict, with two real browser sessions ──────────────────────────────────────────
const tabB = await newSession();
await tabB.page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await tabB.page.waitForTimeout(1800);

// Tab B saves first. Tab A is now holding a stale version and does not know it.
await tabB.page.getByLabel('Organisation name').fill('Saved from the second tab');
await tabB.page.getByRole('button', { name: /save changes/i }).click();
await tabB.page.waitForTimeout(1500);

await page.getByLabel('Organisation name').fill('Saved from the first tab');
await page.getByRole('button', { name: /save changes/i }).click();
await page.waitForTimeout(2000);
check(
  await page.getByText(/Someone else changed these settings while you were editing/).isVisible(),
  '⚠️ multi-tab — the stale tab is told, rather than silently overwriting',
);
check(
  (await page.getByLabel('Organisation name').inputValue()) === 'Saved from the second tab',
  '⚠️ multi-tab — and the stale tab now shows what is actually stored',
);
await page.screenshot({ path: `${OUT}/settings-06-conflict.png` });
await tabB.context.close();

// ── backend failure ─────────────────────────────────────────────────────────────────────────────
/*
 * ⚠️ The second and last interception. A 500 cannot be provoked from outside without breaking the
 * deployment for everything else; the shape returned is the platform's real error envelope.
 */
await page.route('**/api/tenant/tenants/*', async (route) => {
  if (route.request().method() !== 'PATCH') return route.continue().catch(() => {});
  await route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      error: { code: 'internal_error', message: 'Internal Server Error' },
    }),
  });
});
const beforeFailure = await page.getByLabel('Organisation name').inputValue();
await page.getByLabel('Organisation name').fill('This save will fail');
await page.getByRole('button', { name: /save changes/i }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/settings-07-backend-failure.png` });
await page.unroute('**/api/tenant/tenants/*');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
check(
  (await page.getByLabel('Organisation name').inputValue()) === beforeFailure,
  '⚠️ rollback — a failed save leaves the authoritative state untouched',
  beforeFailure,
);

// ── restore the dataset before the read-only checks ─────────────────────────────────────────────
await page.getByLabel('Organisation name').fill('Northgate Retail Group');
await page.getByRole('button', { name: /save changes/i }).click();
await page.waitForTimeout(1500);
check(
  (await page.getByLabel('Organisation name').inputValue()) === 'Northgate Retail Group',
  '⚠️ dataset restored',
);

// ── accessibility + responsive ──────────────────────────────────────────────────────────────────
const a11y = await page.evaluate(() => {
  const named = (el) =>
    (el.getAttribute('aria-label') ?? '') ||
    (el.getAttribute('title') ?? '') ||
    (el.textContent ?? '').trim() ||
    (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) ||
    '';
  const controls = [...document.querySelectorAll('button, a[href], input, [role="combobox"]')];
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < levels.length; i += 1) if (levels[i] - levels[i - 1] > 1) skips += 1;
  return {
    unnamed: controls.filter((el) => named(el) === '').length,
    small: controls.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.width < 24 || r.height < 24);
    }).length,
    skips,
    total: controls.length,
    /* ⚠️ Static prose must not be an assertive live region. `Alert variant="info"` used to be. */
    infoAlerts: [...document.querySelectorAll('[role="alert"]')].filter((el) =>
      (el.textContent ?? '').includes('applies to the whole deployment'),
    ).length,
  };
});
check(a11y.unnamed === 0, 'a11y — every control named', `${a11y.total} controls`);
check(a11y.small === 0, 'a11y — every target ≥ 24 px');
check(a11y.skips === 0, 'a11y — no heading levels skipped');
check(
  a11y.infoAlerts === 0,
  '⚠️ a11y — the standing branding note is not an assertive live region',
);

// Keyboard-only save.
await page.getByLabel('Organisation name').focus();
await page.keyboard.type(' ');
await page.keyboard.press('Backspace');
const focusRing = await page.evaluate(() => {
  const s = getComputedStyle(document.activeElement);
  return s.outlineStyle !== 'none' || s.boxShadow !== 'none';
});
check(focusRing, 'keyboard — the focused field shows a visible focus ring');

/*
 * ⚠️ **With a toast on screen**, which is how the one real overflow in this milestone was found.
 * sonner's container is a fixed 356 px plus a 32 px inset, so at 390 px it painted 16 px past the
 * right edge — every toast, on every page. Measuring a settled page would have missed it entirely,
 * because the defect only exists while something is being confirmed.
 */
await page.getByLabel('Organisation name').fill('Northgate Retail Group (toast probe)');
await page.getByRole('button', { name: /save changes/i }).click();
await page.waitForTimeout(900);

// Long name, multilingual values, and a wide colour swatch — realistic content, not lorem ipsum.
const LONG =
  'Fédération Internationale de Sécurité et de Surveillance — 国际安全监控集团有限公司 (Groupe Régional Nord-Ouest)';
await page.getByLabel('Organisation name').fill(LONG);
await page.waitForTimeout(300);
for (const width of [1920, 1440, 1280, 1024, 768, 390]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(300);
  const clipped = await page.evaluate(() => {
    const scrollable = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const o = getComputedStyle(n).overflowX;
        if (o === 'auto' || o === 'scroll') return true;
      }
      return false;
    };
    const inShell = (el) => Boolean(el.closest('header, aside'));
    const bad = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > document.documentElement.clientWidth + 1 && !scrollable(el);
    });
    return { page: bad.filter((el) => !inShell(el)).length, shell: bad.filter(inShell).length };
  });
  check(
    clipped.page === 0,
    `${width} px — a 110-character multilingual name + a live toast paint nothing off-screen`,
    clipped.shell > 0
      ? `page=${clipped.page}, shell=${clipped.shell} (TD-45)`
      : `page=${clipped.page}`,
  );
}
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/settings-08-phone.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 900 });
await page.getByLabel('Organisation name').fill('Northgate Retail Group');
await page.waitForTimeout(300);

// ── permission denied, with a real principal that holds nothing ─────────────────────────────────
/*
 * ⚠️ A genuinely role-less account, created through the API that P-6.2 added, rather than a stubbed
 * 403. The page must refuse on the client *and* the API must refuse independently.
 */
const token = await page.evaluate(
  async ([tenant, creds]) => {
    const res = await fetch('/api/identity/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenant },
      body: JSON.stringify(creds),
    });
    return (await res.json())?.data?.accessToken ?? null;
  },
  [TENANT, ADMIN],
);

const created = await page.evaluate(
  async ([tok, creds]) => {
    const res = await fetch('/api/identity/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ email: creds.email, password: creds.password, roles: [] }),
    });
    return { status: res.status, body: await res.json() };
  },
  [token, NOBODY],
);
check(created.status === 201, 'a role-less probe account is created', `HTTP ${created.status}`);

const nobody = await newSession(NOBODY);
await nobody.page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
await nobody.page.waitForTimeout(1500);
check(
  await nobody.page.getByText(/not authorized/i).isVisible(),
  '⚠️ permission denied — a principal with no grants is refused by the page',
);
check(
  (await nobody.page.getByRole('link', { name: 'Settings' }).count()) === 0,
  '…and Settings is absent from their sidebar',
);
await nobody.page.screenshot({ path: `${OUT}/settings-09-permission-denied.png`, fullPage: true });

const apiRefusal = await nobody.page.evaluate(
  async ([tenant]) => {
    const res = await fetch(`/api/tenant/tenants/${tenant}`, {
      headers: { accept: 'application/json' },
    });
    return res.status;
  },
  [TENANT],
);
check(
  apiRefusal === 401 || apiRefusal === 403,
  '⚠️ …and the API refuses independently of the UI',
  `HTTP ${apiRefusal}`,
);
await nobody.context.close();

await browser.close();
console.log(`
⚠️  Probe account left in place (there is no DELETE route). Remove with:

  docker exec vip-prod-mongodb-1 mongosh -u "$MONGO_USER" -p "$MONGO_PASSWORD" \\
    --authenticationDatabase admin vip --quiet \\
    --eval 'db.users.deleteMany({ email: /^p63\\.norole/ })'
`);
console.log(failures === 0 ? 'All checks passed.\n' : `${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
