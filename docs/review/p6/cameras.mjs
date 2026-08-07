/**
 * P-6.6 · **camera management depth, against the production deployment.**
 *
 *   node docs/review/p6/cameras.mjs
 *
 * 1  the list is answered by the **server** — search, location, lifecycle, paging, and a real total
 * 2  ⚠️ two administrators editing one camera: exactly one wins, and the other is told
 * 3  permissions: an operator may read every camera and change none of them
 * 4  the capability record carries what was measured apart from what was declared
 * 5  recording state comes from the media service, and "no worker" is an answer
 * 6  latency, measured
 *
 * ⚠️ Every write here is put back. The demo estate is what a demonstration runs on, and a
 * verification that consumes it works exactly once.
 */
import { Agent, request as httpsRequest } from 'node:https';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const OPERATOR = { email: 'day.operator@northgate.demo', password: '12345678' };
const OTHER = {
  tenant: 'tnt_demo_warehouse',
  email: 'site.manager@meridian.demo',
  password: '12345678',
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/** ⚠️ `node:https` with an agent per caller — undici would queue two "concurrent" edits onto one
 *  socket and serialise the race this script exists to measure (the P-6.5 lesson, applied here). */
function call(method, path, { token, body, tenant, agent, ifMatch } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const started = performance.now();
    const req = httpsRequest(
      {
        host: 'localhost',
        port: 443,
        method,
        path: `/api${path}`,
        rejectUnauthorized: false,
        ...(agent ? { agent } : {}),
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(tenant ? { 'x-tenant-id': tenant } : {}),
          ...(ifMatch ? { 'if-match': ifMatch } : {}),
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            json: text ? JSON.parse(text) : undefined,
            ms: performance.now() - started,
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const login = async (creds, tenant = TENANT) =>
  (await call('POST', '/identity/auth/login', { body: creds, tenant })).json.data.accessToken;

console.log('\nP-6.6 · cameras against the deployment\n');

const admin = await login(ADMIN);
const operator = await login(OPERATOR);

// ── 1 · the list is the server's answer ─────────────────────────────────────────────────────────
console.log('1 · the list');

const page = await call('GET', '/camera/cameras?limit=3', { token: admin });
check(page.status === 200, '1a · the camera list loads', `HTTP ${page.status}`);
check(
  Array.isArray(page.json?.data?.cameras),
  '1b · ⚠️ a request with a limit is answered with a **page**, not a bare array',
  `keys: ${Object.keys(page.json?.data ?? {}).join(', ')}`,
);

const all = await call('GET', '/camera/cameras?limit=500', { token: admin });
const estate = all.json.data.cameras;
check(estate.length > 0, '1c · the deployment has cameras to manage', `${estate.length}`);

/* ⚠️ Paging is keyset: page 2 must not repeat page 1, and the cursor must actually advance. */
const first = await call('GET', '/camera/cameras?limit=2', { token: admin });
const second = await call(
  'GET',
  `/camera/cameras?limit=2&cursor=${encodeURIComponent(first.json.data.nextCursor ?? '')}`,
  { token: admin },
);
const firstIds = new Set(first.json.data.cameras.map((c) => c.id));
check(
  first.json.data.nextCursor !== undefined,
  '1d · a page that is not the last one says so',
  `cursor ${first.json.data.nextCursor ? 'present' : 'absent'}`,
);
check(
  second.json.data.cameras.every((c) => !firstIds.has(c.id)),
  '1e · ⚠️ the next page holds different cameras — keyset paging, not an offset that drifts',
  `${second.json.data.cameras.length} on page 2`,
);

/*
 * ⚠️ The search an installer types. Until P-6.6 the server matched the **name** and the console
 * matched seven fields in the browser — so moving the search to the server without widening it
 * would have quietly removed six of them.
 */
/*
 * ⚠️ **A skipped check is reported, not omitted.** The first run of this script printed 1e and then
 * 1g: no demo camera carries a manufacturer, so the manufacturer search silently did not run and the
 * output looked complete. Silence is not success (P-6.5 §8) — so the script writes the field it
 * needs onto a camera, measures, and puts it back.
 */
const probeMaker = `p66-${Date.now()}`;
const markTarget = estate[0];
const marked = await call('PATCH', `/camera/cameras/${markTarget.id}`, {
  token: admin,
  body: { metadata: { ...markTarget.metadata, manufacturer: probeMaker } },
});
const byMaker = await call(
  'GET',
  `/camera/cameras?limit=50&search=${encodeURIComponent(probeMaker)}`,
  { token: admin },
);
check(
  marked.status === 200 && byMaker.json.data.cameras.some((c) => c.id === markTarget.id),
  '1f · ⚠️ search matches the manufacturer, not only the name',
  `"${probeMaker}" → ${byMaker.json?.data?.cameras?.length ?? 0} matched`,
);
await call('PATCH', `/camera/cameras/${markTarget.id}`, {
  token: admin,
  body: { metadata: markTarget.metadata },
});
const byUrl = await call(
  'GET',
  `/camera/cameras?limit=50&search=${encodeURIComponent(estate[0].streamUrl.slice(7, 20))}`,
  { token: admin },
);
check(
  byUrl.json.data.cameras.length > 0,
  '1g · and matches the stream URL — how an installer looks up a channel',
  `${byUrl.json.data.cameras.length} matched`,
);

/* A literal, not a pattern: `.*` finds a camera called ".*" and never the estate. */
const injected = await call('GET', '/camera/cameras?limit=50&search=.*', { token: admin });
check(
  injected.json.data.cameras.length === 0,
  '1h · ⚠️ the search term is a literal — a regex typed into the box matches nothing',
  `${injected.json.data.cameras.length} matched`,
);

const metrics = await call('GET', '/camera/cameras/metrics?window=day', { token: admin });
check(
  metrics.json?.data?.cameras === estate.length,
  '1i · ⚠️ the estate total comes from the server, so "of N" is never a page size',
  `metrics ${metrics.json?.data?.cameras} vs listed ${estate.length}`,
);

// ── 2 · two administrators, one camera ──────────────────────────────────────────────────────────
console.log('\n2 · ⚠️ two administrators editing the same camera');

const target = estate[0];
const before = (await call('GET', `/camera/cameras/${target.id}`, { token: admin })).json.data;
const originalMetadata = before.metadata;

const second_admin = await login(ADMIN);
const results = await Promise.all([
  call('PATCH', `/camera/cameras/${target.id}`, {
    token: admin,
    ifMatch: before.updatedAt,
    body: { metadata: { ...originalMetadata, notes: 'edited by the first administrator' } },
    agent: new Agent({ keepAlive: false, rejectUnauthorized: false }),
  }),
  call('PATCH', `/camera/cameras/${target.id}`, {
    token: second_admin,
    ifMatch: before.updatedAt,
    body: { metadata: { ...originalMetadata, tags: [...originalMetadata.tags, 'second-admin'] } },
    agent: new Agent({ keepAlive: false, rejectUnauthorized: false }),
  }),
]);
const won = results.filter((r) => r.status === 200);
const refused = results.filter((r) => r.status === 409);
console.log(`  · ${results.map((r) => r.status).join(' and ')}`);
check(
  won.length === 1,
  '2a · ⚠️ exactly one edit is accepted — the other is refused, not silently discarded',
  `${won.length} accepted`,
);
check(
  refused.length === 1 && /changed by someone else/i.test(refused[0]?.json?.error?.message ?? ''),
  '2b · and the loser is told what happened, in words an operator can act on',
  refused[0]?.json?.error?.message ?? '(no conflict)',
);

const after = (await call('GET', `/camera/cameras/${target.id}`, { token: admin })).json.data;
check(
  after.updatedAt !== before.updatedAt,
  '2c · the record moved exactly once',
  `${before.updatedAt} → ${after.updatedAt}`,
);

/* ⚠️ A caller that sends no token still works — the guard is additive, not a new requirement. */
const noToken = await call('PATCH', `/camera/cameras/${target.id}`, {
  token: admin,
  body: { metadata: originalMetadata },
});
check(
  noToken.status === 200,
  '2d · ⚠️ a caller that sends no If-Match behaves as before — additive, nothing breaks',
  `HTTP ${noToken.status}`,
);

/* And a stale token is refused however old it is. */
const stale = await call('PATCH', `/camera/cameras/${target.id}`, {
  token: admin,
  ifMatch: before.updatedAt,
  body: { metadata: originalMetadata },
});
check(stale.status === 409, '2e · a stale token is refused', `HTTP ${stale.status}`);

// ── 3 · permissions ─────────────────────────────────────────────────────────────────────────────
console.log('\n3 · who may change a camera');

const opRead = await call('GET', '/camera/cameras?limit=5', { token: operator });
check(opRead.status === 200, '3a · an operator reads the estate', `HTTP ${opRead.status}`);
const opWrite = await call('PATCH', `/camera/cameras/${target.id}`, {
  token: operator,
  body: { name: 'renamed by an operator' },
});
check(
  opWrite.status === 403,
  '3b · ⚠️ and may not reconfigure a camera — that is administration',
  `HTTP ${opWrite.status}`,
);

const otherTenant = await login(
  { email: OTHER.email, password: OTHER.password },
  OTHER.tenant,
);
const crossTenant = await call('GET', `/camera/cameras/${target.id}`, { token: otherTenant });
check(
  crossTenant.status === 404,
  '3c · ⚠️ another tenant gets 404, not 403 — no existence leak',
  `HTTP ${crossTenant.status}`,
);

// ── 4 · measured apart from declared ────────────────────────────────────────────────────────────
console.log('\n4 · what the record knows, and how');

const withCaps = estate[0];
check(
  typeof withCaps.capabilities === 'object',
  '4a · every camera carries a capability record',
  `${Object.keys(withCaps.capabilities).length} fields`,
);
check(
  'onvif' in withCaps.capabilities && 'metadataStream' in withCaps.capabilities,
  '4b · including what it declares about ONVIF and an analytics stream',
);
const measured = estate.filter((c) => c.operational !== undefined).length;
console.log(
  `  · ${measured} of ${estate.length} cameras have ever been measured (the rest are declared only)`,
);
check(
  estate.every((c) => c.operational === undefined || c.operational.evidenceClass !== undefined),
  '4c · ⚠️ and a measurement says what class of evidence it is — a simulation proves nothing',
);

// ── 5 · recording ───────────────────────────────────────────────────────────────────────────────
console.log('\n5 · recording state, from the media service');

const streamStatus = await call('GET', `/media/streams/${target.id}/status`, { token: admin });
check(
  streamStatus.status === 200 || streamStatus.status === 404,
  '5a · media answers about this camera',
  `HTTP ${streamStatus.status}`,
);
check(
  streamStatus.status !== 404 ||
    /no stream/i.test(streamStatus.json?.error?.message ?? ''),
  '5b · ⚠️ "no worker" is a 404 with a reason — the console must not read it as an outage',
  streamStatus.json?.error?.message ?? 'a worker exists',
);

// ── 6 · latency ─────────────────────────────────────────────────────────────────────────────────
console.log('\n6 · measured');

const samples = [];
for (let i = 0; i < 20; i += 1) {
  samples.push((await call('GET', '/camera/cameras?limit=50', { token: admin })).ms);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.floor(samples.length * 0.95)];
console.log(`  · GET /cameras?limit=50  p50 ${samples[10].toFixed(1)} ms · p95 ${p95.toFixed(1)} ms`);
check(p95 < 250, '6a · the list answers fast enough to page through', `${p95.toFixed(1)} ms`);

// ── restore ─────────────────────────────────────────────────────────────────────────────────────
const restored = await call('PATCH', `/camera/cameras/${target.id}`, {
  token: admin,
  body: { metadata: originalMetadata },
});
check(
  restored.status === 200 &&
    JSON.stringify(restored.json.data.metadata) === JSON.stringify(originalMetadata),
  '⚠️ Z · the camera is exactly as it was found',
  `HTTP ${restored.status}`,
);

console.log(`\n${failures === 0 ? '✓ P-6.6 cameras: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
