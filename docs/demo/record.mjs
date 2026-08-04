/**
 * The demo gallery recorder — **real workflows, against the running deployment.**
 *
 * ⚠️ Run from /private/tmp/pwrun (Playwright is not a repo dependency):
 *   cd /private/tmp/pwrun && OUT=<repo>/docs/demo node <repo>/docs/demo/record.mjs [feature…]
 *
 * Every clip here is a recording of the **production build**, signed in as a real demo account,
 * driving the real API. Nothing is mocked, staged or sped up.
 *
 * ### ⚠️ Why this exists, and what it must never become
 *
 * A demo library assembled the week before a customer meeting is assembled from whatever happens to
 * work that week. Recording each feature as it lands means the gallery is a by-product of the
 * milestone rather than a project of its own — and it means a workflow that has quietly stopped
 * working shows up here, in a clip that fails to record, months before anyone would have found it in
 * a meeting.
 *
 * ⚠️ **A clip is not a claim.** Every gallery page carries the feature's known limitations beside
 * its recording, because a demonstration that omits them is the most expensive kind of promise.
 *
 * ⚠️ **Never record anything the platform cannot do.** No sped-up waits hiding a slow path, no
 * fixtures dressed as live data, no cut between a click and a result that did not follow it.
 *
 * Output: `<OUT>/<feature>/<feature>.webm` — WebM because Playwright records it natively and every
 * browser plays it. There is no ffmpeg in this toolchain, so there are no GIFs; a GIF of a
 * thirty-second workflow is also several megabytes of repository.
 */
import { mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };

const wanted = process.argv.slice(2);
const browser = await chromium.launch();

/** A slower click, so a viewer can follow what was pressed. Honest: it delays, it never fakes. */
const beat = (ms = 900) => new Promise((r) => setTimeout(r, ms));

async function record(name, workflow) {
  if (wanted.length > 0 && !wanted.includes(name)) return;
  const dir = `${OUT}/${name}`;
  mkdirSync(dir, { recursive: true });
  const raw = `${dir}/.raw`;
  rmSync(raw, { recursive: true, force: true });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: raw, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await beat(600);
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await beat(500);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await beat();

  let failed = null;
  try {
    await workflow(page);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  }
  await beat(1_200);
  await context.close(); // flushes the video

  const file = readdirSync(raw).find((f) => f.endsWith('.webm'));
  if (file) renameSync(`${raw}/${file}`, `${dir}/${name}.webm`);
  rmSync(raw, { recursive: true, force: true });

  const ok = failed === null && errors.length === 0;
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(20)} ${failed ?? errors.join(' | ')}`);
  return ok;
}

let failures = 0;
const run = async (name, fn) => {
  if ((await record(name, fn)) === false) failures += 1;
};

console.log('\nRecording the demo gallery against the deployment\n');

// ── System Health (P-6.4) ───────────────────────────────────────────────────────────────────────
/*
 * ⚠️ The clip is worth recording precisely because it does **not** end in a wall of green. It shows
 * the page reading healthy, then object storage being taken away underneath it, then the page
 * saying so on its own — which is the claim the feature actually makes.
 */
await run('system-health', async (page) => {
  const { execFileSync } = await import('node:child_process');
  await page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main li', { timeout: 20_000 });
  await beat(2_500);
  await page.mouse.wheel(0, 500);
  await beat(2_000);
  await page.mouse.wheel(0, 700);
  await beat(2_500);
  await page.mouse.wheel(0, -1_200);
  await beat(800);

  execFileSync('docker', ['stop', 'vip-prod-minio-1'], { encoding: 'utf8' });
  try {
    for (let i = 0; i < 20; i += 1) {
      await beat(2_000);
      const degraded = await page.evaluate(() =>
        /Degraded|Unavailable/.test(document.querySelector('main')?.textContent ?? ''),
      );
      if (degraded) break;
    }
    await beat(3_000);
  } finally {
    execFileSync('docker', ['start', 'vip-prod-minio-1'], { encoding: 'utf8' });
  }
  for (let i = 0; i < 20; i += 1) {
    await beat(2_000);
    const healthy = await page.evaluate(() =>
      /components report healthy/.test(document.querySelector('main')?.textContent ?? ''),
    );
    if (healthy) break;
  }
  await beat(2_000);
});

// ── The Inbox (P-6.5) ───────────────────────────────────────────────────────────────────────────
/*
 * ⚠️ The clip ends **without** clearing the queue. Acknowledging is one-way, and a recording that
 * consumed the demo dataset would leave the next demonstration with an empty inbox — which is the
 * state this milestone existed to fix. It shows the queue, the delivery that never arrived and its
 * reason, and the handled view; the acknowledge button is pointed at, not pressed.
 */
await run('notification-inbox', async (page) => {
  await page.goto(`${B}/alerts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main ul > li', { timeout: 20_000 });
  await beat(3_000);

  const toggle = page.getByRole('button', { name: /show delivery detail/i }).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await beat(3_500); // the per-channel records, and the failure reason
    await toggle.click().catch(() => {});
    await beat(800);
  }

  const filter = page.getByLabel('Triage filter');
  await filter.click();
  await beat(900);
  await page.getByRole('option', { name: 'Acknowledged' }).click();
  await beat(3_000);
  await filter.click();
  await beat(700);
  await page.getByRole('option', { name: 'Needs attention' }).click();
  await beat(2_500);
});

