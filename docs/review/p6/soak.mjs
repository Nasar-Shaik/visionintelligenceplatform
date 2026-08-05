/**
 * P-6.5 / P-6.4 · **an inbox left open for forty minutes while the platform is taken apart.**
 *
 * ⚠️ Run from /private/tmp/pwrun:
 *   cp docs/review/p6/soak.mjs /private/tmp/pwrun/ && cd /private/tmp/pwrun && node soak.mjs
 *
 * Two tabs stay open for the whole run — the Inbox and System Health — and nobody touches them.
 * Underneath, every dependency is restarted one at a time, alerts keep arriving, and both screens
 * are sampled continuously. What is being asked is not "does it work" but "does it still work at
 * minute thirty-eight, after the database went away and came back".
 *
 * Measured, per dependency:
 *   · how long System Health takes to **notice** it has gone
 *   · what it says while it is gone — and whether it ever says something untrue
 *   · how long it takes to say it is back
 *
 * Measured, continuously:
 *   · duplicates — the same delivery appearing twice after a reconnect
 *   · ordering — newest first, still, after every disruption
 *   · the waiting count — against the server's own answer, not against itself
 *   · JS heap, so "leave it open all shift" is a measurement rather than a hope
 *
 * ⚠️ Nothing here is acknowledged. A forty-minute run that ate the demo queue would leave the next
 * demonstration with an empty inbox — the exact defect P-6.5 existed to fix.
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const MINUTES = Number(process.env.MINUTES ?? 40);

/* ⚠️ The browser is told to ignore the deployment's self-signed certificate; Node is not, and the
   server-side count below is a Node fetch. Without this it fails with `fetch failed` after forty
   minutes of otherwise green run — which is at least what it now *says*, rather than crashing. */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (started) => `${String(Math.floor((Date.now() - started) / 60000)).padStart(2, '0')}:${String(Math.floor(((Date.now() - started) % 60000) / 1000)).padStart(2, '0')}`;

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });

const errors = [];
let apiRequests = 0;
context.on('page', (p) => {
  p.on('pageerror', (e) => errors.push(`${new Date().toISOString()} ${e.message}`));
  p.on('request', (r) => {
    if (r.url().includes('/api/')) apiRequests += 1;
  });
});

/*
 * ⚠️ Copied in **this** run. The publisher lives at /tmp inside the notify container, and rebuilding
 * or recreating that container takes it with it — after which every alert this soak tries to raise
 * fails silently and the run reports "9 could not be published" as a footnote under checks that all
 * passed. A fixture the run depends on is copied by the run.
 */
execFileSync('docker', [
  'cp',
  new URL('./lifecycle-publish.mjs', import.meta.url).pathname,
  'vip-prod-notify-1:/tmp/lifecycle-publish.mjs',
]);

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

const started = Date.now();
console.log(`\nP-6.5 · ${MINUTES} minutes with both screens open, nobody touching them\n`);

/**
 * What the Inbox is showing right now, read from the DOM rather than from the cache.
 *
 * ⚠️ A failed read is **recorded, not fatal**. The first attempt at this run lost thirty-eight
 * minutes of measurement to a single transient `page.evaluate` rejection — a harness whose whole
 * point is to survive a long time under disruption should not be the thing that gives up first.
 */
async function readInbox() {
  try {
    return await readInboxNow();
  } catch (err) {
    readFailures.push(err instanceof Error ? err.message : String(err));
    return { entries: -1, titles: [], times: [], bell: '', heap: 0, crashed: false, unread: true };
  }
}

const readFailures = [];

async function readInboxNow() {
  return inbox.evaluate(() => {
    const rows = [...document.querySelectorAll('main > div > ul > li')];
    const titles = rows.map((li) => li.querySelector('p')?.textContent?.trim() ?? '');
    const times = rows.map((li) => li.querySelector('time')?.getAttribute('datetime') ?? '');
    const bell = document.querySelector('header a[href="/alerts"]')?.getAttribute('aria-label') ?? '';
    return {
      entries: rows.length,
      titles,
      times,
      bell,
      heap: performance.memory?.usedJSHeapSize ?? 0,
      crashed: document.body.textContent.includes('Something went wrong'),
    };
  });
}

