/**
 * P-6.5 · **every delivery state, produced** — against the production deployment.
 *
 *   node docs/review/p6/notification-lifecycle.mjs
 *
 * ### ⚠️ Produced, not inferred
 *
 * Reading a state machine and asserting it works is how a status nobody has ever seen ends up on a
 * screen. So every state here is made to happen by the product: real channels created through the
 * API, a real `incident.raised` published onto the backbone, the real Alert Engine fanning out over
 * real transports, and the state read back through the gateway exactly as the console reads it.
 *
 * The four transports are a throwaway sink container (`vip-lc-sink`) on the production network:
 *   `/ok`      → 204, a delivery that arrives            → **delivered**
 *   `/refuse`  → 503, a delivery the far end rejects     → **failed**, with the status in the reason
 *   `/hang`    → never answers                           → **sent** while it waits, then **failed**
 *   in-app     → the log itself is the inbox             → **delivered**
 *
 * ### ⚠️ Which states exist at all
 *
 * `NotificationStatus` is `pending · sent · delivered · failed · acked`. There is **no `expired`, no
 * `retried` and no `dismissed`** — those are asked about, and the honest answer is that the platform
 * has no such transitions. This script asserts the enum has exactly the five, so the day one is
 * added, this fails and somebody has to come and say what it means.
 *
 * ### Cleanup
 *
 * Channels and deliveries created here are removed at the end and the counts asserted back to where
 * they started. ⚠️ An enabled channel left behind would silently join every future fan-out.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const SINK = 'http://vip-lc-sink:8080';
const MARK = 'lifecycle-probe';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, tenant } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${B}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/*
 * ⚠️ Real UUIDs. The first version of this script built them out of words ("cand", "evt"), which are
 * not hexadecimal — the Alert Engine parsed the incident, found an invalid UUID and **dead-lettered
 * it**, exactly as it is supposed to. Fail-closed input validation working correctly looks identical
 * to a broken pipeline from the outside, which is worth remembering the next time nothing arrives.
 */
const uuid = () => crypto.randomUUID();

function incidentFor({ id, title, severity = 'high' }) {
  const at = new Date().toISOString();
  return {
    id,
    tenantId: TENANT,
    status: 'raised',
    severity,
    title,
    category: 'perception',
    source: {
      ruleId: 'rule_demo_retail_theft',
      ruleVersion: 1,
      ruleName: 'Suspected theft — high-value goods',
      candidateId: uuid(),
      dedupKey: `${MARK}:${id}`,
    },
    triggeredBy: {
      eventId: uuid(),
      eventType: 'behavior.theft.suspected',
      cameraId: 'cam_demo_retail_01',
      occurredAt: at,
    },
    matchedCount: 1,
    version: 1,
    correlationId: `corr-${MARK}-${id.slice(0, 8)}`,
    causationId: uuid(),
    history: [],
    assignments: [],
    notes: [],
    raisedAt: at,
    updatedAt: at,
  };
}

/** Publish one incident, or a whole burst in a single connection (the burst goes over stdin). */
function publish(payload) {
  const json = JSON.stringify(payload);
  const out = Array.isArray(payload)
    ? execFileSync('docker', ['exec', '-i', 'vip-prod-notify-1', 'node', '/tmp/lifecycle-publish.mjs'], {
        encoding: 'utf8',
        input: json,
        maxBuffer: 16 * 1024 * 1024,
      })
    : execFileSync(
        'docker',
        ['exec', 'vip-prod-notify-1', 'node', '/tmp/lifecycle-publish.mjs', json],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      );
  return JSON.parse(out.trim().split('\n').pop());
}

const raise = (spec) => {
  const incident = incidentFor(spec);
  return { incident, ack: publish(incident) };
};

console.log('\nP-6.5 · every delivery state, produced\n');

// ── 0 · the states that exist ───────────────────────────────────────────────────────────────────
console.log('0 · which states exist at all');

const { NotificationStatus } = await import('../../../packages/contracts/dist/index.js');
const states = NotificationStatus.options;
console.log(`  · NotificationStatus = ${states.join(' · ')}`);
check(
  states.length === 5 && ['pending', 'sent', 'delivered', 'failed', 'acked'].every((s) => states.includes(s)),
  '0a · five states, and exactly five',
  states.join(','),
);
for (const absent of ['expired', 'retried', 'dismissed']) {
  check(
    !states.includes(absent),
    `0b · ⚠️ there is no '${absent}' state — reporting one would be inventing a transition the platform does not make`,
  );
}

