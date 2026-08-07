/**
 * Roadmap review — verification against the running production deployment.
 *
 * Signs in as the retail demo operator and walks every route in the nav, recording every page error
 * and console error. Exists because a committed P-5.9 screenshot showed /cameras rendering the
 * route error boundary, which the P-5.9 audit reported as zero findings.
 *
 * Usage: npx -y playwright@latest ... — see README.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? 'docs/review/roadmap-2026-08/screens';
const TENANT = 'tnt_demo_retail';
const EMAIL = 'security.manager@northgate.demo';
const PASSWORD = process.env.SEED_PASSWORD ?? '12345678';

const ROUTES = [
  ['dashboard', '/'],
  ['live', '/live'],
  ['cameras', '/cameras'],
  ['locations', '/locations'],
  ['events', '/events'],
  ['incidents', '/incidents'],
  ['workspace', '/workspace'],
  ['alerts', '/alerts'],
  ['rules', '/rules'],
  ['users', '/users'],
  /*
   * ⚠️ `/system`, not `/health`. The edge routes `/health` to the **gateway's liveness probe**, so a
   * console route at that path can never be reached in a deployment — the browser gets
   * `{"status":"ok"}`. This list said `/health` for two milestones and reported it as rendering,
   * because the JSON body logs no errors and shows no crash boundary. See the assertion below.
   */
  ['system', '/system'],
  ['settings', '/settings'],
];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();

/** Errors are collected per route, so a crash is attributed to the page that caused it. */
let current = 'login';
let failures = 0;
const findings = [];
page.on('pageerror', (e) => findings.push({ route: current, kind: 'pageerror', text: e.message }));
page.on('console', (m) => {
  if (m.type() === 'error') findings.push({ route: current, kind: 'console', text: m.text() });
});

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.getByLabel(/tenant/i).fill(TENANT);
await page.getByLabel(/email/i).fill(EMAIL);
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });

for (const [name, path] of ROUTES) {
  current = name;
  /*
   * ⚠️ `networkidle` never fires on this product: the dashboard polls every 15s and the live feed
   * holds an SSE connection open. Waiting for it times out on a *working* page.
   */
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  /* The route error boundary is the signal: a page that rendered it did not render. */
  const crashed = await page
    .getByText('This page stopped working')
    .isVisible()
    .catch(() => false);
  const detail = crashed
    ? await page
        .locator('code, pre')
        .first()
        .textContent()
        .catch(() => null)
    : null;

  /*
   * ⚠️ **"No crash and no console error" is not evidence that the console rendered.**
   *
   * P-6.4 found `/health` answering `{"status":"ok"}` from the edge's liveness probe rather than
   * reaching the console at all — and this script had been reporting it as a rendering route,
   * because a JSON body logs nothing and shows no error boundary. It would have passed for a path
   * that had never been implemented.
   *
   * The shell is the proof. Every route below the auth guard renders inside it, so a page that
   * produced no `<nav>` did not render the console, whatever else it produced.
   */
  const shell = await page.evaluate(() => document.querySelectorAll('nav a').length);
  const missing = shell === 0;

  await page.screenshot({ path: `${OUT}/${name}.png` });
  const verdict = crashed ? '✗ CRASHED' : missing ? '✗ NOT THE CONSOLE' : '✓ ok     ';
  console.log(
    `${verdict}  ${name.padEnd(11)} ${detail ?? (missing ? await page.evaluate(() => document.body.innerText.slice(0, 60)) : '')}`,
  );
  if (crashed || missing) failures += 1;
}

console.log('\n── errors ──');
if (findings.length === 0) console.log('none');
for (const f of findings) console.log(`  [${f.route}] ${f.kind}: ${f.text.slice(0, 160)}`);

await browser.close();
/* ⚠️ Exits non-zero. A verification script that always succeeds is a log file. */
process.exit(failures === 0 && findings.length === 0 ? 0 : 1);