/**
 * What System Health says right now, per component.
 *
 * ### ⚠️ The label comes from the `<p>`, and the first version of this read a dot
 *
 * `li.querySelector('p, h3, span')` returns the first match **in document order**, and for a healthy
 * row that is `StateDot`'s empty `<span>` — so the label came back as `''` and the row was dropped
 * entirely. States with an icon render an `<svg>` instead, so `Not built` and `Unavailable` parsed
 * fine and `Healthy` never did. The run reported that MinIO went away in ten seconds and **never came
 * back**, on a platform where it had recovered in well under a minute.
 *
 * ⚠️ A reading that can only see the states it is looking for will confirm whatever it expects.
 */
async function readHealth() {
  return health.evaluate(() => {
    const rows = [...document.querySelectorAll('main li')];
    const state = {};
    const WORDS = /^(Healthy|Degraded|Unavailable|Not configured|Not built|Forbidden|Unknown)$/i;
    for (const li of rows) {
      const label = li.querySelector('p')?.textContent?.trim() ?? '';
      const badge = [...li.querySelectorAll('span, div')]
        .map((e) => e.textContent?.trim() ?? '')
        .find((t) => WORDS.test(t));
      if (label && badge && !WORDS.test(label)) state[label] = badge;
    }
    return {
      state,
      summary: document.querySelector('main p')?.textContent?.trim() ?? '',
      stale: document.body.textContent.includes('could not be refreshed'),
      text: document.querySelector('main')?.textContent ?? '',
    };
  });
}

const samples = [];
const seenIds = new Map();
let publishFailures = 0;

/** Raise a real alert, so "new notifications arrive" is a fact rather than a wait. */
function raiseOne(n) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  try {
    execFileSync(
      'docker',
      ['exec', 'vip-prod-notify-1', 'node', '/tmp/lifecycle-publish.mjs', JSON.stringify({
        id, tenantId: TENANT, status: 'raised', severity: n % 3 === 0 ? 'critical' : 'high',
        title: `soak — alert ${n} raised at ${clock(started)}`, category: 'perception',
        source: { ruleId: 'rule_demo_retail_theft', ruleVersion: 1, ruleName: 'Suspected theft — high-value goods', candidateId: crypto.randomUUID(), dedupKey: `soak:${id}` },
        triggeredBy: { eventId: crypto.randomUUID(), eventType: 'behavior.theft.suspected', cameraId: 'cam_demo_retail_01', occurredAt: at },
        matchedCount: 1, version: 1, correlationId: `corr-soak-${id.slice(0, 8)}`,
        causationId: crypto.randomUUID(), history: [], assignments: [], notes: [], raisedAt: at, updatedAt: at,
      })],
      { encoding: 'utf8', timeout: 30_000 },
    );
    return id;
  } catch {
    publishFailures += 1; // ⚠️ counted, not swallowed: it happens while notify itself is restarting
    return null;
  }
}

/**
 * Take a dependency away, watch both screens, put it back, watch again.
 *
 * ⚠️ **Held down, not restarted.** A `docker restart` puts a container out for about three seconds,
 * behind a five-second cache, on a fifteen-second refresh — invisible by arithmetic, which is what
 * P-6.4 learned when six restart checks failed against a page that was right. Stopping it, waiting
 * for the screen to say so, and only then starting it again is the difference between measuring the
 * platform and measuring the sampling interval.
 */