// ── 1 · setup ───────────────────────────────────────────────────────────────────────────────────
console.log('\n1 · four real channels, through the API');

const auth = await api('POST', '/identity/auth/login', { body: ADMIN, tenant: TENANT });
const tok = auth.json?.data?.accessToken;
if (!tok) {
  console.error('cannot sign in', auth.status, JSON.stringify(auth.json));
  process.exit(1);
}

execFileSync('docker', [
  'cp',
  new URL('./lifecycle-publish.mjs', import.meta.url).pathname,
  'vip-prod-notify-1:/tmp/lifecycle-publish.mjs',
]);

const notificationsBefore = (await api('GET', '/notify/notifications?limit=1', { token: tok })).status;
const channelsBefore = (await api('GET', '/notify/notification-channels', { token: tok })).json.data.length;

/*
 * ⚠️ The sink is started **here**, not assumed. An earlier run tore it down on the way out and the
 * next run then recorded four connection failures as if they were the transports' verdicts — every
 * webhook "failed", which is what a broken fixture and a working failure path look like from the
 * outside. A verification that depends on a fixture has to own the fixture's lifetime.
 */
try {
  execFileSync('docker', ['rm', '-f', 'vip-lc-sink'], { stdio: 'ignore' });
} catch {}
execFileSync('docker', [
  'run', '-d', '--name', 'vip-lc-sink', '--network', 'vip-prod_default',
  '--entrypoint', 'node', 'vip/notify:local', '-e',
  `const http=require("http");
   http.createServer((req,res)=>{
     if(req.url.startsWith("/ok")){res.writeHead(204);res.end();return;}
     if(req.url.startsWith("/refuse")){res.writeHead(503);res.end("service unavailable");return;}
     /* /hang: accept and never answer — the transport's own timeout decides */
   }).listen(8080);`,
], { stdio: 'ignore' });
await sleep(2_000);

const made = [];
async function channel(name, type, config) {
  const res = await api('POST', '/notify/notification-channels', {
    token: tok,
    body: { name: `${MARK} ${name}`, type, config, enabled: true },
  });
  if (res.status !== 201 && res.status !== 200) {
    console.error(`could not create channel ${name}`, res.status, JSON.stringify(res.json));
    process.exit(1);
  }
  made.push(res.json.data.id);
  return res.json.data;
}

/** Channels belonging to the tenant that this script switched off, to be switched back on. */
let restoreChannels = [];

/** ⚠️ Cleanup runs even when a check throws — a stray enabled channel joins every future fan-out. */
async function cleanup() {
  for (const id of made) await api('DELETE', `/notify/notification-channels/${id}`, { token: tok });
  /* ⚠️ And a tenant channel left disabled means their alerts stop arriving, silently. */
  for (const c of restoreChannels) {
    await api('PATCH', `/notify/notification-channels/${c.id}`, { token: tok, body: { enabled: true } });
  }
  const enabled = (await api('GET', '/notify/notification-channels', { token: tok })).json.data;
  check(
    restoreChannels.every((c) => enabled.find((e) => e.id === c.id)?.enabled === true),
    '⚠️ Z0 · every channel this script switched off is on again',
    `${enabled.filter((e) => e.enabled).length} enabled`,
  );
  const left = (await api('GET', '/notify/notification-channels', { token: tok })).json.data;
  const strays = left.filter((c) => c.name.startsWith(MARK));
  check(strays.length === 0, 'Z1 · every probe channel removed', `${left.length} channels remain`);
  check(
    left.length === channelsBefore,
    '⚠️ Z2 · the tenant is back to the channels it had',
    `${channelsBefore} → ${left.length}`,
  );
  try {
    execFileSync('docker', ['rm', '-f', 'vip-lc-sink'], { stdio: 'ignore' });
  } catch {}
}

const okCh = await channel('ok', 'webhook', { url: `${SINK}/ok` });
const refuseCh = await channel('refuse', 'webhook', { url: `${SINK}/refuse` });
const hangCh = await channel('hang', 'webhook', { url: `${SINK}/hang` });
const appCh = await channel('in-app', 'in-app', {});
console.log(`  · created ${made.length} channels (${notificationsBefore === 200 ? 'log reachable' : 'log unreachable'})`);
check(made.length === 4, '1a · four channels created through the product API');

