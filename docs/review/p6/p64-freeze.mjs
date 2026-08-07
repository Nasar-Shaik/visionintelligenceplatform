/**
 * P-6.4 · the freeze pass. **Every state, produced.**
 *
 *   node docs/review/p6/p64-freeze.mjs
 *
 * The milestone's claim is that seven states are kept apart and that none of them silently becomes
 * "Healthy". A claim like that is only worth what it can be shown to survive, so this drives each
 * state into existence against the running deployment rather than reasoning about it:
 *
 *   Healthy         baseline
 *   Degraded        MinIO stopped — evidence and media still *answer*, with a failing check
 *   Unavailable     a stopped container
 *   Unknown         MongoDB paused — every reporter blocks, so nobody can speak for the database
 *   Not configured  a throwaway gateway with STREAM_ENABLED=false, beside the real one
 *   Not built       the capability register
 *   Forbidden       a viewer
 *
 * ⚠️ Restores every container it touches, removes the throwaway, deletes its probe account, and
 * verifies the deployment is healthy again before exiting.
 */
import { execFileSync } from 'node:child_process';

const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const VIEWER = { email: `p64f.viewer.${Date.now()}@northgate.demo`, password: 'Probe-Password-2026!' };
const PROBE_GATEWAY = 'vip-p64-probe-gateway';
const PROBE_PORT = 18_080;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
/** Docker calls whose failure is an expected outcome (removing something that may not exist). */
const quiet = (...args) => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

