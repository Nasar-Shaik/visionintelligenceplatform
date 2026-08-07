/**
 * P-9 shared verification helpers.
 *
 * Every P-9 script talks to the **deployed** stack over the proxy, never to a service port and never
 * to a dev server. [Deploy before declaring done](../../project/KNOWN_ISSUES.md): P-5.8 found that
 * playback had never worked outside `pnpm dev`, and the fix class is "the verification runs where
 * the product runs".
 *
 * ### Two rules this module exists to enforce
 *
 * **1 · Re-authenticate.** `JWT_ACCESS_TTL` is 15 minutes. The P-8.7 platform soak authenticated
 * once, ran 6.9 hours, and recorded `?? 0` for 64 of its 67 samples because every call after minute
 * 17 returned 401 — reporting "0 incidents" while cleanup resolved 58 of them. `ensureAuth()` reads
 * the token's own `exp` rather than trusting a constant.
 *
 * **2 · An absent answer is not a zero** ([ADR-0039](../../adr/ADR-0039-absent-is-null.md)). `read()`
 * returns `{ ok: false }` when the control plane did not answer, so a caller cannot mistake silence
 * for a measurement. The same defect, in the same instrument, twice, is what
 * [absence-hides-defects](../../project/KNOWN_LIMITATIONS.md) is about.
 */
import { execFileSync } from 'node:child_process';

export const ROOT = new URL('../../..', import.meta.url).pathname;
export const BASE = process.env.BASE ?? 'https://localhost';
export const TENANT = process.env.TENANT ?? 'tnt_demo_retail';
export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'security.manager@northgate.demo',
  password: process.env.ADMIN_PASSWORD ?? 'Vip-Demo-2026!',
};
export const FIXTURE = 'vip-rtsp-fixture';
export const NETWORK = 'vip-prod_default';
/** Every camera this milestone creates carries it, so cleanup can never guess. */
export const TAG = 'p9-fixture';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/* ── shell ────────────────────────────────────────────────────────────────────────────────────── */

export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

/** Same, but a non-zero exit is an answer rather than an exception. */
export const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── reporting ────────────────────────────────────────────────────────────────────────────────── */

export const state = { failures: 0, checks: 0, findings: [], authoritative: true };

export function check(ok, label, detail = '') {
  state.checks += 1;
  if (!ok) state.failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/** Something true and worth recording that is not a pass/fail. */
export function finding(label, detail) {
  state.findings.push({ label, detail });
  console.log(`  ⚠️ ${label} — ${detail}`);
}

export function heading(text) {
  console.log(`\n${text}`);
}

/**
 * ⚠️ `[].every()` is `true` (verification rule 4). A check over a collection must assert the
 * collection is non-empty, or an empty result set passes every assertion made about it.
 */
export const guard = (xs, ok) => Array.isArray(xs) && xs.length > 0 && ok;

export function exit(name) {
  const ok = state.failures === 0;
  console.log(
    `\n${ok ? '✅' : '❌'} ${name}: ${state.checks - state.failures}/${state.checks} checks` +
      (state.findings.length ? ` · ${state.findings.length} finding(s)` : '') +
      (state.authoritative ? '' : ' · ⚠️ NOT AUTHORITATIVE (dirty tree)'),
  );
  process.exit(ok ? 0 : 1);
}

/* ── api ──────────────────────────────────────────────────────────────────────────────────────── */

export async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json — `text` is the evidence */
  }
  return { status: res.status, json, text };
}

/**
 * ⚠️ MUTATED in place, never reassigned. Callers and closures hold this object reference; the P-8.7
 * token repair reassigned it and left `restoreCapacity()` holding an expired token, which silently
 * reintroduced a capacity leak the previous run had just fixed.
 */
export const H = {};
let tokenExpiresAt = 0;

export async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  const token = r.json?.data?.accessToken;
  if (!token) throw new Error(`login failed (${r.status}): ${r.text.slice(0, 200)}`);
  H.authorization = `Bearer ${token}`;
  H['content-type'] = 'application/json';
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    tokenExpiresAt = Number(claims.exp) * 1000;
  } catch {
    tokenExpiresAt = Date.now() + 15 * 60_000;
  }
}

/** Refresh two minutes before the token's own expiry, not on a guessed interval. */
export async function ensureAuth() {
  if (Date.now() > tokenExpiresAt - 120_000) await login();
}

/**
 * A read that distinguishes "the service said zero" from "the service did not answer".
 * ⛔ Never collapse this to `?? 0` at a call site.
 */
export async function read(path) {
  await ensureAuth();
  const res = await api(path, { headers: H });
  const ok = res.status >= 200 && res.status < 300 && res.json?.data !== undefined;
  return { ok, data: ok ? res.json.data : undefined, status: res.status };
}

/* ── fixture ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Start the RTSP fixture **and prove it is running**.
 *
 * ⛔ `docker run -d` returns 0 for a container that starts and exits immediately, which is exactly
 * what mediamtx does when it rejects its config (`json: unknown field "…pathRegexp"`, found in
 * A4.5). The first version of this helper returned happily, and the ladder above it then reported
 * `0/4 cameras decoded` — a plausible measurement of a fixture that did not exist.
 *
 * ⚠️ That is [absence-hides-defects](../../project/KNOWN_LIMITATIONS.md): when a check reports an
 * absence, ask what else produces it. A number moving the wrong way is worse than no number,
 * because it gets believed.
 */
