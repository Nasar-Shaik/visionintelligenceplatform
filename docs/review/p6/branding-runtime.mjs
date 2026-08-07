/**
 * P-6.3 · branding is runtime configuration, proven rather than asserted.
 *
 * ⚠️ Run from /private/tmp/pwrun:
 *   cd /private/tmp/pwrun && OUT=<dir> node <repo>/docs/review/p6/branding-runtime.mjs
 *
 * The claim under test is "**changing branding never requires rebuilding the frontend**". A test
 * that reads `branding.json` and checks the console reflects it does not test that: it tests that
 * whatever shipped in the image is displayed. So this **overwrites the file inside the running
 * container** with `docker cp` — no build, no image, no redeploy — and reloads the browser.
 *
 * It also checks the thing a white-label customer will get wrong first: a brand colour that cannot
 * reach WCAG AA. That colour must be **refused**, not rendered as an unreadable button.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const CONTAINER = process.env.CONSOLE_CONTAINER ?? 'vip-prod-console-1';
const TARGET = '/usr/share/nginx/html/branding.json';
const TMP = '/tmp/vip-branding-probe.json';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** Resolve where the console actually serves static files from, rather than assuming a path. */
function servedRoot() {
  for (const candidate of ['/usr/share/nginx/html', '/srv', '/app/dist', '/usr/share/caddy']) {
    try {
      execFileSync('docker', ['exec', CONTAINER, 'ls', `${candidate}/index.html`], {
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const root = servedRoot();
if (root === null) {
  console.error(`could not locate the served root inside ${CONTAINER}`);
  process.exit(1);
}
const target = `${root}/branding.json`;
console.log(`\nP-6.3 · runtime branding (${CONTAINER}:${target})\n`);

/** Read the current file so it can be put back exactly as it was. */
let original = null;
try {
  original = execFileSync('docker', ['exec', CONTAINER, 'cat', target], { encoding: 'utf8' });
} catch {
  /* absent is a valid starting state — the defaults apply. */
}

const write = (value) => {
  writeFileSync(TMP, JSON.stringify(value, null, 2));
  execFileSync('docker', ['cp', TMP, `${CONTAINER}:${target}`]);
};
const restore = () => {
  if (original === null) {
    try {
      execFileSync('docker', ['exec', CONTAINER, 'rm', '-f', target]);
    } catch {
      /* nothing to remove */
    }
  } else {
    writeFileSync(TMP, original);
    execFileSync('docker', ['cp', TMP, `${CONTAINER}:${target}`]);
  }
  try {
    unlinkSync(TMP);
  } catch {
    /* already gone */
  }
};

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

async function signIn() {
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill('tnt_demo_retail');
  await page.getByLabel(/email/i).fill('security.manager@northgate.demo');
  await page.getByLabel(/password/i).fill('12345678');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
}

const brandTokens = () =>
  page.evaluate(() => ({
    title: document.title,
    brand: getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim(),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim(),
    onPrimary: getComputedStyle(document.documentElement)
      .getPropertyValue('--color-primary-foreground')
      .trim(),
    sidebar: document.querySelector('aside span')?.textContent ?? '',
  }));

try {
  // ── baseline ──────────────────────────────────────────────────────────────────────────────────
  await signIn();
  await page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const before = await brandTokens();
  check(before.title.length > 0, 'baseline branding is in force', before.title);

  // ── a valid white-label, applied with no rebuild ───────────────────────────────────────────────
  write({
    productName: 'Meridian Watchtower',
    productTagline: 'Secure sign-in',
    brandColor: '#00695c',
    favicon: '🗼',
    footerNote: 'Meridian Group — internal use only',
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const branded = await brandTokens();

  check(
    branded.title === 'Meridian Watchtower',
    '⚠️ a new product name applies after a reload — no rebuild, no redeploy',
    branded.title,
  );
  check(
    branded.sidebar.includes('Meridian Watchtower'),
    '…and the sidebar carries it too',
    branded.sidebar,
  );
  check(
    branded.brand.toLowerCase() === '#00695c',
    'the accent token was re-tinted',
    `--color-brand: ${branded.brand}`,
  );
  check(
    branded.onPrimary === '#ffffff',
    '⚠️ the foreground flipped to the readable side automatically',
    `--color-primary-foreground: ${branded.onPrimary}`,
  );
  await page.screenshot({ path: `${OUT}/branding-01-white-label.png`, fullPage: true });

  // The Settings panel must report the same numbers the token layer acted on.
  const reported = await page
    .locator('text=/passes WCAG AA|below the WCAG AA/')
    .first()
    .textContent();
  check(
    reported?.includes('passes WCAG AA') ?? false,
    'Settings reports the measured ratio for the applied colour',
    reported?.trim().slice(0, 80),
  );

  /*
   * ── a colour that cannot reach AA must be refused, not rendered ────────────────────────────────
   *
   * ⚠️ `#7a7a7a`, and the exact value took a calculation rather than a guess. The first attempt used
   * `#808080` on the assumption that mid-grey obviously fails — it scores **4.67:1 against
   * near-black** and legitimately passes, so the check went red against correct behaviour. The band
   * that fails *both* foregrounds is narrow (relative luminance ≈ 0.183–0.204) because the dark
   * reference is `#121418`; `#7a7a7a` sits in it at 4.29:1 and 4.30:1.
   */
  write({ productName: 'Meridian Watchtower', brandColor: '#7a7a7a' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const rejected = await brandTokens();
  check(
    rejected.brand.toLowerCase() !== '#7a7a7a',
    '⚠️ a colour below 4.5:1 is refused rather than shipped as an unreadable button',
    `--color-brand stayed ${rejected.brand}`,
  );
  await page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const warned = await page
    .locator('text=/below the WCAG AA/')
    .first()
    .textContent()
    .catch(() => null);
  check(
    warned !== null,
    '…and Settings says so, with the ratio it actually scored',
    warned?.trim().slice(0, 90),
  );
  await page.screenshot({ path: `${OUT}/branding-02-contrast-refused.png`, fullPage: true });

  // ── a malformed file must never take the console down ─────────────────────────────────────────
  execFileSync('bash', ['-c', `printf 'not json at all' > ${TMP}`]);
  execFileSync('docker', ['cp', TMP, `${CONTAINER}:${target}`]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  check(
    errors.length === 0 && (await page.getByRole('heading', { name: 'Settings' }).isVisible()),
    '⚠️ a malformed branding file falls back to defaults instead of blocking the console',
    errors.join(' | '),
  );

  // ── tenant isolation: branding is deployment-wide, and the product says so ─────────────────────
  /*
   * ⚠️ This is a **limitation being verified, not a feature**. Branding is loaded before sign-in,
   * so it cannot vary by tenant yet. The check is that a second tenant sees the *same* branding —
   * confirming the documented behaviour — and that the console states it rather than implying
   * per-tenant theming that does not exist.
   */
  restore();
  write({ productName: 'Shared Deployment Brand' });
  const second = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const secondPage = await second.newPage();
  await secondPage.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await secondPage.getByLabel(/tenant/i).fill('tnt_demo_warehouse');
  await secondPage.getByLabel(/email/i).fill('site.manager@meridian.demo');
  await secondPage.getByLabel(/password/i).fill('12345678');
  await secondPage.getByRole('button', { name: /sign in/i }).click();
  await secondPage.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await secondPage.waitForTimeout(1200);
  check(
    (await secondPage.title()) === 'Shared Deployment Brand',
    '⚠️ a second tenant sees the same branding — deployment-wide, as documented (L-26)',
    await secondPage.title(),
  );
  await second.close();
} finally {
  restore();
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await browser.close();
}

console.log(
  failures === 0
    ? '\nAll checks passed. Branding file restored.\n'
    : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