async function api(method, path, { token, body, tenant, base = `${B}/api` } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
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
const login = (creds) => api('POST', '/identity/auth/login', { body: creds, tenant: TENANT });

console.log('\nP-6.4 · freeze pass — every state, produced\n');

const admin = await login(ADMIN);
if (admin.status !== 200) {
  console.error('cannot sign in as the demo administrator', admin.status, admin.json);
  process.exit(1);
}
const tok = admin.json.data.accessToken;
const health = async (token = tok, base) =>
  (await api('GET', '/system/health', base ? { token, base } : { token })).json?.data ?? {
    components: [],
  };
const find = (report, id) => report.components.find((c) => c.id === id);
const states = (report, kind) =>
  report.components.filter((c) => c.kind === kind).map((c) => `${c.id}=${c.state}`).join(' ');

/** Every state seen across the whole run, so the matrix can be asserted as a set at the end. */
const seen = new Set();
const record = (report) => {
  for (const c of report.components) seen.add(c.state);
  return report;
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Healthy and Not built — the baseline
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('1 · baseline');
const base = record(await health());
check(
  base.components.filter((c) => c.kind === 'service').every((c) => c.state === 'ready'),
  '1a · Healthy — every service, from its own readiness report',
);
check(
  base.components.some((c) => c.state === 'not-built'),
  '1b · Not built — what this release does not contain',
  base.components.filter((c) => c.state === 'not-built').map((c) => c.id).join(', '),
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Degraded — a service that answers, with a failing dependency
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n2 · Degraded (MinIO stopped)');
docker('stop', 'vip-prod-minio-1');
try {
  await sleep(7_000);
  const report = record(await health());
  const degraded = report.components.filter((c) => c.kind === 'service' && c.state === 'degraded');
  check(
    degraded.length >= 2,
    '2a · ⚠️ Degraded, not Unavailable — the services answered; their dependency did not',
    degraded.map((c) => c.id).join(', ') || states(report, 'service'),
  );
  check(
    degraded.every((c) => /storage/i.test(c.detail ?? '')),
    '2b · and the reason names the dependency, not the service',
    degraded[0]?.detail?.slice(0, 70),
  );
  const storage = find(report, 'infra:storage');
  check(
    storage?.state === 'unreachable',
    '2c · Unavailable — every service that depends on object storage reports it failing',
    storage?.state,
  );
  check(
    find(report, 'infra:mongo')?.state === 'ready',
    '2d · ⚠️ and MongoDB is untouched — one outage is reported once',
    find(report, 'infra:mongo')?.state,
  );
} finally {
  docker('start', 'vip-prod-minio-1');
}
await sleep(10_000);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Unknown — nobody can speak for it
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n3 · Unknown (MongoDB paused)');
docker('pause', 'vip-prod-mongodb-1');
try {
  await sleep(7_000);
  const report = record(await health());
  const mongo = find(report, 'infra:mongo');
  check(mongo?.state === 'unknown', '3a · Unknown — and the row does not vanish', mongo?.state ?? 'MISSING');
  check(
    mongo?.state !== 'ready',
    '3b · ⚠️ nothing became Healthy by having nobody to contradict it',
  );
} finally {
  docker('unpause', 'vip-prod-mongodb-1');
}
await sleep(12_000);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Not configured — a deployment that did not wire a capability
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n4 · Not configured (a second gateway, real-time delivery off)');
/*
 * ⚠️ A **throwaway gateway beside the real one**, on the same network, rather than reconfiguring the
 * running stack. The state being verified belongs to a deployment's configuration, so a unit test
 * proves the branch and only a differently-configured process proves the deployment reads it — and
 * turning real-time delivery off on the stack the operator is using is not a verification, it is an
 * outage.
 */
quiet('rm', '-f', PROBE_GATEWAY);
const env = Object.fromEntries(
  execFileSync('grep', ['-E', '^(JWT_SECRET|MONGO_USER|MONGO_PASSWORD|REDIS_PASSWORD|CREDENTIAL_ENCRYPTION_KEY|INTERNAL_API_KEY|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD|VIP_PUBLIC_URL)=', '.env.production'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
try {
  docker(
    'run', '-d', '--name', PROBE_GATEWAY, '--network', 'vip-prod_default',
    '-p', `${PROBE_PORT}:8080`,
    '-e', 'NODE_ENV=production', '-e', 'LOG_LEVEL=error', '-e', 'PORT=8080',
    '-e', 'SERVICE_NAME=gateway', '-e', 'STREAM_ENABLED=false',
    '-e', `JWT_SECRET=${env.JWT_SECRET}`,
    '-e', `CREDENTIAL_ENCRYPTION_KEY=${env.CREDENTIAL_ENCRYPTION_KEY}`,
    '-e', `INTERNAL_API_KEY=${env.INTERNAL_API_KEY}`,
    '-e', `MONGO_URI=mongodb://${env.MONGO_USER}:${env.MONGO_PASSWORD}@mongodb:27017/vip?authSource=admin`,
    '-e', `REDIS_URL=redis://:${env.REDIS_PASSWORD}@redis:6379`,
    '-e', 'NATS_URL=nats://nats:4222',
    '-e', 'IDENTITY_URL=http://identity:8089', '-e', 'TENANT_URL=http://tenant:8081',
    '-e', 'CAMERA_URL=http://camera:8082', '-e', 'MEDIA_URL=http://media:8083',
    '-e', 'EVENTS_URL=http://events:8084', '-e', 'RULES_URL=http://rules:8086',
    '-e', 'WORKFLOW_URL=http://workflow:8087', '-e', 'NOTIFY_URL=http://notify:8088',
    '-e', 'EVIDENCE_URL=http://evidence:8090',
    '-e', 'S3_ENDPOINT=http://minio:9000', '-e', `S3_PUBLIC_ENDPOINT=${env.VIP_PUBLIC_URL}`,
    '-e', `AWS_ACCESS_KEY_ID=${env.MINIO_ROOT_USER}`,
    '-e', `AWS_SECRET_ACCESS_KEY=${env.MINIO_ROOT_PASSWORD}`,
    'vip/gateway:local',
  );
  await sleep(6_000);
  const report = record(await health(tok, `http://localhost:${PROBE_PORT}/api`));
  const stream = find(report, 'realtime-stream');
  check(
    stream?.state === 'not-configured',
    '4a · Not configured — a deployment with real-time delivery switched off',
    stream?.state,
  );
  check(
    /STREAM_ENABLED/.test(stream?.detail ?? ''),
    '4b · and the reason names the setting an administrator has to change',
    stream?.detail?.slice(0, 70),
  );
  /* ⚠️ And the same process reports the real services healthy — the probe is not a broken gateway. */
  check(
    report.components.filter((c) => c.kind === 'service' && c.id !== 'gateway').every((c) => c.state === 'ready'),
    '4c · ⚠️ while everything else it can see is still Healthy',
  );
} finally {
  quiet('rm', '-f', PROBE_GATEWAY);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Forbidden
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n5 · Forbidden');
const created = await api('POST', '/identity/users', {
  token: tok,
  body: { email: VIEWER.email, password: VIEWER.password, roles: ['viewer'] },
});
check(created.status === 201 || created.status === 200, '5a · a viewer probe account exists', `HTTP ${created.status}`);
const viewer = await login(VIEWER);
const refused = await api('GET', '/system/health', { token: viewer.json?.data?.accessToken });
check(refused.status === 403, '5b · Forbidden — refused at the gateway, not hidden in the UI', `HTTP ${refused.status}`);
seen.add('forbidden');

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · the matrix
// ════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n6 · the matrix');
/*
 * ⚠️ `unknown` for a **service** is the one state not produced here, and it is not quietly omitted:
 * it means a process answered on the port with something that is not a readiness report. Producing
 * that in the deployment means deliberately serving a broken service, which is a fixture rather than
 * a verification. It is covered by a gateway unit test, and it is the state most likely to appear
 * during a partial upgrade.
 */
for (const state of ['ready', 'degraded', 'unreachable', 'unknown', 'not-configured', 'not-built', 'forbidden']) {
  check(seen.has(state), `6 · ${state} was produced against the deployment`, seen.has(state) ? '' : 'never observed');
}

// ── restore ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n· restoring');
docker('exec', 'vip-prod-mongodb-1', 'mongosh', '-u', env.MONGO_USER, '-p', env.MONGO_PASSWORD,
  '--authenticationDatabase', 'admin', '--quiet', '--eval',
  'db.getSiblingDB("vip").users.deleteMany({ email: /^p64f\\./ })');
let final = await health();
for (let i = 0; i < 6 && final.components.filter((c) => c.kind === 'service').some((c) => c.state !== 'ready'); i += 1) {
  await sleep(6_000);
  final = await health();
}
check(
  final.components.filter((c) => c.kind !== 'capability').every((c) => c.state === 'ready'),
  '· the deployment is healthy again',
  states(final, 'service'),
);
check(quiet('ps', '-a', '--filter', `name=${PROBE_GATEWAY}`, '--format', '{{.Names}}') === '', '· the throwaway gateway is gone');

console.log(`\n${failures === 0 ? '✓ P-6.4 freeze pass: all checks passed' : `✗ ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
