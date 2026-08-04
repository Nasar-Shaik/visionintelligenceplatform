/**
 * P-6.4 · System Health, verified against the production deployment by **breaking it**.
 *
 *   node docs/review/p6/system-health.mjs
 *
 * ⚠️ A health page that has only ever been seen against a healthy deployment is indistinguishable
 * from a picture of ten green ticks. Every section below therefore causes a real failure and asserts
 * the word the page gives an operator:
 *
 *   A  baseline — what the deployment actually reports, and that nothing is claimed without evidence
 *   B  a stopped service → `unreachable`, with a reason, and ⚠️ **its silence is not counted as
 *      evidence about the database**
 *   C  a paused MongoDB → ⚠️ the proof that `/health` is not evidence of health: every service still
 *      answers `{"status":"ok"}` while the platform cannot serve a single request
 *   D  the permission boundary — operator yes, viewer no
 *   E  the cache, so N viewers are not N fan-outs
 *   F  latency, measured
 *
 * ⚠️ Restores every container it touches, and verifies the restore.
 */
import { execFileSync } from 'node:child_process';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const OPERATOR = { email: 'day.operator@northgate.demo', password: 'Vip-Demo-2026!' };
/* A viewer-only account. Created for this run and left disabled-by-absence of roles. */
const VIEWER = { email: `p64.viewer.${Date.now()}@northgate.demo`, password: 'Probe-Password-2026!' };

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed edge certificate

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

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
const login = (creds) => api('POST', '/identity/auth/login', { body: creds, tenant: TENANT });

console.log('\nP-6.4 · System Health against the deployment\n');

const admin = await login(ADMIN);
if (admin.status !== 200) {
  console.error('cannot sign in as the demo administrator', admin.status, admin.json);
  process.exit(1);
}
const adminTok = admin.json.data.accessToken;

const health = async (token = adminTok) => {
  const res = await api('GET', '/system/health', { token });
  return { ...res, components: res.json?.data?.components ?? [] };
};
const find = (components, id) => components.find((c) => c.id === id);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A · baseline
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('A · what the deployment reports right now');

const base = await health();
check(base.status === 200, 'A1 · the report loads', `HTTP ${base.status}`);
const services = base.components.filter((c) => c.kind === 'service');
const infra = base.components.filter((c) => c.kind === 'infrastructure');
const caps = base.components.filter((c) => c.kind === 'capability');
check(services.length === 10, 'A1 · every service in the deployment appears', `${services.length}`);
check(infra.length >= 3, 'A1 · infrastructure is derived from their checks', infra.map((c) => c.label).join(', '));
check(caps.length >= 6, 'A1 · capabilities are reported', `${caps.length}`);
check(
  services.every((c) => c.state === 'ready'),
  'A1 · a healthy deployment reports healthy',
  services.filter((c) => c.state !== 'ready').map((c) => `${c.id}:${c.state}`).join(' '),
);

/*
 * ⚠️ Nothing is asserted about Redis, which is in the compose stack and which **no service connects
 * to**. A row saying "Redis · unknown" would be indistinguishable, to a customer, from "Redis ·
 * broken" — and it would be the gateway claiming something is part of the system, which is the one
 * thing the gateway cannot know.
 */
