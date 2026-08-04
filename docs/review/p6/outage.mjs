/**
 * P-6.5 freeze · **what each screen says while it cannot be reached, and whether it comes back.**
 *
 * ⚠️ Run from /private/tmp/pwrun:
 *   cp docs/review/p6/outage.mjs /private/tmp/pwrun/ && cd /private/tmp/pwrun && node outage.mjs
 *
 * Two questions, one per screen, asked of three dependencies taken away one at a time:
 *
 * 1. **System Health** — how long until it notices, what word does it use, how long until it clears.
 *    The soak measured four of the seven and mis-named three: the workflow service's row is called
 *    **Incidents**, MongoDB's is **MongoDB** rather than "database", and an expectation that names a
 *    row the page does not have cannot pass — the mirror of a check that cannot fail.
 *
 * 2. ⚠️ **The Inbox** — the question P-6.4 asked of System Health and nobody asked here. When the
 *    gateway went away, the report was replaced by "Couldn't load · Request failed (502)": every row
 *    gone, during the exact outage the page exists to report. The queue has the same shape, the same
 *    `QueryBoundary`, and had never been watched through an outage. What it says here is measured,
 *    printed, and judged — not assumed from reading the component.
 *
 * ⚠️ Nothing is acknowledged and no data is written. Dependencies are stopped and started; the demo
 * dataset is untouched.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const errors = [];
context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));

const inbox = await context.newPage();
await inbox.goto(`${B}/login`, { waitUntil: 'domcontentloaded' });
await inbox.getByLabel(/tenant/i).fill(TENANT);
await inbox.getByLabel(/email/i).fill(ADMIN.email);
await inbox.getByLabel(/password/i).fill(ADMIN.password);
await inbox.getByRole('button', { name: /sign in/i }).click();
await inbox.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
await inbox.goto(`${B}/alerts?triage=all`, { waitUntil: 'domcontentloaded' });
await inbox.waitForSelector('main ul > li', { timeout: 20_000 });

const health = await context.newPage();
await health.goto(`${B}/system`, { waitUntil: 'domcontentloaded' });
await health.waitForSelector('main li', { timeout: 20_000 });

const WORDS = /^(Healthy|Degraded|Unavailable|Not configured|Not built|Forbidden|Unknown)$/i;

const readHealth = () =>
  health.evaluate((words) => {
    const re = new RegExp(words, 'i');
    const state = {};
    for (const li of document.querySelectorAll('main li')) {
      const label = li.querySelector('p')?.textContent?.trim() ?? '';
      const badge = [...li.querySelectorAll('span, div')]
        .map((e) => e.textContent?.trim() ?? '')
        .find((t) => re.test(t));
      if (label && badge && !re.test(label)) state[label] = badge;
    }
    return {
      state,
      stale: document.body.textContent.includes('could not be refreshed'),
      text: (document.querySelector('main')?.textContent ?? '').slice(0, 400),
    };
  }, WORDS.source);

const readInbox = () =>
  inbox.evaluate(() => {
    const main = document.querySelector('main');
    const rows = main?.querySelectorAll(':scope > div > ul > li') ?? [];
    const text = main?.textContent ?? '';
    return {
      entries: rows.length,
      /* ⚠️ The exact claim the screen is making about the world, in its own words. */
      says: /Nothing is waiting/.test(text)
        ? 'Nothing is waiting'
        : /No alerts/.test(text)
          ? 'No alerts'
          : /Couldn’t load|Couldn't load|Request failed|went wrong/.test(text)
            ? (text.match(/(Couldn.t load[^·]*·?\s*[^\n]{0,60}|Request failed[^\n]{0,40}|Something went wrong[^\n]{0,40})/) ?? [''])[0].trim()
            : rows.length > 0
              ? 'the queue'
              : 'something else',
      /* ⚠️ Does it *say* the reading is old? Keeping the queue silently is the worse failure. */
      stale: /could not be refreshed/.test(text),
    };
  });

const baseline = await readInbox();
console.log(`\nP-6.5 freeze · what each screen says during an outage\n`);
console.log(`  baseline — inbox: ${baseline.entries} entries (${baseline.says})\n`);

const plan = [
  ['vip-prod-workflow-1', 'workflow', 'incidents'],
  ['vip-prod-mongodb-1', 'MongoDB', 'mongodb'],
  ['vip-prod-gateway-1', 'gateway', 'gateway'],
];

/* ⚠️ Fail at second zero if a label does not exist, rather than as a NEVER twenty minutes in. */
const labels = Object.keys((await readHealth()).state).map((s) => s.toLowerCase());
for (const [, name, expect] of plan) {
  check(
    labels.some((l) => l.includes(expect)),
    `0·${name} — "${expect}" names a row the page actually shows`,
    labels.join(', ').slice(0, 80),
  );
}

