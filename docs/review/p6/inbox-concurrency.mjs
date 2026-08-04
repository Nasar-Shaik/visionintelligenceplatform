/**
 * P-6.5 · **two operators, one alert** — acknowledgement under concurrency, against the deployment.
 *
 *   node docs/review/p6/inbox-scale.mjs load        # disposable targets
 *   node docs/review/p6/inbox-concurrency.mjs
 *   node docs/review/p6/inbox-scale.mjs clean
 *
 * Two people on a shift see the same alert land and both reach for it. What must be true afterwards:
 *
 *   1 exactly one acknowledgement succeeds
 *   2 the other is told, in the words the console shows, that somebody else has it
 *   3 the record names **one** person, and it does not change afterwards
 *   4 ⚠️ exactly one `notification.acked` is published — one state transition, one audit record
 *   5 the queue drops by exactly one
 *
 * ### ⚠️ Why this is run against real MongoDB, on real sockets, and not in a unit test
 *
 * P-6.3 taught half of this: the same race, written against the in-memory store, **could not fail**
 * — the fake serialises every operation, so a read-compare-write looks atomic and the test goes
 * green against a defect.
 *
 * The first version of *this* script taught the other half. Six `fetch` calls fired with
 * `Promise.all` all left on **one socket**, eight milliseconds apart, because undici queues requests
 * to the same origin on a single connection. The server saw six requests in a neat row, answered one
 * 200 and five 409s, and the check went green having tested nothing. So every racer here gets its
 * **own agent and its own connection**, and the script asserts the requests genuinely overlapped
 * before it is willing to believe the result. ⚠️ A concurrency test that does not prove it was
 * concurrent is a spelling test.
 *
 * Targets are the `loadTest` rows, because acknowledging is one-way: a run against the demo dataset
 * would consume the queue the next demonstration needs.
 */
import { execFileSync } from 'node:child_process';
import { Agent, request as httpsRequest } from 'node:https';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
/* ⚠️ Two different principals — the same person in two tabs would not prove the record names one. */
const ALICE = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const BOB = { email: 'day.operator@northgate.demo', password: 'Vip-Demo-2026!' };
const RACERS = Number(process.env.RACERS ?? 6);
const ROUNDS = Number(process.env.ROUNDS ?? 12);
const HEAVY = Number(process.env.HEAVY ?? 12);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

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

const login = async (creds) => {
  const res = await api('POST', '/identity/auth/login', { body: creds, tenant: TENANT });
  if (res.status !== 200) {
    console.error('cannot sign in', creds.email, res.status, JSON.stringify(res.json));
    process.exit(1);
  }
  return res.json.data.accessToken;
};

/**
 * One acknowledgement on its **own connection**, so the requests actually overlap.
 *
 * ⚠️ `fetch` will not do here: undici pools by origin and lays concurrent calls out end to end on
 * one socket. A fresh agent per racer, `keepAlive: false`, is what makes six simultaneous operators
 * simultaneous.
 */
function ackOnItsOwnSocket(id, token) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = httpsRequest(
      `${B}/api/notify/notifications/${id}/ack`,
      {
        method: 'POST',
        agent: new Agent({ keepAlive: false, maxSockets: 1 }),
        rejectUnauthorized: false,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            json: body ? JSON.parse(body) : undefined,
            startedAt,
            endedAt: Date.now(),
          }),
        );
      },
    );
    req.on('error', (err) =>
      resolve({ status: 0, json: { error: { message: err.message } }, startedAt, endedAt: Date.now() }),
    );
    req.end('{}');
  });
}

/**
 * How many messages the NOTIFICATIONS JetStream stream is holding.
 *
 * ⚠️ This is the audit trail as it exists today: `notification.acked` is **published**, not written
 * to an audit collection — there is no queryable audit store in the platform yet (P-13). Counting
 * log lines finds nothing, because the publisher logs nothing; the stream is the record.
 */
