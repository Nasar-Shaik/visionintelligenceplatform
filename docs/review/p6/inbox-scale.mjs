/**
 * P-6.5 · the inbox **at scale**, against the production deployment.
 *
 *   node docs/review/p6/inbox-scale.mjs load    # insert 5,000 marked deliveries
 *   node docs/review/p6/inbox-scale.mjs api     # measure the server: latency, explain, deep pages
 *   node docs/review/p6/inbox-scale.mjs clean   # remove exactly what `load` inserted, and prove it
 *
 * ### ⚠️ Why the data is inserted rather than generated through the product
 *
 * There is no API that creates a notification — the Alert Engine emits one per channel per
 * `incident.raised`, and raising five thousand incidents to fill a queue would be measuring the
 * incident pipeline, not the inbox. So the delivery log is loaded directly, **every row carrying
 * `loadTest: true`**, and `clean` deletes on exactly that marker and asserts the collection is back
 * to the count it started at. ⚠️ A load harness that cannot prove it left is a data-corruption tool.
 *
 * ### ⚠️ The distribution is the *hard* one, deliberately
 *
 * The obvious shape — old alerts acknowledged, recent ones waiting — is the easy case: a newest-first
 * index finds fifty unacknowledged rows in the first fifty it reads. The expensive case is the
 * **well-run** tenant, where operators acknowledge promptly and `acknowledged=false` must walk past
 * thousands of acked rows to discover the queue is nearly empty. That is the query behind
 * "Nothing is waiting", it is the one an operator leaves open all shift, and it is the one measured
 * here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const COUNT = Number(process.env.COUNT ?? 5_000);
const MONGO = 'vip-prod-mongodb-1';
/** Where `load` records the size it found, so `clean` can prove it put that size back. */
const BASELINE_FILE = new URL('./.inbox-scale-baseline', import.meta.url).pathname;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const env = Object.fromEntries(
  readFileSync(new URL('../../../.env.production', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

/** mongosh inside the container — Mongo is not published to the host, and should not be. */
function mongo(js) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      MONGO,
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
      js,
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ).trim();
}

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
  const started = performance.now();
  const res = await fetch(`${B}/api${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const ms = performance.now() - started;
  return { status: res.status, json: text ? JSON.parse(text) : undefined, ms };
}

async function token() {
  const res = await api('POST', '/identity/auth/login', { body: ADMIN, tenant: TENANT });
  if (res.status !== 200) {
    console.error('cannot sign in', res.status, JSON.stringify(res.json));
    process.exit(1);
  }
  return res.json.data.accessToken;
}

const command = process.argv[2] ?? 'api';

// ── load ────────────────────────────────────────────────────────────────────────────────────────
if (command === 'load') {
  console.log(`\nLoading ${COUNT} marked deliveries into the production delivery log\n`);
  const before = Number(mongo('db.notifications.countDocuments({})'));
  writeFileSync(BASELINE_FILE, String(before));
  console.log(`  delivery log before: ${before} (of which marked: ${mongo('db.notifications.countDocuments({loadTest:true})')})`);

  /*
   * Two channels per incident, so grouping has real work to do: 5,000 deliveries collapse to 2,500
   * inbox entries, which is the number an operator would actually be looking at.
   */
  const script = `
    const T = ${JSON.stringify(TENANT)};
    const N = ${COUNT};
    const now = Date.now();
    const sev = ['critical','high','medium','low','info'];
    const titles = [
      'Person detected in restricted area','Loitering near the loading bay',
      'Perimeter intrusion — north fence','Crowd density above threshold',
      'Camera tamper suspected','Vehicle stopped in the fire lane'];
    const docs = [];
    for (let i = 0; i < N / 2; i += 1) {
      const at = new Date(now - i * 60_000 - 60_000);
      const iso = at.toISOString();
      const incidentId = 'ld000000-0000-4000-8000-' + String(i).padStart(12, '0');
      /*
       * ⚠️ The newest rows are acknowledged too. A distribution where everything recent is waiting
       * would let a newest-first index answer the queue query from the first page it touches, and
       * would measure nothing.
       */
      const acked = i % 10 !== 0;          // 90% handled — the well-run tenant
      const failed = !acked && i % 30 === 0;
      for (const ch of [['in-app','ch-load-app'], ['webhook','ch-load-hook']]) {
        const d = {
          id: 'ld' + String(i).padStart(6,'0') + '-0000-4000-8000-' + (ch[0]==='in-app'?'a':'b') + '00000000000',
          tenantId: T, incidentId, channelId: ch[1], channelType: ch[0],
          status: acked ? 'acked' : failed ? 'failed' : 'delivered',
          severity: sev[i % sev.length], title: titles[i % titles.length],
          correlationId: 'corr-load-' + i, causationId: incidentId,
          /* ⚠️ One attempt, because the platform attempts once. Load data that describes a retry
             mechanism nobody built is the same lie as demo data that does. */
          attempts: 1,
          createdAt: iso, updatedAt: iso, sentAt: iso,
          loadTest: true,
        };
        if (d.status === 'acked') { d.ackedAt = iso; d.ackedBy = 'day.operator@northgate.demo'; d.deliveredAt = iso; }
        if (d.status === 'delivered') d.deliveredAt = iso;
        if (d.status === 'failed') { d.failedAt = iso; d.lastError = 'connect ECONNREFUSED 10.0.0.9:443'; }
        docs.push(d);
      }
      if (docs.length >= 2000) { db.notifications.insertMany(docs, {ordered:false}); docs.length = 0; }
    }
    if (docs.length) db.notifications.insertMany(docs, {ordered:false});
    print(JSON.stringify({total: db.notifications.countDocuments({}), marked: db.notifications.countDocuments({loadTest:true})}));
  `;
  const started = Date.now();
  const out = mongo(script);
  const result = JSON.parse(out.split('\n').pop());
  console.log(`  inserted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  delivery log now: ${result.total} (marked: ${result.marked})`);
  console.log(`\n⚠️  Remember: node docs/review/p6/inbox-scale.mjs clean\n`);
  process.exit(0);
}

// ── clean ───────────────────────────────────────────────────────────────────────────────────────
if (command === 'clean') {
  console.log('\nRemoving the load rows\n');
  const out = mongo(`
    const removed = db.notifications.deleteMany({loadTest:true}).deletedCount;
    print(JSON.stringify({removed, marked: db.notifications.countDocuments({loadTest:true}), total: db.notifications.countDocuments({})}));
  `);
  const r = JSON.parse(out.split('\n').pop());
  check(r.marked === 0, 'every marked row is gone', `removed ${r.removed}`);
  /*
   * ⚠️ Compared against **what `load` found**, not against a constant. This asserted `total === 32`
   * and went red at 34 — two rows another verification script had legitimately raised in between —
   * reporting a leak that did not exist. The claim this harness owes is "it left nothing behind",
   * and that is a delta, not an absolute.
   */
  let baseline = null;
  try {
    baseline = Number(readFileSync(BASELINE_FILE, 'utf8').trim());
  } catch {
    /* no baseline recorded — `load` was run by an older revision, or not at all */
  }
  check(
    baseline === null || r.total === baseline,
    '⚠️ the delivery log is back to the size `load` found it',
    baseline === null ? `${r.total} rows (no baseline recorded)` : `${baseline} → ${r.total}`,
  );
  console.log(`\n${failures === 0 ? '✓ the harness left nothing behind' : `✗ ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── api ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\nP-6.5 · the inbox at scale — the server\n');

const total = Number(mongo('db.notifications.countDocuments({})'));
const unacked = Number(mongo(`db.notifications.countDocuments({status:{$ne:'acked'}})`));
console.log(`  dataset: ${total} deliveries, ${unacked} unacknowledged\n`);
check(total >= 5_000, '0 · the deployment is carrying a production-sized delivery log', `${total}`);

const tok = await token();
const list = (q) => api('GET', `/notify/notifications${q}`, { token: tok });

// ── 1 · the queue query, measured ───────────────────────────────────────────────────────────────
console.log('1 · the query an operator leaves open');

const sample = async (q, n = 20) => {
  const ms = [];
  let last;
  for (let i = 0; i < n; i += 1) {
    last = await list(q);
    ms.push(last.ms);
  }
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.floor(n * 0.5)], p95: ms[Math.min(n - 1, Math.floor(n * 0.95))], last };
};

const queue = await sample('?acknowledged=false&limit=50');
console.log(
  `  · GET ?acknowledged=false&limit=50   p50 ${queue.p50.toFixed(1)} ms · p95 ${queue.p95.toFixed(1)} ms   (${queue.last.json.data.items.length} rows)`,
);
check(queue.p95 < 250, '1a · the queue still loads fast enough to poll', `p95 ${queue.p95.toFixed(1)} ms`);

const everything = await sample('?limit=50');
console.log(
  `  · GET ?limit=50 (no filter)          p50 ${everything.p50.toFixed(1)} ms · p95 ${everything.p95.toFixed(1)} ms`,
);
check(everything.p95 < 250, '1b · and so does the unfiltered log', `p95 ${everything.p95.toFixed(1)} ms`);

/* ⚠️ Deep pagination: page 20 of a 5,000-row log, which "Load more" reaches in twenty clicks. */
let cursor;
let pages = 0;
const deep = [];
while (pages < 20) {
  const res = await list(`?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  deep.push(res.ms);
  cursor = res.json.data.nextCursor;
  pages += 1;
  if (!cursor) break;
}
deep.sort((a, b) => a - b);
console.log(
  `  · 20 pages deep, keyset               first ${deep[0].toFixed(1)} ms · worst ${deep[deep.length - 1].toFixed(1)} ms`,
);
check(
  deep[deep.length - 1] < 250,
  '1c · ⚠️ page 20 costs what page 1 costs — keyset paging, not skip/limit',
  `worst ${deep[deep.length - 1].toFixed(1)} ms`,
);

/*
 * ── 2 · what the database actually does ─────────────────────────────────────────────────────────
 *
 * ⚠️ **The query the service issues, not one this script writes.**
 *
 * Until the freeze close-out this ran `explain()` on a `find(...).sort({createdAt:-1,id:-1})`
 * composed *here*, and reported the plan for it. That measures whether an index exists that could
 * serve that shape — it says nothing about the shape the deployed service asks for. Mutation-tested
 * by rebuilding notify with the queue sorted on `updatedAt` (a field in no index): the service was
 * doing a 5,000-row in-memory sort, and both checks stayed green.
 *
 * So the plan cache is cleared, the queue is fetched **through the gateway**, and the entry MongoDB
 * then holds is the one the service caused. The sort in it is the service's sort.
 */
console.log('\n2 · measured in the database, on the query the service actually issues');

mongo('db.notifications.getPlanCache().clear()');
await api('GET', '/notify/notifications?acknowledged=false&limit=50', { token: tok });

const explain = JSON.parse(
  mongo(`
    const entries = db.notifications.aggregate([{$planCacheStats:{}}]).toArray()
      .filter(e => JSON.stringify(e.createdFromQuery.query).includes('acked'));
    const e = entries[0];
    if (!e) { print(JSON.stringify({missing:true})); } else {
      const s = e.creationExecStats && e.creationExecStats[0] ? e.creationExecStats[0] : {};
      print(JSON.stringify({
        entries: entries.length,
        sort: e.createdFromQuery.sort,
        query: e.createdFromQuery.query,
        returned: s.nReturned,
        examined: s.totalDocsExamined,
        keys: s.totalKeysExamined,
        ms: s.executionTimeMillisEstimate,
        stage: JSON.stringify(e.cachedPlan).includes('IXSCAN') ? 'IXSCAN' : 'COLLSCAN',
        sortInMemory: JSON.stringify(e.cachedPlan).includes('SORT_KEY_GENERATOR') ||
                      JSON.stringify(e.cachedPlan).includes('"stage":"SORT"'),
      }));
    }
  `).split('\n').pop(),
);
check(
  explain.missing !== true,
  '2_ · ⚠️ the fetch reached the database — otherwise the plan below belongs to nobody',
  explain.missing ? 'no plan-cache entry for the queue query' : `${explain.entries} entry`,
);
if (explain.missing !== true) {
  console.log(
    `  · the service asked for sort ${JSON.stringify(explain.sort)} · plan ${explain.stage} · keys ${explain.keys} · docs examined ${explain.examined} · returned ${explain.returned} · ${explain.ms} ms`,
  );
  check(explain.stage === 'IXSCAN', '2a · the queue query uses an index, not a collection scan');
  check(
    explain.sortInMemory === false,
    '2b · ⚠️ the sort is served by the index — an in-memory sort fails at 32 MB, not gradually',
    `sort ${JSON.stringify(explain.sort)}`,
  );
}
/*
 * ⚠️ This is the honest number. `status: {$ne:'acked'}` is not in the index, so the newest-first
 * walk fetches documents and discards the acknowledged ones. On a tenant that acknowledges promptly
 * that ratio is the whole dataset, and it is worth knowing before a customer's queue reaches
 * six figures rather than after.
 */
console.log(
  `  · documents read per row returned: ${(explain.examined / Math.max(1, explain.returned)).toFixed(1)}`,
);

// ── 3 · the grouping the browser has to do ──────────────────────────────────────────────────────
console.log('\n3 · what arrives at the browser');

const page = queue.last.json.data;
const incidents = new Set(page.items.map((n) => n.incidentId)).size;
console.log(`  · one page: ${page.items.length} deliveries → ${incidents} incidents`);
check(
  JSON.stringify(page).length < 200_000,
  '3a · a page is a sane payload',
  `${(JSON.stringify(page).length / 1024).toFixed(0)} KB`,
);
check(
  page.nextCursor !== undefined || page.items.length < 50,
  '3b · the queue is paged rather than returned whole',
);
/* ⚠️ No join: the inbox never reads the incident it names, so a page is one query at any size. */
check(
  page.items.every((n) => n.incidentId && n.title && n.severity),
  '3c · every row carries what the entry renders — no per-row incident lookup',
);

console.log(`\n${failures === 0 ? '✓ inbox at scale: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