export function startFixture(config = 'rtsp-fixture.yml') {
  shq('docker', ['rm', '-f', FIXTURE]);
  sh('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    FIXTURE,
    '--network',
    NETWORK,
    '-v',
    `${ROOT}infra/docker/fixtures/${config}:/mediamtx.yml:ro`,
    '-v',
    `${ROOT}infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  const running = shq('docker', ['inspect', FIXTURE, '--format', '{{.State.Running}}']);
  if (running !== 'true') {
    const why = shq('docker', ['logs', FIXTURE]) || '(no logs — the container is already gone)';
    throw new Error(`the RTSP fixture (${config}) did not stay up:\n${why.slice(0, 400)}`);
  }
}

export function stopFixture() {
  shq('docker', ['rm', '-f', FIXTURE]);
}

/* ── camera lifecycle ─────────────────────────────────────────────────────────────────────────── */

export async function defaultZoneId() {
  const r = await read('/camera/cameras?limit=1');
  return listOf(r.data)[0]?.zoneId;
}

/** Tolerates both `{ cameras: [...] }` and a bare array without inventing an empty one. */
export const listOf = (data) =>
  Array.isArray(data) ? data : Array.isArray(data?.cameras) ? data.cameras : [];

export async function createCamera({ name, streamUrl, credentials, zoneId, protocol = 'rtsp' }) {
  await ensureAuth();
  const res = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name,
      protocol,
      streamUrl,
      ...(credentials ? { credentials } : {}),
      metadata: { tags: [TAG] },
    }),
  });
  return { id: res.json?.data?.id, status: res.status, text: res.text };
}

/** Removes every camera this milestone tagged. Idempotent, and safe to run first. */
export async function cleanup(quiet = false) {
  await login();
  const r = await read(`/camera/cameras?limit=200&search=${TAG}`);
  const cams = listOf(r.data).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    /* ⚠️ No `content-type` on a bodyless DELETE: Fastify refuses `application/json` with an empty
       body, and the P-8 cleanup reported "removed 17" while deleting none. */
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  if (!quiet) console.log(`  ✓ cleanup removed ${cams.length} camera(s)`);
  return cams.length;
}

/* ── deployment integrity ─────────────────────────────────────────────────────────────────────── */

export const PROD_SERVICES = [
  'identity',
  'tenant',
  'camera',
  'media',
  'events',
  'rules',
  'workflow',
  'notify',
  'evidence',
  'gateway',
  'inference',
];

/**
 * The same integrity probe the platform soak runs, as a function rather than as a copy
 * ([verification rule 8](../SOAK_REPORT.md): repair belongs in the shared helper).
 *
 * ⚠️ It asserts the **working tree** is clean as well as the containers being healthy. A
 * verification that passes against uncommitted source has measured something nobody can redeploy —
 * which is the whole of [deploy-before-declaring-done](../../project/KNOWN_ISSUES.md).
 *
 * ⚠️ `P9_ALLOW_DIRTY=1` downgrades the tree check to a finding, for the case this file was written
 * for: running a task's verification during the working day, before its own commit exists. It is a
 * deliberately loud escape — `authoritative: false` propagates into the summary line, so a run
 * recorded as evidence can never be mistaken for one made against committed source.
 */
export function deploymentIntegrity() {
  const dirty = shq('git', ['-C', ROOT, 'status', '--porcelain']);
  const unhealthy = PROD_SERVICES.filter((s) => {
    const status = shq('docker', [
      'inspect',
      `vip-prod-${s}-1`,
      '--format',
      '{{.State.Health.Status}}{{.State.Status}}',
    ]);
    return !/healthy|running/.test(status);
  });
  return {
    dirty: dirty ? dirty.split('\n') : [],
    unhealthy,
    allowDirty: process.env.P9_ALLOW_DIRTY === '1',
  };
}

/** The integrity probe as a pair of checks, so no script writes its own version of them. */
export function checkIntegrity() {
  const { dirty, unhealthy, allowDirty } = deploymentIntegrity();
  check(unhealthy.length === 0, 'every production service is healthy', unhealthy.join(', '));
  if (dirty.length > 0 && allowDirty) {
    state.authoritative = false;
    finding(
      `the working tree has ${dirty.length} uncommitted path(s)`,
      'P9_ALLOW_DIRTY=1 — this run is NOT authoritative evidence',
    );
  } else {
    check(dirty.length === 0, 'the working tree is clean', dirty.slice(0, 4).join(' · '));
  }
  return { dirty, unhealthy };
}

/** One container's effective value for an environment variable, as the kernel sees it. */
export function containerEnv(container, name) {
  const raw = shq('docker', [
    'inspect',
    container,
    '--format',
    `{{range .Config.Env}}{{println .}}{{end}}`,
  ]);
  for (const line of raw.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
