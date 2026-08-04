/**
 * P-6.5 freeze · **production screenshots for every state the review names.**
 *
 * ⚠️ Run from /private/tmp/pwrun, with the soak finished (it restarts containers):
 *   cp docs/review/p6/p65-freeze-screens.mjs /private/tmp/pwrun/ && cd /private/tmp/pwrun && node p65-freeze-screens.mjs
 *
 *   healthy system · degraded system · failed webhook · unread queue · acknowledgement ·
 *   the loser's message · the bounded queue · recovery after a restart
 *
 * ⚠️ Every one is the running production build against real data. The degraded and recovery shots
 * take a real dependency away and put it back — a screenshot of a green page proves only that a green
 * page exists.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const OUT = process.env.OUT ?? '.';
const TENANT = 'tnt_demo_retail';
const ALICE = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const BOB = { email: 'day.operator@northgate.demo', password: 'Vip-Demo-2026!' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const shots = [];

async function signIn(creds, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  const page = await ctx.newPage();
  await page.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/tenant/i).fill(TENANT);
  await page.getByLabel(/email/i).fill(creds.email);
  await page.getByLabel(/password/i).fill(creds.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  return { ctx, page };
}

const shoot = async (page, name, fullPage = true) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  shots.push(name);
  console.log(`  · ${name}`);
};

console.log('\nP-6.5 freeze · production screenshots\n');

const { page } = await signIn(ALICE);

// ── the inbox ───────────────────────────────────────────────────────────────────────────────────
await page.goto(`${B}/alerts`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main ul > li', { timeout: 20_000 });
await sleep(1_200);
await shoot(page, 'freeze-inbox-01-unread-queue');

/* The failure, expanded — the reason in an operator's words, which is the 0.5 exit criterion. */
const failedEntry = page
  .locator('main > div > ul > li')
  .filter({ hasText: /delivery|failed/i })
  .first();
const toggle = failedEntry.getByRole('button', { name: /show delivery detail/i });
if (await toggle.isVisible().catch(() => false)) {
  await toggle.click();
  await sleep(900);
  await shoot(page, 'freeze-inbox-02-failed-webhook-reason');
  await toggle.click().catch(() => {});
}

/* Acknowledgement, caught while the message is still on screen. */
const ackable = page
  .locator('main > div > ul > li')
  .filter({ has: page.getByRole('button', { name: 'Acknowledge' }) })
  .first();
const title = (await ackable.locator('p').first().textContent())?.trim();

const bob = await signIn(BOB);
await bob.page.goto(`${B}/alerts`, { waitUntil: 'domcontentloaded' });
await bob.page.waitForSelector('main ul > li', { timeout: 20_000 });
const bobRow = bob.page
  .locator('main > div > ul > li')
  .filter({ hasText: title })
  .filter({ has: bob.page.getByRole('button', { name: 'Acknowledge' }) })
  .first();

/* ⚠️ Both press at once, so the pair of screenshots is one real race rather than two staged states. */
await Promise.all([
  ackable.getByRole('button', { name: 'Acknowledge' }).click().catch(() => {}),
  bobRow.getByRole('button', { name: 'Acknowledge' }).click().catch(() => {}),
]);
await Promise.all([
  page.locator('[data-sonner-toast]').first().waitFor({ timeout: 8_000 }).catch(() => {}),
  bob.page.locator('[data-sonner-toast]').first().waitFor({ timeout: 8_000 }).catch(() => {}),
]);
const aliceToast = (await page.locator('[data-sonner-toast]').allTextContents()).join(' ');
const bobToast = (await bob.page.locator('[data-sonner-toast]').allTextContents()).join(' ');
/*
 * ⚠️ Both success wordings. An entry that reached one channel says "Alert acknowledged"; one that
 * reached several says "Acknowledged 2 deliveries for this incident" — and matching only the first
 * labelled the two screenshots the wrong way round, filing the loser's message as the winner's.
 */
const WON = /^(Alert acknowledged|Acknowledged \d+ deliver)/;
const winner = WON.test(aliceToast) ? page : bob.page;
const loser = winner === page ? bob.page : page;
await shoot(winner, 'freeze-inbox-03-acknowledged', false);
await shoot(loser, 'freeze-inbox-04-someone-else-took-it', false);
console.log(`    winner: "${(winner === page ? aliceToast : bobToast).slice(0, 60)}"`);
console.log(`    loser:  "${(loser === page ? aliceToast : bobToast).slice(0, 70)}"`);
await bob.ctx.close();

await page.goto(`${B}/alerts?triage=acknowledged`, { waitUntil: 'domcontentloaded' });
await sleep(1_800);
await shoot(page, 'freeze-inbox-05-handled');

// ── system health ───────────────────────────────────────────────────────────────────────────────
await page.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main li', { timeout: 20_000 });
await sleep(2_000);
await shoot(page, 'freeze-system-01-healthy');

/*
 * ⚠️ Degraded, then recovered — **held down long enough to be seen**, not restarted. A container that
 * is out for three seconds behind a five-second cache on a fifteen-second refresh is invisible by
 * arithmetic (P-6.4), and a screenshot of it would be a screenshot of nothing.
 */
console.log('  · taking object storage away…');
execFileSync('docker', ['stop', 'vip-prod-minio-1'], { stdio: 'ignore' });
let sawDegraded = false;
for (let i = 0; i < 40 && !sawDegraded; i += 1) {
  await sleep(2_000);
  sawDegraded = /Degraded|Unavailable/.test((await page.locator('main').textContent()) ?? '');
}
await sleep(1_500);
await shoot(page, 'freeze-system-02-degraded');
console.log(`    degraded on screen: ${sawDegraded}`);

console.log('  · putting it back…');
execFileSync('docker', ['start', 'vip-prod-minio-1'], { stdio: 'ignore' });
let recovered = false;
const from = Date.now();
for (let i = 0; i < 60 && !recovered; i += 1) {
  await sleep(2_000);
  const text = (await page.locator('main').textContent()) ?? '';
  recovered = !/Degraded|Unavailable/.test(text);
}
await sleep(1_500);
await shoot(page, 'freeze-system-03-recovered-after-restart');
console.log(`    recovered on screen after ${Math.round((Date.now() - from) / 1000)}s: ${recovered}`);

await browser.close();
console.log(`\n✓ ${shots.length} screenshots written to ${OUT}\n`);
process.exit(recovered && sawDegraded ? 0 : 1);