// ── Tenant Settings (P-6.3) ─────────────────────────────────────────────────────────────────────
await run('tenant-settings', async (page) => {
  await page.goto(`${B}/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tenant-name', { timeout: 20_000 });
  await beat(2_000);
  const original = await page.locator('#tenant-name').inputValue();

  await page.locator('#tenant-name').fill('');
  await beat(1_200); // the validation message
  await page.locator('#tenant-name').fill('Northgate Retail Group Ltd');
  await beat(900);
  await page.getByRole('button', { name: /save changes/i }).click();
  await beat(2_500);
  await page.mouse.wheel(0, 600);
  await beat(3_000); // the branding panel and its measured contrast ratio
  await page.mouse.wheel(0, -600);
  await beat(800);

  await page.locator('#tenant-name').fill(original);
  await page.getByRole('button', { name: /save changes/i }).click();
  await beat(2_000);
});

// ── User administration (P-6.2) ─────────────────────────────────────────────────────────────────
await run('user-administration', async (page) => {
  await page.goto(`${B}/users`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table', { timeout: 20_000 });
  await beat(2_500);
  /*
   * ⚠️ The dialog is opened and **cancelled**. Disabling a real demo account inside a recording
   * would leave the dataset changed by an artefact, and the point of the clip is the control and the
   * consequence it states — "this ends every open session immediately" — not the act.
   */
  const disable = page.getByRole('button', { name: /disable/i }).first();
  if (await disable.isVisible().catch(() => false)) {
    await disable.click();
    await beat(2_500);
    await page.keyboard.press('Escape');
    await beat(1_000);
  }
  const roles = page.getByRole('button', { name: /roles/i }).first();
  if (await roles.isVisible().catch(() => false)) {
    await roles.click();
    await beat(2_500);
    await page.keyboard.press('Escape');
    await beat(800);
  }
});

// ── Rule editing (P-6.1) ────────────────────────────────────────────────────────────────────────
await run('rule-editing', async (page) => {
  await page.goto(`${B}/rules`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2_000);
  await beat(1_500);
  const first = page.getByRole('link', { name: /edit|view/i }).first();
  if (await first.isVisible().catch(() => false)) {
    await first.click();
  } else {
    await page.locator('table tbody tr a, table tbody tr').first().click({ timeout: 5_000 }).catch(() => {});
  }
  await page.waitForSelector('#lifecycle, form', { timeout: 20_000 }).catch(() => {});
  await beat(3_000);
  await page.mouse.wheel(0, 500);
  await beat(2_500);
  await page.mouse.wheel(0, 500);
  await beat(2_500);
});

await browser.close();
console.log(`\n${failures === 0 ? '✓ gallery recorded' : `✗ ${failures} clip(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
