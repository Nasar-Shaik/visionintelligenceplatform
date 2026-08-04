/**
 * P-6.3 · the freeze pass. The last three claims the milestone makes that had not been measured.
 *
 *   node docs/review/p6/p63-freeze.mjs
 *
 * A  `/settings` is the **only** tenant-administration surface — no second screen, no second
 *    caller, no surviving placeholder. Source-level, because "there is nothing else" is a claim
 *    about the repository and cannot be observed from outside it.
 * B  **Exactly one** audit event per mutation. Not one per request: a retry, a double-submit, a
 *    refresh-and-resave and a five-way concurrent burst must all leave a trail a human can read.
 * C  The deployment is an **upgrade**, not a fresh install — the tenant service is running against
 *    documents written by an earlier image, and the new version token works on records that predate
 *    it.
 *
 * ⚠️ Restores every name it changes and verifies the restore.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../../', import.meta.url);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
/** A tenant seeded by the *previous* image and never touched since. That is the whole point of it. */
const LEGACY = {
  tenant: 'tnt_demo_school',
  email: 'site.lead@ashford.demo',
  password: 'Vip-Demo-2026!',
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed edge certificate

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

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
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}
const login = (creds, tenant) => api('POST', '/identity/auth/login', { body: creds, tenant });

/**
 * Every `tenant.updated` the tenant service has logged since the run began.
 *
 * ⚠️ Phases are separated by **taking a delta of this list**, not by narrowing `--since`. Docker
 * truncates `--since` to whole seconds, so a one-second window around a phase that takes 400 ms
 * silently absorbs the phase before it — which is how the first run of this script reported the
 * previous check's event as a duplicate of the current one's. A window that cannot be trusted to
 * exclude the past is not a measurement.
 */