async function takeAway(container, label, expect) {
  const from = clock(started);
  execFileSync('docker', ['stop', container], { stdio: 'ignore' });
  const downAt = Date.now();

  let noticed = null;
  let said = '';
  for (let i = 0; i < 60 && noticed === null; i += 1) {
    await sleep(1_000);
    const h = await readHealth();
    const hit = Object.entries(h.state).find(
      ([name, value]) => name.toLowerCase().includes(expect) && !/^healthy$/i.test(value),
    );
    if (hit) {
      noticed = Math.round((Date.now() - downAt) / 1000);
      said = `${hit[0]} → ${hit[1]}`;
    } else if (h.stale) {
      noticed = Math.round((Date.now() - downAt) / 1000);
      said = 'the whole report went stale (this dependency is the one that serves it)';
    }
  }

  execFileSync('docker', ['start', container], { stdio: 'ignore' });
  const upAt = Date.now();
  let recovered = null;
  for (let i = 0; i < 90 && recovered === null; i += 1) {
    await sleep(1_000);
    const h = await readHealth();
    const row = Object.entries(h.state).find(([name]) => name.toLowerCase().includes(expect));
    if (!h.stale && row && /^healthy$/i.test(row[1])) recovered = Math.round((Date.now() - upAt) / 1000);
  }

  console.log(
    `  ${from}  ${label.padEnd(10)} away → noticed in ${noticed === null ? 'NEVER' : `${noticed}s`}` +
      `${said ? ` (${said})` : ''}; back → healthy in ${recovered === null ? 'NEVER' : `${recovered}s`}`,
  );
  check(noticed !== null, `8·${label} — System Health noticed it was gone`, noticed === null ? 'never reported anything but healthy' : `${noticed}s`);
  check(recovered !== null, `8·${label} — and reported it healthy again`, recovered === null ? 'never recovered' : `${recovered}s`);
  return { label, noticed, recovered, said };
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────
const first = await readInbox();
console.log(`  00:00  baseline — ${first.entries} entries · ${first.bell} · heap ${(first.heap / 1048576).toFixed(1)} MB\n`);
samples.push({ at: 0, ...first });
for (const t of first.titles) seenIds.set(t, 1);

/*
 * ⚠️ The third column is the **label the page shows**, not the container's name, and twice they were
 * not the same word. The workflow service is called **Incidents** on screen — because that is what it
 * owns, and an operator should not have to know our service names — and MongoDB's row is **MongoDB**
 * rather than "database". Both expectations matched nothing, and both runs reported that System
 * Health *never noticed* a dependency it had in fact flagged within nine seconds.
 *
 * ⚠️ A check whose expectation names something that does not exist cannot **pass** — the mirror of a
 * check that cannot fail, and just as worthless. The assertion below runs before any of it, so a
 * mismatch is a red line at second zero instead of a `NEVER` twenty-three minutes in.
 */
const plan = [
  ['vip-prod-minio-1', 'MinIO', 'object'],
  ['vip-prod-nats-1', 'NATS', 'message'],
  ['vip-prod-evidence-1', 'evidence', 'evidence'],
  ['vip-prod-media-1', 'media', 'media'],
  ['vip-prod-workflow-1', 'workflow', 'incidents'],
  ['vip-prod-mongodb-1', 'MongoDB', 'mongodb'],
  ['vip-prod-gateway-1', 'gateway', 'gateway'],
];

/* ⚠️ Fail the run at boot if a label is not on the page, rather than discovering it as a NEVER. */
const labelsOnPage = Object.keys((await readHealth()).state).map((s) => s.toLowerCase());
for (const [, label, expect] of plan) {
  check(
    labelsOnPage.some((name) => name.includes(expect)),
    `0·${label} — "${expect}" matches a row the page actually shows`,
    labelsOnPage.join(', ').slice(0, 90),
  );
}

const transitions = [];
let raised = 0;
const deadline = started + MINUTES * 60_000;
const perSlot = Math.floor((MINUTES * 60_000) / plan.length);

for (const [container, label, expect] of plan) {
  const slotEnds = Date.now() + perSlot;

  raised += 1;
  raiseOne(raised);
  await sleep(20_000);

  transitions.push(await takeAway(container, label, expect));

  /* Quiet time: alerts keep arriving, both screens are sampled, nobody intervenes. */
  while (Date.now() < slotEnds && Date.now() < deadline) {
    await sleep(30_000);
    const s = await readInbox();
    if (s.entries >= 0) samples.push({ at: Math.round((Date.now() - started) / 1000), ...s });
    for (const t of s.titles) seenIds.set(t, (seenIds.get(t) ?? 0) + 1);
    if (Math.random() < 0.5) {
      raised += 1;
      raiseOne(raised);
    }
  }
}

// ── what forty minutes did to it ────────────────────────────────────────────────────────────────
console.log(`\n  ${clock(started)}  the screens have been open the whole time and nobody touched them\n`);

const last = await readInboxNow();
const finalHealth = await readHealth();
if (readFailures.length > 0) {
  console.log(`  · ⚠️ ${readFailures.length} sample read(s) failed and were skipped: ${readFailures[0]}`);
}

console.log(`  · entries: ${first.entries} → ${last.entries} · ${last.bell}`);
console.log(`  · alerts raised during the run: ${raised}${publishFailures ? ` (${publishFailures} could not be published while notify was down)` : ''}`);
console.log(`  · heap: ${(first.heap / 1048576).toFixed(1)} MB → ${(last.heap / 1048576).toFixed(1)} MB over ${samples.length} samples`);
console.log(`  · API requests from both tabs: ${apiRequests} (${(apiRequests / ((Date.now() - started) / 60000)).toFixed(1)}/min)`);

check(!last.crashed, '5a · ⚠️ the Inbox is still rendering after every dependency was taken away');
check(errors.length === 0, '5b · no page errors in the whole run', errors.slice(0, 2).join(' | '));

/* ⚠️ Duplicates: a reconnect must not re-add what is already on screen. */
const dupes = last.titles.filter((t, i) => t && last.titles.indexOf(t) !== i);
check(dupes.length === 0, '5c · ⚠️ no delivery appears twice after all the reconnecting', dupes.slice(0, 2).join(' | '));

/* ⚠️ Ordering: newest first, still. */
const times = last.times.filter(Boolean);
const ordered = times.every((t, i) => i === 0 || Date.parse(times[i - 1]) >= Date.parse(t));
/*
 * ⚠️ This is what the **browser** shows, and the console sorts entries itself after grouping them —
 * so a build that served the queue oldest-first still rendered newest-first and this check stayed
 * green through it (measured). The server's own order is asserted in `inbox.mjs` (1g); what is
 * claimed here is narrower: nothing about forty minutes of restarts disturbs the rendered order.
 */
check(ordered, '5d · ⚠️ still newest-first on screen after every disruption', `${times.length} timestamps`);

/* ⚠️ The count against the **server's** answer, not against its own earlier self. */
/*
 * ⚠️ Asked with a token of its own, and never allowed to take the run down with it. Asking from
 * inside the page returned 401, `body.data` was undefined, and the uncaught TypeError ended the
 * process **after** 5d and before 5e, 5f, 5g, 8h and 8i — a crash where a verdict should be, and
 * five checks that silently did not run.
 */
const serverSays = await (async () => {
  try {
    const auth = await fetch(`${B}/api/identity/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json());
    const body = await fetch(`${B}/api/notify/notifications?acknowledged=false&limit=200`, {
      headers: { accept: 'application/json', authorization: `Bearer ${auth.data.accessToken}` },
    }).then((r) => r.json());
    return new Set(body.data.items.map((n) => n.incidentId)).size;
  } catch (err) {
    console.log(`  · ⚠️ could not ask the server for the count: ${err.message}`);
    return -1;
  }
})();
const badge = Number((last.bell.match(/(\d+)/) ?? [])[1] ?? -1);
console.log(`  · the bell says ${badge}, the server says ${serverSays} incidents waiting`);
check(
  badge === serverSays || (last.bell.includes('or more') && badge <= serverSays),
  '5e · ⚠️ the waiting count still agrees with the server after forty minutes',
  `${badge} vs ${serverSays}`,
);

const grew = (last.heap - first.heap) / 1048576;
check(
  first.heap === 0 || grew < 60,
  '5f · memory did not run away',
  `${grew >= 0 ? '+' : ''}${grew.toFixed(1)} MB`,
);

check(
  publishFailures === 0,
  '5g · ⚠️ every alert this run tried to raise was accepted — a run that raised none proves nothing',
  `${raised} raised, ${publishFailures} refused`,
);
check(
  raised > 0 && last.titles.some((t) => t.startsWith('soak — alert')),
  '5h · ⚠️ alerts raised during the run are on the screen — the live path survived the restarts',
);

check(!finalHealth.stale, '8h · System Health is current again at the end');
check(
  /healthy/i.test(finalHealth.summary) || Object.values(finalHealth.state).some((v) => /healthy/i.test(v)),
  '8i · and reports the platform healthy',
  finalHealth.summary.slice(0, 80),
);

console.log('\n  transitions:');
for (const t of transitions) {
  console.log(`    ${t.label.padEnd(10)} noticed ${String(t.noticed ?? '—').padStart(3)}s · recovered ${String(t.recovered ?? '—').padStart(3)}s`);
}

await browser.close();
console.log(`\n${failures === 0 ? '✓ soak: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