const results = [];
for (const [container, name, expect] of plan) {
  console.log(`\n${name} — taken away`);
  execFileSync('docker', ['stop', container], { stdio: 'ignore' });
  const downAt = Date.now();

  let noticed = null;
  let said = '';
  let inboxSaid = new Set();
  for (let i = 0; i < 45; i += 1) {
    await sleep(2_000);
    const h = await readHealth().catch(() => null);
    const q = await readInbox().catch(() => null);
    if (q) inboxSaid.add(`${q.says} (${q.entries})${q.stale ? ' [marked stale]' : ''}`);
    if (h && noticed === null) {
      const row = Object.entries(h.state).find(([l]) => l.toLowerCase().includes(expect));
      if (row && !/^healthy$/i.test(row[1])) {
        noticed = Math.round((Date.now() - downAt) / 1000);
        said = `${row[0]} → ${row[1]}`;
      } else if (h.stale) {
        noticed = Math.round((Date.now() - downAt) / 1000);
        said = 'the whole report is marked stale (this dependency serves it)';
      }
    }
    if (noticed !== null && i > 6) break;
  }
  console.log(`  · System Health: ${noticed === null ? 'NEVER noticed' : `noticed in ${noticed}s — ${said}`}`);
  console.log(`  · the Inbox said: ${[...inboxSaid].join(' → ')}`);

  execFileSync('docker', ['start', container], { stdio: 'ignore' });
  const upAt = Date.now();
  let recovered = null;
  let inboxBack = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(2_000);
    const h = await readHealth().catch(() => null);
    const q = await readInbox().catch(() => null);
    if (h && recovered === null && !h.stale) {
      const row = Object.entries(h.state).find(([l]) => l.toLowerCase().includes(expect));
      if (row && /^healthy$/i.test(row[1])) recovered = Math.round((Date.now() - upAt) / 1000);
    }
    if (q && inboxBack === null && q.entries > 0) inboxBack = Math.round((Date.now() - upAt) / 1000);
    if (recovered !== null && inboxBack !== null) break;
  }
  console.log(
    `  · back: System Health healthy in ${recovered === null ? 'NEVER' : `${recovered}s`} · the queue repopulated in ${inboxBack === null ? 'NEVER' : `${inboxBack}s`} — ⚠️ without a refresh`,
  );

  check(noticed !== null, `8·${name} — System Health noticed`, noticed === null ? 'never' : `${noticed}s`);
  check(recovered !== null, `8·${name} — and cleared`, recovered === null ? 'never' : `${recovered}s`);
  check(
    inboxBack !== null,
    `5·${name} — ⚠️ the queue came back on its own, no refresh`,
    inboxBack === null ? 'never repopulated' : `${inboxBack}s`,
  );
  /*
   * ⚠️ The claim that must never be made. An empty queue means "nothing needs you"; an unreachable
   * one means "we cannot tell". If an outage renders as "Nothing is waiting", an operator is being
   * told the one thing that would make them stop looking.
   */
  check(
    ![...inboxSaid].some((s) => s.startsWith('Nothing is waiting') || s.startsWith('No alerts')),
    `5·${name} — ⚠️ the Inbox never said "Nothing is waiting" while it could not be reached`,
    [...inboxSaid].join(' | '),
  );
  /*
   * ⚠️ Keeping the queue is only half of it. A retained list that does **not** say it is old is the
   * worse failure of the two — the operator reads it as current and has no reason to doubt it. This
   * applies to the gateway, which is the dependency that serves the queue; the others do not stop
   * the page refreshing, so there is nothing to mark.
   */
  if (expect === 'gateway') {
    check(
      [...inboxSaid].some((s) => s.includes('[marked stale]')),
      `5·${name} — ⚠️ and it said so: the retained queue is labelled, not passed off as current`,
      [...inboxSaid].join(' | '),
    );
  }
  results.push({ name, noticed, recovered, inboxBack, inboxSaid: [...inboxSaid] });
  await sleep(8_000);
}

check(errors.length === 0, 'no page errors throughout', errors.slice(0, 2).join(' | '));

console.log('\n  summary:');
for (const r of results) {
  console.log(
    `    ${r.name.padEnd(9)} noticed ${String(r.noticed ?? '—').padStart(3)}s · cleared ${String(r.recovered ?? '—').padStart(3)}s · queue back ${String(r.inboxBack ?? '—').padStart(3)}s`,
  );
}

await browser.close();
console.log(`\n${failures === 0 ? '✓ outage: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