check(find(base.components, 'infra:redis') === undefined, 'A2 · a dependency nothing checks is not listed');
check(
  base.components.every((c) => c.state === 'ready' || (c.detail ?? '').length > 0),
  'A2 · ⚠️ every state except healthy carries a sentence, not just a colour',
);
check(
  services.every((c) => typeof c.latencyMs === 'number' || c.id === 'gateway'),
  'A2 · every probed service reports how long it took',
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B · a stopped service
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nB · stopping a service');

const VICTIM = 'vip-prod-notify-1';
docker('stop', VICTIM);
try {
  await sleep(6_000); // outlive the server-side cache
  const down = await health();
  const notify = find(down.components, 'notify');
  check(notify?.state === 'unreachable', 'B1 · the stopped service reports unavailable', notify?.state);
  /*
   * ⚠️ "fetch failed" is what this reported on the first run — a sentence that adds nothing to the
   * word "Unavailable". The real cause lives one level down in `error.cause`, and it is the
   * difference between "the container is not running" and "the name does not resolve".
   */
  check(
    /ECONN|ENOTFOUND|EHOSTUNREACH|timed out|did not answer/.test(notify?.detail ?? ''),
    'B1 · and says why, in a word an operator can act on',
    notify?.detail,
  );

  const others = down.components.filter((c) => c.kind === 'service' && c.id !== 'notify');
  check(
    others.every((c) => c.state === 'ready'),
    'B2 · every other service is unaffected',
    others.filter((c) => c.state !== 'ready').map((c) => c.id).join(' '),
  );

  /*
   * ⚠️ The assertion this section exists for. A service that did not answer contributes **nothing**
   * to the database's verdict rather than contributing a failure — its silence is already its own
   * row, and counting it twice would turn one outage into two and send someone to the wrong place.
   */
  check(
    find(down.components, 'infra:mongo')?.state === 'ready',
    'B3 · ⚠️ a silent service is not counted as evidence about MongoDB',
    find(down.components, 'infra:mongo')?.state,
  );
} finally {
  docker('start', VICTIM);
}
await sleep(8_000);
const recovered = await health();
check(
  find(recovered.components, 'notify')?.state === 'ready',
  'B4 · and it reports healthy again once restarted',
  find(recovered.components, 'notify')?.state,
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C · liveness is not evidence of health
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nC · ⚠️ why the page is built on /ready and not on /health');

docker('pause', 'vip-prod-mongodb-1');
try {
  await sleep(6_000);

  /*
   * Every service's liveness probe still answers `ok`, because the process is up and its event loop
   * turns. A System Health page built on `/health` would be **entirely green** at this moment, with
   * the platform unable to serve a single tenant request. That is the failure this design exists to
   * prevent, demonstrated rather than asserted.
   */
  const liveness = await Promise.all(
    ['tenant', 'events', 'rules'].map(async (id) => {
      const res = await api('GET', `/${id}/health`, { token: adminTok });
      return { id, status: res.status, body: res.json };
    }),
  );
  check(
    liveness.every((l) => l.status === 200 && l.body?.status === 'ok'),
    'C1 · ⚠️ every liveness probe still answers "ok" with the database paused',
    liveness.map((l) => `${l.id}:${l.body?.status ?? l.status}`).join(' '),
  );

  const broken = await health();
  const brokenServices = broken.components.filter((c) => c.kind === 'service');
  check(
    brokenServices.some((c) => c.state !== 'ready'),
    'C2 · …and the health page does not say healthy',
    brokenServices.map((c) => `${c.id}:${c.state}`).join(' '),
  );
  const mongo = find(broken.components, 'infra:mongo');
  check(
    mongo !== undefined && mongo.state !== 'ready',
    'C2 · MongoDB is not reported healthy while it is paused',
    mongo?.state ?? 'NOT LISTED',
  );
  /*
   * ⚠️ The defect this section found on its first run. Every service timed out, so none of them
   * reported a check — and the MongoDB row **disappeared from the report entirely**. Ten red rows
   * during a total database outage and not one word about the database. The row now survives as
   * `unknown`: "nobody can speak for it" is a different sentence from "it is broken", and claiming
   * `unreachable` would be an inference that sends someone to the wrong place.
   */
  check(
    mongo?.state === 'unknown' && /not answering/.test(mongo.detail ?? ''),
    'C2 · ⚠️ …and the row does not vanish — it says nobody can speak for it',
    mongo ? `${mongo.state}: ${mongo.detail ?? ''}`.slice(0, 90) : 'NOT LISTED',
  );
  console.log(
    `      (observed: ${brokenServices.map((c) => `${c.id}=${c.state}`).join(' ')}${
      mongo ? `, mongo=${mongo.state}` : ', mongo not listed'
    })`,
  );
} finally {
  docker('unpause', 'vip-prod-mongodb-1');
}
await sleep(10_000);
let restored = await health();
if (restored.components.filter((c) => c.kind === 'service').some((c) => c.state !== 'ready')) {
  await sleep(15_000);
  restored = await health();
}
check(
  restored.components.filter((c) => c.kind === 'service').every((c) => c.state === 'ready'),
  'C3 · the deployment recovers on its own once the database returns',
  restored.components.filter((c) => c.state !== 'ready' && c.kind === 'service').map((c) => `${c.id}:${c.state}`).join(' '),
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D · the permission boundary
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nD · who may look');

const operator = await login(OPERATOR);
check(operator.status === 200, 'D0 · the operator account signs in', `HTTP ${operator.status}`);
const asOperator = await health(operator.json.data.accessToken);
check(
  asOperator.status === 200,
  'D1 · ⚠️ an operator may look — they are the ones on shift at 3am',
  `HTTP ${asOperator.status}`,
);

const created = await api('POST', '/identity/users', {
  token: adminTok,
  body: { email: VIEWER.email, password: VIEWER.password, roles: ['viewer'] },
});
if (created.status === 201 || created.status === 200) {
  const viewer = await login(VIEWER);
  const asViewer = await health(viewer.json?.data?.accessToken);
  check(
    asViewer.status === 403,
    'D2 · ⚠️ a viewer may not — infrastructure topology is not theirs to act on or to see',
    `HTTP ${asViewer.status}`,
  );
  console.log(`      (probe account left behind: ${VIEWER.email} — disable it or clean up in mongosh)`);
} else {
  check(false, 'D2 · could not create a viewer probe account', `HTTP ${created.status}`);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E · the cache
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nE · one fan-out, however many viewers');

const first = await health();
const second = await health();
check(
  first.json.data.derivedAt === second.json.data.derivedAt,
  'E1 · two immediate reads share one snapshot',
  first.json.data.derivedAt,
);
await sleep((first.json.data.cacheTtlMs ?? 5000) + 1_000);
const third = await health();
check(
  third.json.data.derivedAt !== first.json.data.derivedAt,
  'E2 · and it is re-derived once the window passes',
  third.json.data.derivedAt,
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// F · latency
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\nF · measured, not assumed');

const samples = [];
for (let i = 0; i < 30; i += 1) {
  const res = await api('GET', '/system/health', { token: adminTok });
  samples.push(res.ms);
}
samples.sort((a, b) => a - b);
const at = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
console.log(
  `  · GET /api/system/health  p50 ${at(50).toFixed(1)} ms · p95 ${at(95).toFixed(1)} ms · max ${samples.at(-1).toFixed(1)} ms (n=30)`,
);
check(at(95) < 2_500, 'F1 · p95 stays inside the probe timeout budget', `${at(95).toFixed(1)} ms`);

console.log(
  `\n${failures === 0 ? '✓ P-6.4 system health: all checks passed' : `✗ ${failures} check(s) failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