try {
  // ── 2 · sent · delivered · failed ─────────────────────────────────────────────────────────────
  console.log('\n2 · raising a real incident and watching the states happen');

  const id = uuid();
  const { ack } = raise({ id, title: `${MARK} — every transport at once` });
  check(ack.seq > 0 && !ack.duplicate, '2a · `incident.raised` accepted by the backbone', `seq ${ack.seq}`);

  /*
   * ⚠️ Sampled *during* the fan-out. `sent` is the state a delivery rests in while the far end is
   * deciding, and the hanging transport holds it there for the transport's five-second timeout —
   * which is the only reason this state can be caught at all rather than reasoned about.
   */
  const seen = new Map();
  const deadline = Date.now() + 22_000;
  while (Date.now() < deadline) {
    const res = await api('GET', `/notify/notifications?incidentId=${id}&limit=50`, { token: tok });
    for (const n of res.json?.data?.items ?? []) {
      const key = n.channelId;
      const trail = seen.get(key) ?? [];
      if (trail[trail.length - 1] !== n.status) trail.push(n.status);
      seen.set(key, trail);
    }
    const rows = res.json?.data?.items ?? [];
    if (rows.length === 4 && rows.every((n) => n.status === 'delivered' || n.status === 'failed')) break;
    await sleep(400);
  }

  const final = (await api('GET', `/notify/notifications?incidentId=${id}&limit=50`, { token: tok })).json
    .data.items;
  const byChannel = Object.fromEntries(final.map((n) => [n.channelId, n]));
  for (const [ch, trail] of seen) {
    const label = final.find((n) => n.channelId === ch)?.channelType ?? ch;
    console.log(`  · ${String(label).padEnd(8)} ${ch.slice(0, 14).padEnd(16)} ${trail.join(' → ')}`);
  }

  /*
   * ⚠️ At least four: the tenant's **own** channels are enabled and fan out to this incident too,
   * which is the alert engine behaving correctly. The assertion is about the four probes, not about
   * the tenant having exactly four channels.
   */
  check(
    made.every((id) => byChannel[id] !== undefined),
    '2b · every probe channel produced a delivery record',
    `${final.length} records across ${new Set(final.map((n) => n.channelId)).size} channels`,
  );
  check(
    byChannel[appCh.id]?.status === 'delivered',
    '2c · **delivered** — the in-app inbox is the delivery',
    byChannel[appCh.id]?.status,
  );
  check(
    byChannel[okCh.id]?.status === 'delivered',
    '2d · **delivered** — a webhook the far end accepted (204)',
    byChannel[okCh.id]?.status,
  );
  check(
    byChannel[refuseCh.id]?.status === 'failed',
    '2e · **failed** — a webhook the far end rejected',
    byChannel[refuseCh.id]?.lastError,
  );
  check(
    /503/.test(byChannel[refuseCh.id]?.lastError ?? ''),
    '2f · ⚠️ and the reason carries the far end’s status, not "delivery failed"',
    byChannel[refuseCh.id]?.lastError,
  );
  check(
    byChannel[hangCh.id]?.status === 'failed',
    '2g · **failed** — a webhook that never answered, after the transport timeout',
    byChannel[hangCh.id]?.lastError,
  );
  const sawSent = [...seen.values()].some((trail) => trail.includes('sent'));
  check(
    sawSent,
    '2h · ⚠️ **sent** observed while a transport was still deciding — the state a delivery rests in',
    [...seen.values()].map((t) => t.join('→')).join(' | '),
  );

  // ── 3 · acked ─────────────────────────────────────────────────────────────────────────────────
  console.log('\n3 · acked');

  const target = byChannel[okCh.id];
  const acked = await api('POST', `/notify/notifications/${target.id}/ack`, { token: tok, body: {} });
  check(acked.status === 200 && acked.json.data.status === 'acked', '3a · **acked** — a person took it');
  check(
    acked.json.data.ackedBy === ADMIN.email,
    '3b · attributed to the authenticated principal',
    acked.json.data.ackedBy,
  );
  const refused = await api('POST', `/notify/notifications/${byChannel[refuseCh.id].id}/ack`, {
    token: tok,
    body: {},
  });
  check(
    refused.status === 409,
    '3c · ⚠️ a failed delivery cannot be acknowledged — nobody received it',
    `HTTP ${refused.status}`,
  );

  // ── 4 · retries ───────────────────────────────────────────────────────────────────────────────
  console.log('\n4 · retries — asked about, and measured rather than assumed');

  const attempts = final.map((n) => n.attempts);
  console.log(`  · attempts on four real deliveries, two of them failures: ${attempts.join(', ')}`);
  check(
    final.every((n) => n.attempts === 1),
    '4a · ⚠️ every delivery was attempted exactly **once** — there is no retry in the platform',
    `attempts: ${attempts.join(',')}`,
  );
  /*
   * ⚠️ And a failure is final. The incident is redelivered on the backbone, but the fan-out's
   * idempotency guard skips a channel that already has a record — so a webhook that was down for a
   * minute never receives that alert, and nothing anywhere will try again. That is a real
   * operational limitation, and it is worth stating in the words a customer would use.
   */
  const republish = raise({ id, title: `${MARK} — redelivery` });
  await sleep(2_500);
  const afterRedelivery = (
    await api('GET', `/notify/notifications?incidentId=${id}&limit=50`, { token: tok })
  ).json.data.items;
  check(
    afterRedelivery.length === final.length && afterRedelivery.every((n) => n.attempts === 1),
    '4b · ⚠️ a redelivered incident does not re-attempt a failed channel — a failure is permanent',
    `${afterRedelivery.length} records (was ${final.length}), attempts ${afterRedelivery.map((n) => n.attempts).join(',')}`,
  );
  void republish;

  // ── 5 · pending ───────────────────────────────────────────────────────────────────────────────
  console.log('\n5 · pending');

  /*
   * ⚠️ `pending` is written for **every single delivery** — it is the state the record is inserted
   * in, before the transport is handed anything. It is also the state the system spends the least
   * time in: one database round trip separates it from `sent`, so it is never seen at rest on a
   * healthy system, and reasoning about it instead of producing it is exactly what this section
   * refuses to do.
   *
   * So the service is **frozen mid-fan-out** (`docker pause`) and the delivery log is read straight
   * out of MongoDB, which is a different container and answers perfectly well while notify is
   * stopped. Freezing rather than killing is deliberate: it produces the state without damaging the
   * deployment every other check in this pass depends on, and the process carries on afterwards, so
   * the same rows can be watched completing.
   */
  const mongoRead = (js) =>
    JSON.parse(
      execFileSync(
        'docker',
        [
          'exec', 'vip-prod-mongodb-1', 'mongosh', '--quiet',
          '-u', env.MONGO_USER, '-p', env.MONGO_PASSWORD,
          '--authenticationDatabase', 'admin', 'vip', '--eval', `print(JSON.stringify(${js}))`,
        ],
        { encoding: 'utf8' },
      ).trim().split('\n').pop(),
    );

  /*
   * ⚠️ Sampling cannot catch this state, and it is worth saying why rather than trying harder: eight
   * `docker pause` snapshots caught the fan-out four times and never once inside the window, because
   * a fan-out over webhooks spends seconds waiting on transports and about a millisecond per channel
   * between the insert and the hand-off. Chasing it with a stopwatch is not a method.
   *
   * So the odds are changed instead of the luck. Every channel is switched off for the duration
   * (they include webhooks that take five seconds to fail, which drown everything), a dozen
   * **in-app** channels are stood up so the fan-out is nothing but database writes, three hundred
   * incidents are raised in a single publish so the engine is continuously mid-fan-out for over a
   * second, and *then* the process is frozen. Roughly a third of that work is the window between a
   * delivery's insert and its hand-off, so a freeze lands inside one.
   *
   * ⚠️ Frozen, not killed. `docker pause` produces the state without damaging the deployment the
   * rest of this pass depends on, and it leaves the process able to carry on — which is what makes
   * the follow-up check possible at all.
   */
  const attemptsAllowed = Number(process.env.FREEZES ?? 25);
  let caught = null;

  /*
   * ⚠️ **Every** enabled channel goes quiet, including this script's own webhook probes. The first
   * attempt left them on: each burst incident then waited five seconds on the hanging webhook, four
   * stops in a row caught the identical 21/2/1 tally, and the run looked like a statistical fluke
   * rather than a fixture holding the process still. A probe that dominates the thing it is
   * measuring is not a probe.
   */
  const silenced = (await api('GET', '/notify/notification-channels', { token: tok })).json.data.filter(
    (c) => c.enabled,
  );
  for (const c of silenced) {
    await api('PATCH', `/notify/notification-channels/${c.id}`, { token: tok, body: { enabled: false } });
  }
  restoreChannels = silenced.filter((c) => !c.name.startsWith(MARK));
  for (let i = 0; i < 12; i += 1) await channel(`burst-${i}`, 'in-app', {});
  console.log(
    `  · ${silenced.length} channels switched off (${restoreChannels.length} of them the tenant's), 12 in-app probes stood up`,
  );

  /*
   * ⚠️ **One** burst, sampled repeatedly as it drains. Publishing a fresh burst per attempt looked
   * reasonable and measured nothing: the engine was still working through the first three thousand
   * deliveries, so every later attempt queried incidents it had not reached and read zero rows. The
   * queue is the thing being sampled, so the samples have to be taken while the same queue drains.
   */
  const burst = Array.from({ length: 300 }, () => uuid());
  publish(burst.map((bid) => incidentFor({ id: bid, title: `${MARK} — burst` })));

  for (let attempt = 1; attempt <= attemptsAllowed && caught === null; attempt += 1) {
    await sleep(attempt === 1 ? 120 : 60);
    execFileSync('docker', ['pause', 'vip-prod-notify-1'], { stdio: 'ignore' });

    let rows = [];
    try {
      rows = mongoRead(
        `db.notifications.find({incidentId:{$in:${JSON.stringify(burst)}}},{_id:0,id:1,status:1,channelType:1,attempts:1}).toArray()`,
      );
      caught = rows.find((n) => n.status === 'pending') ?? null;
    } finally {
      execFileSync('docker', ['unpause', 'vip-prod-notify-1'], { stdio: 'ignore' });
    }
    const tally = rows.reduce((acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }), {});
    console.log(
      `  · freeze ${attempt}: ${rows.length} deliveries written at the moment the process stopped — ${
        Object.entries(tally).map(([s, n]) => `${n} ${s}`).join(', ') || '—'
      }`,
    );
    if (rows.length >= 3_600) break; // the burst has drained; nothing left to catch
  }

  check(
    caught !== null,
    '5a · **pending** produced — a real delivery caught between its insert and its transport',
    caught ? `${caught.channelType} · attempts ${caught.attempts}` : `not caught in ${attemptsAllowed} freezes`,
  );
  if (caught) {
    /*
     * ⚠️ Caught in flight, so it has to finish — which is the honest claim about this state:
     * `pending` is transient, and a healthy system never rests in it.
     *
     * What this does **not** show, and is therefore not claimed anywhere: that a delivery can be
     * stranded at `pending` for good. It follows from two things that *were* measured — the state
     * exists between two writes (here), and a redelivered incident never re-attempts a channel that
     * already has a record (4b) — so a process dying in this window strands a delivery nobody will
     * ever retry. That is recorded as a limitation, not as a verified observation.
     */
    await sleep(15_000);
    const [still] = mongoRead(
      `db.notifications.find({id:${JSON.stringify(caught.id)}},{_id:0,status:1}).toArray()`,
    );
    check(
      still?.status !== 'pending',
      '5b · ⚠️ and it advances once the process runs again — `pending` is transient, never a resting state',
      `pending → ${still?.status}`,
    );
  }
} finally {
  console.log('\nZ · putting the tenant back');
  await cleanup();
  /* Remove every delivery this script caused, and the probe’s incidents with them. */
  const removed = execFileSync(
    'docker',
    [
      'exec',
      'vip-prod-mongodb-1',
      'mongosh',
      '--quiet',
      '-u',
      env.MONGO_USER,
      '-p',
      env.MONGO_PASSWORD,
      '--authenticationDatabase',
      'admin',
      'vip',
      '--eval',
      `print(db.notifications.deleteMany({correlationId:/${MARK}/}).deletedCount)`,
    ],
    { encoding: 'utf8' },
  ).trim();
  console.log(`  · removed ${removed} probe deliveries`);
}

console.log(`\n${failures === 0 ? '✓ every state the platform has was produced' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
