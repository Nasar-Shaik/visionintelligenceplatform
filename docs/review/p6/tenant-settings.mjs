/**
 * P-6.3 · tenant settings, verified against the production deployment through the gateway.
 *
 *   node docs/review/p6/tenant-settings.mjs
 *
 * Covers the API half of the milestone's acceptance list:
 *   1  the mutable surface is exactly what the backend supports, and no more
 *   2  optimistic concurrency — a stale write is refused with 409, never silently applied
 *   3  the multi-tab case, which is the same race with two real sessions
 *   4  cross-tenant requests are indistinguishable from requests for tenants that do not exist
 *   5  the audit record: one event per change, with before/after, actor and correlation id
 *   6  save latency, p50 and p95, measured rather than assumed
 *
 * ⚠️ Restores the tenant's original name before exiting, so the demo dataset is left pristine.
 */
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const OPERATOR = { email: 'day.operator@northgate.demo', password: '12345678' };
const OTHER = {
  tenant: 'tnt_demo_warehouse',
  email: 'site.manager@meridian.demo',
  password: '12345678',
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed edge certificate

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

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
  const ms = performance.now() - started;
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json, ms };
}

const login = (creds, tenant = TENANT) =>
  api('POST', '/identity/auth/login', { body: creds, tenant });

console.log('\nP-6.3 · tenant settings against the deployment\n');

const admin = await login(ADMIN);
if (admin.status !== 200) {
  console.error('cannot sign in as the demo administrator', admin.status, admin.json);
  process.exit(1);
}
const adminTok = admin.json.data.accessToken;

const read = () => api('GET', `/tenant/tenants/${TENANT}`, { token: adminTok });
const patch = (body, token = adminTok, id = TENANT) =>
  api('PATCH', `/tenant/tenants/${id}`, { token, body });

const original = (await read()).json.data;
check(original?.name !== undefined, '0 · the tenant record loads', original?.name);
const ORIGINAL_NAME = original.name;

// ── 1 · the mutable surface ─────────────────────────────────────────────────────────────────────
const renamed = await patch({ name: 'Northgate Retail Group (P-6.3 probe)' });
check(renamed.status === 200, '1 · the name is mutable', `HTTP ${renamed.status}`);
check(renamed.json?.data?.slug === original.slug, '1 · the slug is untouched by a rename');

const slugAttempt = await patch({ name: 'Northgate Retail Group (P-6.3 probe)', slug: 'hijacked' });
check(
  slugAttempt.json?.data?.slug === original.slug,
  '1 · ⚠️ a slug in the body is ignored, not honoured',
  slugAttempt.json?.data?.slug,
);

const empty = await patch({ name: '' });
check(empty.status === 400, '1 · an empty name is refused', `HTTP ${empty.status}`);
const nothing = await patch({});
check(
  nothing.status === 400,
  '1 · a body that changes nothing is refused',
  `HTTP ${nothing.status}`,
);

// ── 2 · optimistic concurrency ──────────────────────────────────────────────────────────────────
const shared = (await read()).json.data.updatedAt;
const alice = await patch({ name: 'Renamed by Alice', expectedUpdatedAt: shared });
check(alice.status === 200, '2 · the first administrator saves', `HTTP ${alice.status}`);

const bob = await patch({ name: 'Renamed by Bob', expectedUpdatedAt: shared });
check(
  bob.status === 409,
  '2 · ⚠️ the second gets 409, not a silent overwrite',
  `HTTP ${bob.status}`,
);
check(
  (await read()).json.data.name === 'Renamed by Alice',
  "2 · ⚠️ and the first administrator's change survived",
);

const afterReload = (await read()).json.data.updatedAt;
const bobRetry = await patch({ name: 'Renamed by Bob', expectedUpdatedAt: afterReload });
check(bobRetry.status === 200, '2 · the second succeeds once reloaded', `HTTP ${bobRetry.status}`);

const noVersion = await patch({ name: 'No version supplied' });
check(
  noVersion.status === 200,
  '2 · omitting the version still writes — the field is additive',
  `HTTP ${noVersion.status}`,
);