function streamMessages() {
  const out = execFileSync(
    'docker',
    ['exec', 'vip-prod-nats-1', 'sh', '-c', 'wget -qO- "http://localhost:8222/jsz?streams=1"'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const stream = JSON.parse(out).account_details[0].stream_detail.find(
    (s) => s.name === 'NOTIFICATIONS',
  );
  return stream.state.messages;
}

console.log('\nP-6.5 · two operators, one alert\n');

const alice = await login(ALICE);
const bob = await login(BOB);

/* A disposable, acknowledgeable target. */
const queue = await api('GET', '/notify/notifications?acknowledged=false&limit=200', { token: alice });
const target = queue.json.data.items.find((n) => n.id.startsWith('ld') && n.status === 'delivered');
if (!target) {
  console.error('no loadTest target available — run `node docs/review/p6/inbox-scale.mjs load` first');
  process.exit(1);
}
/** ⚠️ The whole queue, not one page: a 200-row page cannot measure a 517-row set. */
async function queueSize(token) {
  let cursor;
  let n = 0;
  do {
    const res = await api(
      'GET',
      `/notify/notifications?acknowledged=false&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      { token },
    );
    n += res.json.data.items.length;
    cursor = res.json.data.nextCursor;
  } while (cursor);
  return n;
}

const before = await queueSize(alice);
console.log(`  target ${target.id} (${target.status}) · queue holds ${before} deliveries\n`);

// ── 1 · the race ────────────────────────────────────────────────────────────────────────────────
console.log('1 · both operators press Acknowledge at the same moment');

const streamBefore = streamMessages();
const tokens = Array.from({ length: RACERS }, (_, i) => (i % 2 === 0 ? alice : bob));
const results = await Promise.all(tokens.map((t) => ackOnItsOwnSocket(target.id, t)));

/*
 * ⚠️ Proof that this was a race at all. If the last request left before the first one came back, the
 * requests overlapped in the server; if they did not, the result below is meaningless and this check
 * says so instead of quietly passing.
 */
const lastStart = Math.max(...results.map((r) => r.startedAt));
const firstEnd = Math.min(...results.map((r) => r.endedAt));
console.log(
  `  · overlap: last request started ${firstEnd - lastStart} ms ${lastStart < firstEnd ? 'before' : 'after'} the first answer came back`,
);
check(
  lastStart < firstEnd,
  '1_ · ⚠️ the requests genuinely overlapped — otherwise nothing below is a race',
  `${results.length} requests, spread ${Math.max(...results.map((r) => r.startedAt)) - Math.min(...results.map((r) => r.startedAt))} ms`,
);

const ok = results.filter((r) => r.status === 200);
const conflicts = results.filter((r) => r.status === 409);
const other = results.filter((r) => r.status !== 200 && r.status !== 409);

console.log(`  · ${RACERS} simultaneous requests → ${ok.length} × 200, ${conflicts.length} × 409${other.length ? `, ${other.length} × other` : ''}`);
check(ok.length === 1, '1a · ⚠️ exactly one acknowledgement succeeds', `${ok.length} succeeded`);
check(
  conflicts.length === RACERS - 1,
  '1b · every other request is refused with a conflict',
  `${conflicts.length} of ${RACERS - 1}`,
);
check(other.length === 0, '1c · and nothing fails in some third way', other.map((r) => r.status).join(','));

const message = conflicts[0]?.json?.error?.message ?? '';
console.log(`  · what the loser is told: "${message}"`);
check(
  /acknowledg/i.test(message),
  '1d · the refusal says what happened rather than leaking a status enum',
  message,
);

// ── 2 · the record ──────────────────────────────────────────────────────────────────────────────
console.log('\n2 · what the record says afterwards');

const after = await api('GET', `/notify/notifications/${target.id}`, { token: alice });
const row = after.json.data;
console.log(`  · status ${row.status} · ackedBy ${row.ackedBy} · ackedAt ${row.ackedAt}`);
check(row.status === 'acked', '2a · the delivery is acknowledged');
check(
  row.ackedBy === ALICE.email || row.ackedBy === BOB.email,
  '2b · ⚠️ and it names one of the two real principals, not a caller-supplied string',
  row.ackedBy,
);
check(
  row.ackedBy === ok[0]?.json?.data?.ackedBy && row.ackedAt === ok[0]?.json?.data?.ackedAt,
  '2c · the winner is the one the record names — the losers did not overwrite it',
);

// ── 3 · the audit trail ─────────────────────────────────────────────────────────────────────────
console.log('\n3 · one state transition, one audit record');

await new Promise((r) => setTimeout(r, 1_500)); // let the publish land
const published = streamMessages() - streamBefore;
console.log(`  · NOTIFICATIONS stream grew by ${published} message(s)`);
check(
  published === 1,
  '3a · ⚠️ exactly one `notification.acked` is published, not one per request that raced',
  `${published}`,
);
/*
 * ⚠️ Worth being precise about *why* this is one, because it is not the HTTP layer doing it. The
 * publisher stamps `msgId = {tenant}:{id}:{status}`, and JetStream collapses duplicates inside a
 * 120-second window — so the audit record would be exactly one **even if the service transitioned
 * the row twice**. The msgId is carrying more weight than it looks like it is, and check 1a above is
 * what actually protects the transition.
 */
console.log('    (exactly-once here is the msgId `{tenant}:{id}:acked` + JetStream dedup, not luck)');

// ── 4 · the queue ───────────────────────────────────────────────────────────────────────────────
console.log('\n4 · the count everyone is looking at');

const nowSize = await queueSize(alice);
console.log(`  · queue: ${before} → ${nowSize} deliveries`);
check(
  nowSize === before - 1,
  '4a · the queue drops by exactly one — not by the number of people who pressed',
  `${before - nowSize} removed`,
);
const stillThere = await api('GET', `/notify/notifications?acknowledged=false&limit=200`, { token: alice });
check(
  !stillThere.json.data.items.some((n) => n.id === target.id),
  '4b · and the acknowledged delivery is not in it',
);

// ── 5 · the same race, many times ───────────────────────────────────────────────────────────────
/*
 * ⚠️ One race proves one race. `ack` reads the row, decides, and writes it back — a read-compare-
 * write, which is the shape that produced two audit records for one change in P-6.3 — so whether the
 * single round above was correctness or scheduling luck is exactly the question. This runs it
 * repeatedly, harder, on fresh targets, and reports the distribution rather than the best case.
 */
console.log(`\n5 · ${ROUNDS} more rounds, ${HEAVY} operators each, fresh alert every time`);

const pool = (await api('GET', '/notify/notifications?acknowledged=false&limit=200', { token: alice }))
  .json.data.items.filter((n) => n.id.startsWith('ld') && n.status === 'delivered')
  .slice(0, ROUNDS);

const winnersPerRound = [];
for (const row of pool) {
  const racers = Array.from({ length: HEAVY }, (_, i) => (i % 2 === 0 ? alice : bob));
  const res = await Promise.all(racers.map((t) => ackOnItsOwnSocket(row.id, t)));
  const overlapped = Math.max(...res.map((r) => r.startedAt)) < Math.min(...res.map((r) => r.endedAt));
  winnersPerRound.push({ winners: res.filter((r) => r.status === 200).length, overlapped });
}
const multi = winnersPerRound.filter((r) => r.winners !== 1);
console.log(
  `  · winners per round: ${winnersPerRound.map((r) => r.winners).join(', ')}`,
);
check(
  winnersPerRound.every((r) => r.overlapped),
  '5a · every round genuinely overlapped',
  `${winnersPerRound.filter((r) => r.overlapped).length}/${winnersPerRound.length}`,
);
check(
  multi.length === 0,
  '5b · ⚠️ exactly one operator wins in every round — the transition holds under repeated pressure',
  multi.length ? `${multi.length} round(s) had ${multi.map((r) => r.winners).join('/')} winners` : `${ROUNDS}/${ROUNDS} rounds`,
);

console.log(`\n${failures === 0 ? '✓ concurrent acknowledgement: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