const RUN_START = new Date(Date.now() - 5_000);
function auditLog() {
  const out = execFileSync(
    'docker',
    ['logs', 'vip-prod-tenant-1', '--since', RUN_START.toISOString()],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out
    .split('\n')
    .filter((line) => line.includes('"tenant.updated"'))
    .map((line) => {
      try {
        return JSON.parse(line).event;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
let seen = 0;
/** The events logged since the last call. Settles first — publishing is not synchronous with 200. */
async function newAudit() {
  await new Promise((r) => setTimeout(r, 500));
  const all = auditLog();
  const fresh = all.slice(seen);
  seen = all.length;
  return fresh;
}

console.log('\nP-6.3 · freeze pass\n');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A · one tenant-administration surface, and only one
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('A · the canonical surface');

const router = read('apps/console/src/app/router.tsx');
const nav = read('apps/console/src/features/shell/navModel.ts');

check(count(router, "path: 'settings'") === 1, 'A1 · exactly one /settings route', 'router.tsx');
check(count(router, '<SettingsPage />') === 1, 'A1 · rendered by exactly one element');
check(
  !/PlaceholderPage[^)]*settings/is.test(router),
  'A1 · ⚠️ no placeholder survives behind the real page',
);
check(count(nav, "to: '/settings'") === 1, 'A1 · exactly one navigation entry points at it');

/*
 * ⚠️ The check that matters is not "is there a second route" — it is "is there a second *caller*".
 * A duplicate edit surface arrives as a second component reaching for the same mutation long before
 * it arrives as a second URL.
 */
const callers = execFileSync(
  'git',
  ['grep', '-l', 'updateTenant', '--', 'apps/console/src'],
  { cwd: new URL('.', ROOT).pathname, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter((f) => !f.includes('.test.'));
check(
  callers.length === 2 &&
    callers.some((f) => f.endsWith('lib/api/organization.ts')) &&
    callers.some((f) => f.endsWith('features/organization/useOrganization.ts')),
  'A2 · one API binding, one hook, no third caller',
  callers.join(' · '),
);

const settings = read('apps/console/src/features/organization/SettingsPage.tsx');
check(count(settings, 'id="tenant-name"') === 1, 'A2 · one editable tenant-name field in the app');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B · exactly one audit event per mutation
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nB · audit completeness');

const admin = await login(ADMIN, TENANT);
if (admin.status !== 200) {
  console.error('cannot sign in as the demo administrator', admin.status, admin.json);
  process.exit(1);
}
const tok = admin.json.data.accessToken;
const get = () => api('GET', `/tenant/tenants/${TENANT}`, { token: tok });
const patch = (body) => api('PATCH', `/tenant/tenants/${TENANT}`, { token: tok, body });

const ORIGINAL = (await get()).json.data.name;
const PROBE = `${ORIGINAL} (freeze probe)`;

await newAudit(); // discard anything logged before the run

// B1 — one real change, one event.
await patch({ name: PROBE });
let events = await newAudit();
check(events.length === 1, 'B1 · one change produces exactly one event', `${events.length}`);
check(
  events[0]?.payload?.changes?.name?.from === ORIGINAL &&
    events[0]?.payload?.changes?.name?.to === PROBE,
  'B1 · it carries before and after',
);
check(
  Boolean(events[0]?.payload?.actorId) && Boolean(events[0]?.payload?.correlationId),
  'B1 · it carries the actor and the correlation id',
);

// B2 — the same value submitted three more times. A refresh-and-resave, or an impatient operator.
const beforeRepeat = (await get()).json.data.updatedAt;
const repeats = await Promise.all([patch({ name: PROBE }), patch({ name: PROBE })]);
await patch({ name: PROBE });
events = await newAudit();
check(
  repeats.every((r) => r.status === 200),
  'B2 · resubmitting the same value still succeeds',
);
check(
  events.length === 0,
  'B2 · ⚠️ and writes **no** audit record — nothing changed',
  `${events.length} events`,
);
check(
  (await get()).json.data.updatedAt === beforeRepeat,
  'B2 · ⚠️ and does not move the version token — nobody else is handed a 409 for it',
);

// B3 — five administrators submitting at once, all holding the same version.
const stale = (await get()).json.data.updatedAt;
const burst = await Promise.all(
  [1, 2, 3, 4, 5].map((n) =>
    patch({ name: `${ORIGINAL} (burst ${n})`, expectedUpdatedAt: stale }),
  ),
);
events = await newAudit();
const won = burst.filter((r) => r.status === 200);
const lost = burst.filter((r) => r.status === 409);
check(won.length === 1, 'B3 · exactly one of five concurrent writes commits', `${won.length}`);
check(lost.length === 4, 'B3 · the other four are refused with 409', `${lost.length}`);
check(
  events.length === 1,
  'B3 · ⚠️ and the audit shows one event, not five',
  `${events.length} events`,
);
check(
  events[0]?.payload?.expectedUpdatedAt === stale,
  'B3 · the record names the version the winner held',
);

// B4 — a double-click: the same new value, twice, as fast as the client can send it.
const doubled = `${ORIGINAL} (double-click)`;
const clicks = await Promise.all([patch({ name: doubled }), patch({ name: doubled })]);
events = await newAudit();
check(
  clicks.every((r) => r.status === 200),
  'B4 · both halves of a double-click succeed — neither operator sees an error',
);
check(
  events.length === 1,
  'B4 · ⚠️ and the audit records the transition once, not twice',
  `${events.length} events`,
);

// Restore.
await patch({ name: ORIGINAL });
check((await get()).json.data.name === ORIGINAL, 'B · the tenant name is restored', ORIGINAL);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C · an upgrade over an existing database
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nC · deployment upgrade');

/*
 * ⚠️ This is not simulated. The running tenant image was built *after* these documents were written,
 * by a build that did not have optimistic concurrency in it — so the check below is the real
 * question ("does the new code read old records") asked of real old records.
 */
const imageBuilt = new Date(
  execFileSync('docker', ['inspect', '--format', '{{.Created}}', 'vip/tenant:local'], {
    encoding: 'utf8',
  }).trim(),
);

const legacyLogin = await login(
  { email: LEGACY.email, password: LEGACY.password },
  LEGACY.tenant,
);
if (legacyLogin.status !== 200) {
  console.error('cannot sign in to the legacy tenant', legacyLogin.status, legacyLogin.json);
  process.exit(1);
}
const legacyTok = legacyLogin.json.data.accessToken;
const legacyGet = () => api('GET', `/tenant/tenants/${LEGACY.tenant}`, { token: legacyTok });
const legacyPatch = (body) =>
  api('PATCH', `/tenant/tenants/${LEGACY.tenant}`, { token: legacyTok, body });

const before = await legacyGet();
check(before.status === 200, 'C1 · a record written by the previous image still reads', before.status);
const legacyName = before.json.data.name;
const writtenAt = new Date(before.json.data.updatedAt);
check(
  writtenAt < imageBuilt,
  'C1 · ⚠️ and it was written before this image existed',
  `record ${writtenAt.toISOString()} < image ${imageBuilt.toISOString()}`,
);
check(
  before.json.data.updatedAt !== undefined && !Number.isNaN(writtenAt.getTime()),
  'C1 · its updatedAt is parseable — no migration was required',
);

// C2 — an *old* client. One that has never heard of expectedUpdatedAt must keep working.
const oldClient = await legacyPatch({ name: `${legacyName} (upgrade probe)` });
check(oldClient.status === 200, 'C2 · a client that omits the version token still saves', oldClient.status);

// C3 — the legacy timestamp is a usable version token.
const current = (await legacyGet()).json.data;
const withToken = await legacyPatch({
  name: `${legacyName} (upgrade probe 2)`,
  expectedUpdatedAt: current.updatedAt,
});
check(withToken.status === 200, 'C3 · a timestamp written by the old image is accepted as a token');
check(
  Date.parse(withToken.json.data.updatedAt) > Date.parse(current.updatedAt),
  'C3 · and the new value strictly increases',
);

const stalest = await legacyPatch({ name: 'should not apply', expectedUpdatedAt: writtenAt.toISOString() });
check(stalest.status === 409, 'C3 · the pre-upgrade timestamp is now stale, and is refused', stalest.status);

await legacyPatch({ name: legacyName });
check((await legacyGet()).json.data.name === legacyName, 'C · the legacy tenant is restored', legacyName);

console.log(
  `\n${failures === 0 ? '✓ P-6.3 freeze pass: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