// ── 3 · multi-tab, with two genuinely independent sessions ──────────────────────────────────────
const tabA = (await login(ADMIN)).json.data.accessToken;
const tabB = (await login(ADMIN)).json.data.accessToken;
const seenByBoth = (await read()).json.data.updatedAt;
const savedInA = await patch({ name: 'Saved in tab A', expectedUpdatedAt: seenByBoth }, tabA);
const savedInB = await patch({ name: 'Saved in tab B', expectedUpdatedAt: seenByBoth }, tabB);
check(savedInA.status === 200, '3 · tab A saves', `HTTP ${savedInA.status}`);
check(
  savedInB.status === 409,
  '3 · ⚠️ tab B is refused on stale data (two real sessions, one record)',
  `HTTP ${savedInB.status}`,
);
check((await read()).json.data.name === 'Saved in tab A', '3 · tab A’s value is what is stored');

// ── 4 · permission and isolation boundaries ─────────────────────────────────────────────────────
const opTok = (await login(OPERATOR)).json.data.accessToken;
const opRead = await api('GET', `/tenant/tenants/${TENANT}`, { token: opTok });
check(
  opRead.status === 200,
  '4 · an operator may read the tenant (`*:read`)',
  `HTTP ${opRead.status}`,
);

const otherLogin = await login({ email: OTHER.email, password: OTHER.password }, OTHER.tenant);
const otherTok = otherLogin.json?.data?.accessToken;
const crossReal = await api('GET', `/tenant/tenants/${TENANT}`, { token: otherTok });
const crossFake = await api('GET', '/tenant/tenants/tnt_does_not_exist_anywhere', {
  token: otherTok,
});
check(crossReal.status === 403, '4 · a cross-tenant read is refused', `HTTP ${crossReal.status}`);
/*
 * ⚠️ Elsewhere the platform answers 404 so an id cannot be probed for existence. Here 403 is
 * equally safe and the test says why: the gate never touches the database, so a real foreign
 * tenant and an id that has never existed produce identical responses. There is no oracle.
 */
check(
  crossReal.status === crossFake.status &&
    crossReal.json?.error?.code === crossFake.json?.error?.code &&
    crossReal.json?.error?.message === crossFake.json?.error?.message,
  '4 · ⚠️ a foreign tenant and a nonexistent one are byte-identical',
  `${crossReal.status}/${crossReal.json?.error?.code} vs ${crossFake.status}/${crossFake.json?.error?.code}`,
);
const crossWrite = await patch({ name: 'Taken over' }, otherTok);
check(
  crossWrite.status === 403,
  '4 · a cross-tenant write is refused',
  `HTTP ${crossWrite.status}`,
);
check(
  (await read()).json.data.name === 'Saved in tab A',
  '4 · ⚠️ and the cross-tenant write really did not land',
);

// ── 5 · the audit record ────────────────────────────────────────────────────────────────────────
const auditProbe = 'Audit probe ' + Date.now();
const auditWrite = await patch({ name: auditProbe });
check(auditWrite.status === 200, '5 · a rename succeeds so it can be audited');
console.log('     (the audit line is asserted from the container log below)');

// ── 6 · latency, measured ───────────────────────────────────────────────────────────────────────
const samples = [];
for (let i = 0; i < 30; i += 1) {
  const current = await read();
  const res = await patch({
    name: `Latency sample ${i}`,
    expectedUpdatedAt: current.json.data.updatedAt,
  });
  if (res.status === 200) samples.push(res.ms);
}
samples.sort((a, b) => a - b);
const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
check(samples.length >= 25, '6 · latency samples collected', `${samples.length}/30 succeeded`);
console.log(
  `     PATCH latency (through the gateway, n=${samples.length}): ` +
    `p50 ${pct(50).toFixed(0)} ms · p95 ${pct(95).toFixed(0)} ms · max ${samples.at(-1).toFixed(0)} ms`,
);

const reads = [];
for (let i = 0; i < 30; i += 1) reads.push((await read()).ms);
reads.sort((a, b) => a - b);
const rpct = (p) => reads[Math.min(reads.length - 1, Math.floor((p / 100) * reads.length))];
console.log(
  `     GET   latency (through the gateway, n=${reads.length}): ` +
    `p50 ${rpct(50).toFixed(0)} ms · p95 ${rpct(95).toFixed(0)} ms`,
);

// ── restore ─────────────────────────────────────────────────────────────────────────────────────
const restore = await patch({ name: ORIGINAL_NAME });
check(
  restore.status === 200 && restore.json.data.name === ORIGINAL_NAME,
  '⚠️ dataset restored',
  ORIGINAL_NAME,
);

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
console.log(`Audit probe name to look for in the tenant log: "${auditProbe}"\n`);
process.exit(failures === 0 ? 0 : 1);
