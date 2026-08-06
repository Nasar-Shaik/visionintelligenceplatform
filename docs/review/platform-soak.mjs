/**
 * **The permanent platform soak harness** — does the whole platform stay correct over hours?
 *
 *   node docs/review/platform-soak.mjs --list
 *   MINUTES=390 node docs/review/platform-soak.mjs --profile retail-loitering
 *   MINUTES=15  node docs/review/platform-soak.mjs --profile baseline        # smoke test
 *   node docs/review/platform-soak.mjs clean                                 # after an interruption
 *
 * ### What this is, and what `inference-soak.mjs` is
 *
 * `docs/review/p8/inference-soak.mjs` asks whether the **runtime** stays stable — memory, p95, queue,
 * detection consistency, across media and inference. It is the right instrument for a milestone gate
 * and it is deliberately narrow.
 *
 * This asks whether the **platform** stays stable: all eleven services, five infrastructure
 * containers, and the paths between them. It is designed to be reused by every future milestone
 * rather than rewritten per capability — the workload lives in `soak-profiles.mjs`, this file never
 * learns what a capability is called.
 *
 * The failures it exists to catch are the ones only hours reveal, and that no ladder can see:
 *
 * - a file descriptor leaked per reconnect, invisible until the limit
 * - an event-loop lag that creeps as timers accumulate
 * - a broker that reconnects cleanly nine times and wrongly the tenth
 * - an assignment plan that churns slowly against itself
 * - a heap that grows only in the service nobody was watching
 * - a log that floods at 3am and fills the disk before anybody is awake
 *
 * ### ⚠️ Evidence is flushed after EVERY sample, not at the end
 *
 * `inference-soak.mjs` writes once, on completion. Over fifteen minutes that is a fair trade. Over
 * seven hours it means an interruption at hour six destroys six hours of evidence, and a soak is the
 * one verification that cannot be cheaply re-run. Every sample is written as it is taken, so an
 * interrupted run is a **shorter run rather than a lost night**.
 *
 * ### ⚠️ Hard failures abort early rather than running out the clock
 *
 * A container that died at minute 40 does not become more informative by minute 390, and six more
 * hours of measuring a degraded stack produces numbers that look like findings and are not. The run
 * stops, writes what it has, and names the condition that tripped.
 *
 * ### ⚠️ Deployment integrity, continuously — and what that claim is worth
 *
 * The FULL check (`docs/review/p6/deployment-integrity.mjs`, ~60 s, byte-for-byte across every
 * service, package, bundle and the Python runtime) runs **once before and once after**. Running it
 * every five minutes would cost an hour of the night to re-prove something that can only change if
 * somebody rebuilds.
 *
 * What runs every sample is a **cheap continuous probe**: the working tree is still clean, and every
 * container is still running the image id it started with. That is strictly weaker than the full
 * check and the report must say so rather than implying seven hours of byte-level verification.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { raiseRuntimeCapacity, tryAssignCameras } from './p8/_assign.mjs';
import { listProfiles, lookupProfile } from './soak-profiles.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = process.env.TENANT ?? 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: 'Vip-Demo-2026!' };
const FIXTURE = 'vip-rtsp-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'platform-soak';

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const PROFILE_ID = argOf('--profile', process.env.PROFILE ?? 'retail-loitering');
const MINUTES = Number(process.env.MINUTES ?? 390);
const SAMPLE_SECONDS = Number(process.env.SAMPLE_SECONDS ?? 300);
const WARMUP_SECONDS = Number(process.env.WARMUP_SECONDS ?? 120);
/**
 * ⚠️ **The default writes OUTSIDE the repository, and that is not a detail.**
 *
 * Rule 7 of the Definition of Done: no stage writes a tracked file. This harness is stricter than
 * that by necessity — it *asserts* the working tree stays clean for the whole run, so a default that
 * wrote its own evidence into `docs/review/` would dirty the tree at the first sample and abort the
 * run it was taking. The instrument would have failed the platform for the instrument's own output.
 *
 * The nightly stage passes `OUT` pointing into the run directory; interactive runs land in tmp.
 */
const OUT = process.env.OUT ?? join(tmpdir(), `platform-soak-${PROFILE_ID}.json`);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** Every Node service exposes nodejs_* and process_* — heap, fds, handles, event-loop lag. */
const NODE_SERVICES = {
  identity: 8089,
  tenant: 8081,
  camera: 8082,
  media: 8083,
  events: 8084,
  rules: 8086,
  workflow: 8087,
  notify: 8088,
  evidence: 8090,
  gateway: 8080,
};
const RUNTIME = 'vip-prod-inference-1';
const INFRA = ['mongodb', 'nats', 'redis', 'minio', 'proxy'];
const ALL_CONTAINERS = [
  ...Object.keys(NODE_SERVICES).map((s) => `vip-prod-${s}-1`),
  RUNTIME,
  ...INFRA.map((s) => `vip-prod-${s}-1`),
];

let failures = 0;
const findings = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const finding = (label, detail) => {
  console.log(`  ⚠️ ${label} — ${detail}`);
  findings.push({ label, detail });
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts }).trim();
const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
/** ⚠️ Rule 4 of the Definition of Done: `[].every(...)` is `true`. Every aggregate is guarded. */
const guard = (xs, ok) => xs.length > 0 && ok;

/* ── scraping ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Parse a Prometheus exposition into `{ name: value }`, summing across label sets.
 *
 * ⚠️ Summing matters. `rules_*` carries `{service="rules"}` on every series, and a benchmark in this
 * repository once read every rule latency as "not measured" because its regex rejected the label. A
 * parser that only accepts bare names reports zero and calls it a measurement.
 */
function parseProm(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^([a-z_][a-z0-9_]*)(\{[^}]*\})?\s+([0-9.eE+-]+)$/);
    if (!m) continue;
    const [, name, labels = '', value] = m;
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    const le = labels.match(/le="([^"]*)"/);
    const key = le ? `${name}::${le[1]}` : name;
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

const scrapeNode = (svc, port) =>
  parseProm(
    shq('docker', ['exec', `vip-prod-${svc}-1`, 'sh', '-c', `curl -s localhost:${port}/metrics`]),
  );

const scrapeRuntime = () =>
  parseProm(
    shq('docker', [
      'exec',
      RUNTIME,
      'python',
      '-c',
      "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/metrics',timeout=10).read().decode())",
    ]),
  );

/** One `docker stats` call for every container — 16 separate calls would cost ~35 s per sample. */
function allStats() {
  const raw = shq('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.PIDs}}',
    ...ALL_CONTAINERS,
  ]);
  const toMb = (s) => {
    const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!m) return 0;
    const v = Number(m[1]);
    const u = (m[2] ?? '').toLowerCase();
    return u.startsWith('g')
      ? v * 1024
      : u.startsWith('k')
        ? v / 1024
        : u.startsWith('b')
          ? v / 1048576
          : v;
  };
  const out = {};
  for (const line of raw.split('\n')) {
    const [name, cpu = '', mem = '', pids = ''] = line.split('|');
    if (!name) continue;
    out[name] = {
      cpu: num(cpu.replace('%', '')),
      mem: toMb((mem.split('/')[0] ?? '').trim()),
      pids: num(pids),
    };
  }
  return out;
}

/** Status, health, restart count and the image id each container is actually running. */
function allHealth() {
  const raw = shq('docker', [
    'inspect',
    '--format',
    '{{.Name}}|{{.State.Status}}|{{.RestartCount}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
    ...ALL_CONTAINERS,
  ]);
  const out = {};
  for (const line of raw.split('\n')) {
    const [name, status, restarts, image, health] = line.split('|');
    if (!name) continue;
    out[name.replace(/^\//, '')] = {
      status,
      restarts: num(restarts),
      image,
      health: health ?? 'none',
    };
  }
  return out;
}

/** Log volume, error volume and warning volume per container since the previous sample. */
function logStats(sinceSeconds) {
  const out = {};
  for (const c of ALL_CONTAINERS) {
    const text = shq('docker', ['logs', '--since', `${sinceSeconds}s`, c]);
    const lines = text === '' ? [] : text.split('\n');
    /*
     * ⚠️ Deliberately broad, and matched against the whole line. A soak that under-counts exceptions
     * is worse than one that over-counts: the second produces a finding somebody reads, the first
     * produces a green night. Pino levels 50/60 are error/fatal; 40 is warn.
     */
    const errors = lines.filter((l) =>
      /unhandledrejection|uncaughtexception|unhandled rejection|uncaught exception|fatal|segfault|traceback|"level":50|"level":60|\bERROR\b/i.test(
        l,
      ),
    );
    const warnings = lines.filter((l) => /"level":40|\bWARN(ING)?\b/i.test(l));
    out[c] = {
      lines: lines.length,
      errors: errors.length,
      warnings: warnings.length,
      sample: errors.slice(0, 2),
    };
  }
  return out;
}

/** Redis: deployed, credentialed, health-checked — and nothing consumes it. Measure that rather than assume it. */
function redisState() {
  const one = (section) =>
    shq('docker', [
      'exec',
      'vip-prod-redis-1',
      'sh',
      '-c',
      `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO ${section} 2>/dev/null`,
    ]);
  const mem = one('memory');
  const clients = one('clients');
  const keys = shq('docker', [
    'exec',
    'vip-prod-redis-1',
    'sh',
    '-c',
    'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DBSIZE 2>/dev/null',
  ]);
  return {
    usedMemoryMb: num((mem.match(/used_memory:(\d+)/) ?? [])[1]) / 1048576,
    keys: num((keys.match(/(\d+)/) ?? [])[1]),
    connectedClients: num((clients.match(/connected_clients:(\d+)/) ?? [])[1]),
  };
}

/** Disk: the filesystem the Docker volumes live on. */
function diskUsedKb() {
  const df = shq('docker', ['run', '--rm', '-v', '/:/host:ro', 'alpine', 'df', '-k', '/host']);
  return num((df.match(/\s(\d+)\s+\d+%/) ?? [])[1]);
}

/** Clock drift between the host and a container — timer accumulation shows here first. */
function clockDriftSeconds() {
  const host = Math.floor(Date.now() / 1000);
  const inC = num(shq('docker', ['exec', 'vip-prod-events-1', 'date', '+%s']));
  return inC === 0 ? null : inC - host;
}

/**
 * The cheap continuous integrity probe. ⚠️ **Strictly weaker than the full check** — it proves the
 * tree has not changed and no container has been swapped underneath the run, not that every byte
 * matches. The full check runs once before and once after.
 */
function integrityProbe(baselineImages) {
  const dirty = shq('git', ['-C', ROOT, 'status', '--porcelain']);
  const health = allHealth();
  const swapped = Object.entries(health)
    .filter(([k, h]) => baselineImages[k] !== undefined && h.image !== baselineImages[k])
    .map(([k]) => k);
  return {
    treeClean: dirty === '',
    dirtyFiles: dirty === '' ? 0 : dirty.split('\n').length,
    imagesSwapped: swapped,
  };
}

function fullIntegrity(label) {
  console.log(`\n  running the FULL deployment integrity check (${label})`);
  try {
    const out = sh('node', [`${ROOT}/docs/review/p6/deployment-integrity.mjs`], { cwd: ROOT });
    const last = out.split('\n').filter(Boolean).pop() ?? '';
    console.log(`  ${last}`);
    return { ok: /^✓/.test(last), line: last };
  } catch (e) {
    const out = String(e.stdout ?? e.message);
    const last = out.split('\n').filter(Boolean).pop() ?? 'integrity check failed';
    console.log(`  ✗ ${last}`);
    return { ok: false, line: last };
  }
}

/* ── API ──────────────────────────────────────────────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const res = await fetch(`${B}/api${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

let H = {};
async function login() {
  const r = await api('/identity/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify(ADMIN),
  });
  const token = r.json?.data?.accessToken;
  if (token === undefined)
    throw new Error(`login failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

const listOf = (payload) =>
  payload?.items ?? payload?.incidents ?? payload?.cameras ?? payload ?? [];

/**
 * Collect the items created since `sinceIso`, walking keyset pages newest-first.
 *
 * ⚠️ **This exists because the obvious thing is wrong, and the smoke test proved it twice.** Both
 * `/workflow/incidents` and `/media/recordings` are keyset-paginated with a `nextCursor` and **no
 * total**. Asking for `?limit=N` and taking `.length` measures the page cap, not the collection: the
 * smoke run reported "200 incidents before, 200 after (+0)" because 200 *was* the limit, and
 * "1/5 samples produced new segments" because the 50-item page saturated after the first sample.
 * Both numbers were plausible and both were describing the query rather than the platform.
 *
 * The same defect in two places is the shape rule 8 of the Definition of Done is about, so the repair
 * is a shared helper rather than two local patches. Both callers now measure **time**, which is what
 * they actually mean, and no page cap can silently bound it.
 */
async function collectSince(path, sinceIso, opts = {}) {
  const { pageSize = 50, maxPages = 20, timeField = 'createdAt' } = opts;
  const since = Date.parse(sinceIso);
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const q = `${path}${sep}limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api(q, { headers: H });
    const items = listOf(res.json?.data);
    if (items.length === 0) break;
    let sawOlder = false;
    for (const it of items) {
      const t = Date.parse(it[timeField] ?? '');
      if (Number.isFinite(t) && t <= since) {
        sawOlder = true;
        continue;
      }
      out.push(it);
    }
    cursor = res.json?.data?.nextCursor;
    /* Newest-first: the first page carrying anything older than the cut-off is the last one needed. */
    if (sawOlder || cursor === undefined || cursor === null) break;
  }
  return out;
}

/**
 * Remove everything this run created.
 *
 * ⚠️ Incidents are **acknowledged and resolved with a note, never deleted**. They are audit records,
 * and a verification that deletes them teaches the platform's own history to lie. Same rule
 * `rule-replay.mjs` follows.
 */
async function cleanup(quiet = false) {
  await login();
  let closed = 0;
  const inc = await api('/workflow/incidents?limit=200', { headers: H });
  for (const i of listOf(inc.json?.data)) {
    const mine = `${i.title ?? ''} ${i.source?.ruleName ?? ''}`.includes(TAG);
    if (!mine) continue;
    if (['resolved', 'closed', 'dismissed', 'archived'].includes(i.status)) continue;
    await api(`/workflow/incidents/${i.id}/ack`, { method: 'POST', headers: H, body: '{}' });
    const r = await api(`/workflow/incidents/${i.id}/resolve`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        note: `Closed by ${TAG}: verification instrument, not a real incident.`,
      }),
    });
    if (r.status === 200) closed += 1;
  }
  let removedRules = 0;
  for (const r of listOf((await api('/rules/rules?limit=200', { headers: H })).json?.data)) {
    if (!(r.name ?? '').includes(TAG)) continue;
    await api(`/rules/rules/${r.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
    removedRules += 1;
  }
  const cams = listOf(
    (await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H })).json?.data,
  ).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet)
    console.log(
      `\ncleanup: ${cams.length} camera(s), ${removedRules} rule(s), ${closed} incident(s) resolved\n`,
    );
  return { cameras: cams.length, rules: removedRules, incidents: closed };
}

/* ── entry points that are not a run ──────────────────────────────────────────────────────────── */

if (process.argv.includes('--list')) {
  console.log('\nsoak profiles\n');
  for (const p of listProfiles()) {
    console.log(`  ${p.status === 'available' ? '✅' : '⛔'} ${p.id.padEnd(18)} ${p.title}`);
    if (p.blockedBy)
      console.log(`     ⚠️ blocked by: ${p.blockedBy.replace(/\s+/g, ' ').slice(0, 150)}…`);
  }
  console.log('');
  process.exit(0);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

const profile = lookupProfile(PROFILE_ID);
if (profile === undefined) {
  console.error(`\n⛔ unknown profile "${PROFILE_ID}". Run --list to see them.\n`);
  process.exit(2);
}
if (profile.status !== 'available') {
  console.error(`\n⛔ profile "${profile.id}" (${profile.title}) cannot run yet.\n`);
  console.error(`   blocked by: ${profile.blockedBy}\n`);
  console.error(
    `   ⚠️ This refusal is the point. A soak that ran anyway would report a green night`,
  );
  console.error(
    `      against a workload that exercises nothing — which is how a capability becomes`,
  );
  console.error(`      "configurable and unverified" (L-56).\n`);
  process.exit(2);
}

/* ── setup ────────────────────────────────────────────────────────────────────────────────────── */

const startedAt = new Date();
const commit = shq('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
console.log(`\nPlatform soak · profile "${profile.id}" (${profile.title})`);
console.log(`${profile.cameras} cameras · ${MINUTES} minutes · ${SAMPLE_SECONDS}s cadence`);
console.log(`commit ${commit.slice(0, 8)} · started ${startedAt.toISOString()}\n`);

const samples = [];
let restoreCapacity = async () => {};
let aborted = null;
const cameraIds = [];
const zoneIds = [];
const ruleIds = [];
let integrityBefore = null;
let integrityAfter = null;
let incidentsAtStart = 0;
let incidentsAtEnd = 0;

const flush = (extra = {}) =>
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        profile: { id: profile.id, title: profile.title, requires: profile.requires },
        commit,
        cameras: profile.cameras,
        requestedMinutes: MINUTES,
        sampleSeconds: SAMPLE_SECONDS,
        startedAt: startedAt.toISOString(),
        aborted,
        integrityBefore,
        integrityAfter,
        samples,
        ...extra,
      },
      null,
      2,
    ),
  );

try {
  integrityBefore = fullIntegrity('before the run');
  if (!integrityBefore.ok) {
    throw new Error(`deployment integrity is not green before the run: ${integrityBefore.line}`);
  }

  await login();
  await cleanup(true);

  console.log('\nsetup');
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
    `${ROOT}/infra/docker/fixtures/rtsp-fixture.yml:/mediamtx.yml:ro`,
    '-v',
    `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
    'bluenviron/mediamtx:latest-ffmpeg',
  ]);
  await sleep(4000);
  console.log('  ✓ RTSP fixture running');

  restoreCapacity = await raiseRuntimeCapacity(api, H, profile.cameras + 4);

  const hierarchyZone = listOf((await api('/camera/cameras?limit=1', { headers: H })).json?.data)[0]
    ?.zoneId;
  for (let i = 1; i <= profile.cameras; i += 1) {
    const made = await api('/camera/cameras', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        zoneId: hierarchyZone,
        name: `${TAG} ${profile.id} ${String(i).padStart(2, '0')}`,
        protocol: 'rtsp',
        /* ⚠️ A distinct fixture path per camera. Pointing every camera at one path means one stream,
           and the soak measures a single camera while reporting four — the P-8.6 ladder defect. */
        streamUrl: `rtsp://${FIXTURE}:8554/${profile.fixture(i)}`,
        metadata: { tags: [TAG] },
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined)
      throw new Error(`camera ${i} was not created: ${made.text.slice(0, 200)}`);
    cameraIds.push(id);
    await api(`/media/streams/${id}/start`, { method: 'POST', headers: H, body: '{}' });
  }
  const assign = await tryAssignCameras(api, H, cameraIds, { settleMs: 12_000 });
  if (!assign.ok) throw new Error(`assignment refused at setup: ${assign.reason}`);
  console.log(`  ✓ ${cameraIds.length} cameras streaming and assigned`);

  for (const z of profile.zones({ cameraIds, tag: TAG })) {
    const made = await api('/camera/zones', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        cameraId: cameraIds[0],
        name: `${TAG} ${z.name}`,
        kind: z.kind,
        shape: z.shape,
        geometry: z.geometry,
        purpose: 'verification',
        enabled: true,
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined)
      throw new Error(`zone "${z.name}" was not created: ${made.text.slice(0, 200)}`);
    zoneIds.push(id);
  }
  if (zoneIds.length > 0) console.log(`  ✓ ${zoneIds.length} detection zone(s) created`);

  for (const r of profile.rules({ cameraIds, zoneIds, tag: TAG })) {
    const made = await api('/rules/rules', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        ...r,
        name: `${TAG} ${profile.id} ${r.name}`,
        description: `Verification instrument. Created and removed by docs/review/platform-soak.mjs (profile ${profile.id}).`,
      }),
    });
    const id = made.json?.data?.id;
    if (id === undefined)
      throw new Error(`rule "${r.name}" was not created: ${made.text.slice(0, 200)}`);
    const enabled = await api(`/rules/rules/${id}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ lifecycle: 'enabled' }),
    });
    if (enabled.json?.data?.lifecycle !== 'enabled') {
      throw new Error(`rule "${r.name}" did not enable: ${enabled.text.slice(0, 200)}`);
    }
    ruleIds.push(id);
  }
  console.log(`  ✓ ${ruleIds.length} rule(s) enabled`);

  console.log(`\nwarming up for ${WARMUP_SECONDS}s before the first sample\n`);
  await sleep(WARMUP_SECONDS * 1000);

  /* ── the long middle ────────────────────────────────────────────────────────────────────────── */

  const baselineHealth = allHealth();
  const baselineImages = Object.fromEntries(
    Object.entries(baselineHealth).map(([k, v]) => [k, v.image]),
  );
  /*
   * ⚠️ `incidentsAtStart` is a MARK IN TIME, not a count. The incidents list has no total and is
   * keyset-paginated, so "how many exist" is not a question one request answers — but "how many
   * appeared since this instant" is, and it is the one this run actually means.
   */
  const runBeganIso = new Date().toISOString();
  incidentsAtStart = 0;

  let prev = {
    node: Object.fromEntries(Object.entries(NODE_SERVICES).map(([s, p]) => [s, scrapeNode(s, p)])),
    runtime: scrapeRuntime(),
    at: Date.now(),
    atIso: runBeganIso,
  };

  const totalSamples = Math.floor((MINUTES * 60) / SAMPLE_SECONDS);
  let silentStreak = 0;

  for (let n = 1; n <= totalSamples; n += 1) {
    await sleep(SAMPLE_SECONDS * 1000);

    const node = Object.fromEntries(
      Object.entries(NODE_SERVICES).map(([s, p]) => [s, scrapeNode(s, p)]),
    );
    const runtime = scrapeRuntime();
    const stats = allStats();
    const health = allHealth();
    const elapsedS = (Date.now() - prev.at) / 1000;
    const logs = logStats(Math.ceil(elapsedS) + 5);
    const integrity = integrityProbe(baselineImages);

    const d = (svc, key) => num(node[svc]?.[key]) - num(prev.node[svc]?.[key]);
    const dr = (key) => num(runtime[key]) - num(prev.runtime[key]);
    const m = node.media ?? {};
    const c = node.camera ?? {};

    /*
     * Camera health, reconnects and recording continuity — per camera, from the supervisor.
     *
     * ⚠️ **Scoped to the cameras this run created.** The smoke run asserted across the whole tenant
     * and went red on two demo cameras that were stopped before it started — the instrument failing
     * the platform for streams it does not own. `reconnectAttempts` and `recording` come from the
     * same entry, which makes reconnect count and recording continuity direct readings rather than
     * things inferred from a paginated list.
     */
    const streamHealth = (await api('/media/streams/health', { headers: H })).json?.data ?? {};
    const allStreams = streamHealth.streams ?? [];
    const myStreams = allStreams.filter((s) => cameraIds.includes(s.cameraId));
    const byHealth = (v) => myStreams.filter((s) => s.health === v).length;

    /* New segments and new incidents SINCE THE LAST SAMPLE — time-based, immune to the page cap. */
    const newRecordings = (
      await collectSince('/media/recordings', prev.atIso, { timeField: 'createdAt' })
    ).filter((r) => cameraIds.includes(r.cameraId));
    const recDurations = newRecordings.map((r) => num(r.durationSeconds)).filter((v) => v > 0);

    const newIncidents = (
      await collectSince('/workflow/incidents', prev.atIso, { timeField: 'createdAt' })
    ).filter((i) => `${i.title ?? ''} ${i.source?.ruleName ?? ''}`.includes(TAG));
    /* Incident latency: raised minus the event that triggered it. null, never 0, when unobserved. */
    const incidentLatencies = newIncidents
      .map((i) => {
        const occurred = Date.parse(i.triggeredBy?.occurredAt ?? '');
        const created = Date.parse(i.createdAt ?? '');
        return Number.isFinite(occurred) && Number.isFinite(created) ? created - occurred : null;
      })
      .filter((v) => v !== null && v >= 0);
    incidentsAtStart += newIncidents.length;

    const ratio = (cKey, sKey) => {
      const cnt = d('rules', cKey);
      return cnt > 0 ? (d('rules', sKey) / cnt) * 1000 : null;
    };

    const perService = {};
    for (const svc of Object.keys(NODE_SERVICES)) {
      const s = node[svc] ?? {};
      const st = stats[`vip-prod-${svc}-1`] ?? {};
      perService[svc] = {
        heapUsedMb: num(s.nodejs_heap_size_used_bytes) / 1048576,
        externalMb: num(s.nodejs_external_memory_bytes) / 1048576,
        openFds: num(s.process_open_fds),
        maxFds: num(s.process_max_fds),
        activeHandles: num(s.nodejs_active_handles_total),
        eventLoopLagMaxMs: num(s.nodejs_eventloop_lag_max_seconds) * 1000,
        eventLoopLagMeanMs: num(s.nodejs_eventloop_lag_mean_seconds) * 1000,
        cpuPercent: num(st.cpu),
        memMb: num(st.mem),
        pids: num(st.pids),
        restarts: num(health[`vip-prod-${svc}-1`]?.restarts),
        health: health[`vip-prod-${svc}-1`]?.health ?? 'unknown',
      };
    }

    const offered = d('media', 'media_perception_frames_offered_total');
    const delivered = d('media', 'media_perception_frames_delivered_total');
    const detections = d('media', 'media_perception_detections_total');

    const sample = {
      n,
      minute: Math.round((Date.now() - startedAt.getTime()) / 60_000),
      at: new Date().toISOString(),

      /* frame path */
      offered,
      delivered,
      detections,
      dropped: d('media', 'media_perception_frames_dropped_total'),
      failed: d('media', 'media_perception_frames_failed_total'),
      skippedHeld: d('media', 'media_perception_frames_skipped_held_total'),
      skippedUnassigned: d('media', 'media_perception_frames_skipped_unassigned_total'),
      perFrame: delivered > 0 ? detections / delivered : 0,
      fps: delivered / elapsedS,
      queueDepth: num(m.media_perception_queue_depth),
      inflight: num(m.media_perception_inflight),
      activeCameras: num(m.media_perception_active_cameras),
      inferenceMsAvg: num(m.media_perception_inference_ms_avg),
      frameLatencyMsAvg: num(m.media_perception_frame_latency_ms_avg),

      /* runtime */
      runtimeP50: num(runtime.inference_latency_ms_p50),
      runtimeP95: num(runtime.inference_latency_ms_p95),
      runtimeRssMb:
        num(runtime.inference_runtime_memory_rss_mb) ||
        num(runtime.inference_process_max_rss_kb) / 1024,
      runtimeCpu: num(stats[RUNTIME]?.cpu),
      runtimeMemMb: num(stats[RUNTIME]?.mem),
      runtimeQueue: num(runtime.inference_runtime_queue_depth),
      runtimeUptimeS: num(runtime.inference_runtime_uptime_seconds),
      runtimeSessions: num(runtime.inference_runtime_sessions_active),
      runtimeRestarts: num(health[RUNTIME]?.restarts),
      runtimeHealth: health[RUNTIME]?.health ?? 'unknown',
      trackingActive: num(runtime.inference_tracking_active),
      trackingCreated: dr('inference_tracking_created_total'),

      /* publisher, broker, events */
      published: d('media', 'media_event_publisher_published_total'),
      publisherOffered: d('media', 'media_event_publisher_offered_total'),
      publisherDropped: d('media', 'media_event_publisher_dropped_total'),
      publisherFailed: d('media', 'media_event_publisher_failed_total'),
      publisherRetries: d('media', 'media_event_publisher_retries_total'),
      publisherSuppressed: d('media', 'media_event_publisher_suppressed_total'),
      publisherOutOfOrder: d('media', 'media_event_publisher_out_of_order_total'),
      sessionResets: d('media', 'media_event_publisher_session_resets_total'),
      publisherQueue: num(m.media_event_publisher_queue_depth),
      brokerStatus: num(m.media_event_publisher_broker_status),
      eventsRedelivered: d('events', 'events_redelivered_total'),
      eventIngestMsAvg: (() => {
        const cnt = d('events', 'events_ingest_duration_seconds_count');
        return cnt > 0 ? (d('events', 'events_ingest_duration_seconds_sum') / cnt) * 1000 : null;
      })(),

      /* rules */
      rulesConsumed: d('rules', 'rules_events_consumed_total'),
      rulesEvaluated: d('rules', 'rules_evaluated_total'),
      rulesMatched: d('rules', 'rules_matched_total'),
      rulesDeadLettered: d('rules', 'rules_events_dead_lettered_total'),
      dwellWithoutIdentity: d('rules', 'rules_dwell_without_identity_total'),
      zoneNameUnresolved: d('rules', 'rules_zone_name_unresolved_total'),
      ruleEvalMsAvg: ratio(
        'rules_event_evaluation_duration_seconds_count',
        'rules_event_evaluation_duration_seconds_sum',
      ),
      ruleIngestMsAvg: ratio(
        'rules_event_ingest_latency_seconds_count',
        'rules_event_ingest_latency_seconds_sum',
      ),
      candidateMsAvg: ratio(
        'rules_candidate_latency_seconds_count',
        'rules_candidate_latency_seconds_sum',
      ),

      /* incidents — NEW since the previous sample, so this is throughput rather than a page size */
      incidentCount: newIncidents.length,
      incidentLatencyMsAvg: incidentLatencies.length > 0 ? mean(incidentLatencies) : null,
      incidentLatencyMsMax: incidentLatencies.length > 0 ? Math.max(...incidentLatencies) : null,

      /* assignment */
      assignmentChanges: d('camera', 'camera_assignment_changes_total'),
      assignmentFailures: d('camera', 'camera_assignment_failures_total'),
      assignmentFailovers: d('camera', 'camera_assignment_runtime_failovers_total'),
      assignmentPlanVersion: num(c.camera_assignment_plan_version),
      mediaPlanVersion: num(m.media_assignment_plan_version),
      assignmentActive: num(c.camera_assignment_active_cameras),
      mediaCycleFailures: d('media', 'media_assignment_cycle_failures_total'),

      /* camera health, reconnects and recording continuity — MY cameras only */
      streamsTotal: myStreams.length,
      streamsHealthy: byHealth('healthy'),
      streamsDegraded: byHealth('degraded'),
      streamsDown: byHealth('down'),
      streamsRecording: myStreams.filter((s) => s.recording === true).length,
      reconnectAttempts: myStreams.reduce((a, s) => a + num(s.reconnectAttempts), 0),
      framesReceived: myStreams.reduce((a, s) => a + num(s.framesReceived), 0),
      /* ⚠️ Tenant-wide, recorded but never asserted: this run does not own those streams. */
      tenantStreamsTotal: num(streamHealth.total),
      tenantStreamsDown: num(streamHealth.down),
      recordingNewSince: newRecordings.length,
      recordingMedianDurationS:
        recDurations.length > 0
          ? recDurations.sort((a, b) => a - b)[Math.floor(recDurations.length / 2)]
          : null,

      /* environment */
      perService,
      redis: redisState(),
      hostDiskUsedKb: diskUsedKb(),
      clockDriftS: clockDriftSeconds(),
      logLines: Object.values(logs).reduce((a, x) => a + x.lines, 0),
      logErrors: Object.values(logs).reduce((a, x) => a + x.errors, 0),
      logWarnings: Object.values(logs).reduce((a, x) => a + x.warnings, 0),
      logErrorsBy: Object.fromEntries(
        Object.entries(logs)
          .filter(([, x]) => x.errors > 0)
          .map(([k, x]) => [k, x.errors]),
      ),
      logErrorSamples: Object.values(logs)
        .flatMap((x) => x.sample)
        .slice(0, 4),
      containersNotRunning: Object.entries(health)
        .filter(([, h]) => h.status !== 'running')
        .map(([k]) => k),
      containersUnhealthy: Object.entries(health)
        .filter(([, h]) => h.health !== 'none' && h.health !== 'healthy')
        .map(([k]) => k),
      totalRestarts: Object.values(health).reduce((a, h) => a + h.restarts, 0),
      integrity,
    };

    samples.push(sample);
    prev = { node, runtime, at: Date.now(), atIso: new Date().toISOString() };
    flush();

    console.log(
      `  ${String(sample.minute).padStart(3)}m · ${sample.delivered} frames (${sample.fps.toFixed(2)} fps) · ` +
        `${sample.perFrame.toFixed(2)}/frame · p95 ${sample.runtimeP95.toFixed(0)}ms · q ${sample.queueDepth} · ` +
        `drop ${sample.dropped} · ev ${sample.published} · rules ${sample.rulesConsumed}/${sample.rulesMatched} · ` +
        `inc ${sample.incidentCount} · rt ${sample.runtimeCpu.toFixed(0)}%/${sample.runtimeMemMb.toFixed(0)}MB · ` +
        `err ${sample.logErrors} warn ${sample.logWarnings}`,
    );

    /* ── hard failures: stop early, keep the evidence, name the condition ─────────────────────── */

    if (sample.containersNotRunning.length > 0) {
      aborted = `container(s) not running: ${sample.containersNotRunning.join(', ')}`;
    }
    const restarted = Object.entries(health)
      .filter(([k, h]) => h.restarts > num(baselineHealth[k]?.restarts))
      .map(([k, h]) => `${k} (${baselineHealth[k]?.restarts ?? 0}→${h.restarts})`);
    if (aborted === null && restarted.length > 0)
      aborted = `container restart(s): ${restarted.join(', ')}`;
    if (aborted === null && !integrity.treeClean) {
      aborted = `the working tree changed under the run (${integrity.dirtyFiles} file(s)) — deployment integrity is no longer provable`;
    }
    if (aborted === null && integrity.imagesSwapped.length > 0) {
      aborted = `container image swapped mid-run: ${integrity.imagesSwapped.join(', ')}`;
    }
    const prevUptime = samples.length >= 2 ? samples[samples.length - 2].runtimeUptimeS : 0;
    if (aborted === null && sample.runtimeUptimeS > 0 && sample.runtimeUptimeS < prevUptime) {
      aborted = `the AI runtime restarted (uptime ${prevUptime.toFixed(0)}s → ${sample.runtimeUptimeS.toFixed(0)}s)`;
    }
    silentStreak = sample.delivered === 0 ? silentStreak + 1 : 0;
    if (aborted === null && silentStreak >= 3) {
      aborted = `${silentStreak} consecutive samples analysed nothing — the frame path has stopped`;
    }

    if (aborted !== null) {
      console.log(`\n⛔ ABORTING at sample ${n}: ${aborted}\n`);
      flush();
      break;
    }
  }

  /*
   * ⚠️ Every incident this run raised, counted by TIME rather than by page. `incidentsAtStart` has
   * been accumulating per sample; this catches anything raised after the final sample.
   */
  incidentsAtEnd =
    incidentsAtStart +
    (await collectSince('/workflow/incidents', prev.atIso, { timeField: 'createdAt' })).filter(
      (i) => `${i.title ?? ''} ${i.source?.ruleName ?? ''}`.includes(TAG),
    ).length;
  flush({ incidentsRaised: incidentsAtEnd });

  /* ── what the run has to prove ──────────────────────────────────────────────────────────────── */

  console.log(`\n${'─'.repeat(100)}`);
  console.log(
    `analysis · ${samples.length} samples over ${samples[samples.length - 1]?.minute ?? 0} minutes\n`,
  );

  const pick = (fn) => samples.map(fn).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const halfIdx = Math.floor(samples.length / 2);
  const drift = (fn) => {
    const a = mean(samples.slice(0, halfIdx).map(fn).filter(Number.isFinite));
    const b = mean(samples.slice(halfIdx).map(fn).filter(Number.isFinite));
    return { a, b, percent: a === 0 ? 0 : ((b - a) / a) * 100 };
  };
  /*
   * ⚠️ Below ten samples drift is REPORTED but NOT asserted — the rule `inference-soak.mjs` learned
   * the hard way. Half of three against half of three is noise, and a check that goes red on a
   * healthy platform is the one people learn to ignore.
   */
  const canAssert = samples.length >= 10;
  const driftCheck = (ok, label, detail) =>
    canAssert ? check(ok, label, detail) : finding(`${label} (not asserted)`, detail);
  if (!canAssert)
    console.log(
      `  ⓘ fewer than 10 samples — drift reported, not asserted (${samples.length} taken)\n`,
    );

  check(
    aborted === null,
    'the run completed without tripping an abort condition',
    aborted ?? 'no abort',
  );

  console.log('\n  memory');
  for (const svc of Object.keys(NODE_SERVICES)) {
    const h = drift((s) => s.perService[svc]?.heapUsedMb);
    driftCheck(
      Math.abs(h.percent) < 20,
      `${svc}: heap is flat across the run`,
      `${h.a.toFixed(1)}MB → ${h.b.toFixed(1)}MB (${h.percent >= 0 ? '+' : ''}${h.percent.toFixed(1)}%)`,
    );
  }
  const rss = drift((s) => s.runtimeRssMb);
  driftCheck(
    Math.abs(rss.percent) < 10,
    'the AI runtime RSS is flat across the run',
    `${rss.a.toFixed(0)}MB → ${rss.b.toFixed(0)}MB (${rss.percent >= 0 ? '+' : ''}${rss.percent.toFixed(1)}%)`,
  );

  console.log('\n  file descriptors and handles');
  for (const svc of Object.keys(NODE_SERVICES)) {
    const fds = pick((s) => s.perService[svc]?.openFds);
    const f = drift((s) => s.perService[svc]?.openFds);
    driftCheck(
      Math.abs(f.b - f.a) < 20,
      `${svc}: file descriptors do not grow`,
      `${f.a.toFixed(0)} → ${f.b.toFixed(0)} (peak ${fds.length ? Math.max(...fds) : 0} of ${samples[0]?.perService[svc]?.maxFds ?? '?'})`,
    );
  }

  console.log('\n  event loop');
  for (const svc of Object.keys(NODE_SERVICES)) {
    const lag = pick((s) => s.perService[svc]?.eventLoopLagMaxMs);
    check(
      guard(lag, Math.max(...lag) < 1000),
      `${svc}: the event loop never starved`,
      `max lag ${lag.length ? Math.max(...lag).toFixed(0) : '?'}ms`,
    );
  }

  console.log('\n  frame path');
  const sum = (k) => samples.reduce((a, s) => a + num(s[k]), 0);
  const tOffered = sum('offered');
  const tDelivered = sum('delivered');
  const accounted =
    tDelivered + sum('dropped') + sum('failed') + sum('skippedHeld') + sum('skippedUnassigned');
  check(
    tOffered === 0 || Math.abs(accounted - tOffered) / tOffered < 0.02,
    '⚠️ frame accounting balances — offered == delivered + dropped + failed + skipped',
    `offered ${tOffered} vs accounted ${accounted}`,
  );
  const dropRate = tOffered > 0 ? (sum('dropped') / tOffered) * 100 : 0;
  check(
    dropRate < (profile.expect?.maxDropRatePercent ?? 5),
    `${profile.cameras} cameras stayed inside capacity`,
    `${sum('dropped')}/${tOffered} dropped (${dropRate.toFixed(2)}%)`,
  );
  check(
    sum('failed') === 0,
    'no frame was refused or unreachable in the whole run',
    `${sum('failed')} failures`,
  );
  const fps = pick((s) => s.fps).filter((v) => v > 0);
  const fpsMean = mean(fps);
  const fpsCv = fpsMean === 0 ? 0 : Math.sqrt(mean(fps.map((v) => (v - fpsMean) ** 2))) / fpsMean;
  check(
    guard(fps, fpsCv < 0.25),
    'FPS is stable, not sawtoothing',
    `${fpsMean.toFixed(2)} fps mean, CV ${(fpsCv * 100).toFixed(1)}%`,
  );
  const silent = samples.filter((s) => s.delivered === 0).length;
  check(silent === 0, 'no sample passed with nothing analysed', `${silent} silent sample(s)`);
  const perFrame = pick((s) => s.perFrame).filter((v) => v > 0);
  check(
    guard(perFrame, Math.min(...perFrame) >= (profile.expect?.minDetectionsPerFrame ?? 0.5)),
    '⚠️ detection consistency: the detector kept finding people for the whole run',
    perFrame.length
      ? `${Math.min(...perFrame).toFixed(2)}–${Math.max(...perFrame).toFixed(2)} per frame`
      : 'not measured',
  );

  console.log('\n  queues');
  for (const [key, cap, label] of [
    ['queueDepth', 8, 'perception'],
    ['publisherQueue', 64, 'publisher'],
    ['runtimeQueue', 8, 'runtime'],
  ]) {
    const q = pick((s) => s[key]);
    check(
      guard(q, Math.max(...q) <= cap),
      `the ${label} queue never built up without draining`,
      `peak ${q.length ? Math.max(...q) : 0}`,
    );
    const g = drift((s) => s[key]);
    if (Math.abs(g.b - g.a) > 1)
      finding(`the ${label} queue grew across the run`, `${g.a.toFixed(1)} → ${g.b.toFixed(1)}`);
  }

  console.log('\n  latency');
  for (const [fn, tol, label] of [
    [(s) => s.runtimeP95, 25, 'p95 inference latency'],
    [(s) => s.ruleEvalMsAvg, 50, 'rule evaluation latency'],
    [(s) => s.candidateMsAvg, 50, 'candidate latency'],
    [(s) => s.eventIngestMsAvg, 50, 'event ingest latency'],
    [(s) => s.incidentLatencyMsAvg, 100, 'incident latency'],
  ]) {
    const t = drift(fn);
    const measured = pick(fn);
    if (measured.length === 0) {
      finding(`${label} was not measured`, 'no series — reported as absent, never as zero');
      continue;
    }
    driftCheck(
      Math.abs(t.percent) < tol,
      `${label} does not drift`,
      `${t.a.toFixed(2)}ms → ${t.b.toFixed(2)}ms (${t.percent >= 0 ? '+' : ''}${t.percent.toFixed(1)}%)`,
    );
  }

  console.log('\n  broker, events and rules');
  check(
    samples.filter((s) => s.brokerStatus !== 1).length === 0,
    'the broker reported connected at every sample',
    `${samples.filter((s) => s.brokerStatus !== 1).length} sample(s) not connected`,
  );
  check(
    sum('sessionResets') === 0,
    'no publisher session reset',
    `${sum('sessionResets')} reset(s)`,
  );
  check(
    sum('rulesDeadLettered') === 0,
    'no event was dead-lettered by the rule engine',
    `${sum('rulesDeadLettered')}`,
  );
  check(
    sum('publisherFailed') + sum('publisherDropped') === 0,
    'no event was dropped or failed by the publisher',
    `${sum('publisherFailed') + sum('publisherDropped')}`,
  );
  if (ruleIds.length > 0) {
    check(
      sum('dwellWithoutIdentity') === 0,
      '⚠️ every dwell evaluation had an identity to accumulate against',
      `${sum('dwellWithoutIdentity')} without`,
    );
  }
  console.log(
    `  · ${sum('published')} events published, ${sum('rulesConsumed')} consumed by rules, ${sum('rulesMatched')} matched`,
  );

  console.log('\n  assignment');
  check(
    sum('assignmentChanges') === 0,
    'the assignment plan did not churn once the run was under way',
    `${sum('assignmentChanges')} change(s)`,
  );
  check(
    sum('assignmentFailovers') === 0,
    'no runtime failover was triggered',
    `${sum('assignmentFailovers')}`,
  );
  check(
    sum('mediaCycleFailures') === 0,
    'every assignment poll cycle succeeded',
    `${sum('mediaCycleFailures')} failure(s)`,
  );
  const divergent = samples.filter((s) => s.assignmentPlanVersion !== s.mediaPlanVersion).length;
  check(
    divergent === 0,
    "the enforcement point stayed on the control plane's plan version",
    `${divergent} divergent sample(s)`,
  );

  console.log('\n  cameras, reconnects and recording');
  const down = samples.filter((s) => s.streamsDown > 0).length;
  check(
    down === 0,
    "no stream of this run's own cameras was ever reported down",
    `${down} sample(s) with a stream down`,
  );
  const degraded = samples.filter((s) => s.streamsDegraded > 0).length;
  if (degraded > 0) finding('a stream was reported degraded', `${degraded} sample(s)`);
  const reconnects = samples[samples.length - 1]?.reconnectAttempts ?? 0;
  check(
    reconnects === 0,
    'no camera reconnected during the run',
    `${reconnects} reconnect attempt(s) across ${profile.cameras} cameras`,
  );
  const recGrowth = samples.filter((s) => s.recordingNewSince > 0).length;
  check(
    recGrowth > samples.length * 0.5,
    '⚠️ recording continued throughout — segments kept being written',
    `${recGrowth}/${samples.length} samples produced new segments, ${sum('recordingNewSince')} in total`,
  );
  const everyRecording = samples.filter((s) => s.streamsRecording === profile.cameras).length;
  check(
    everyRecording === samples.length,
    'every camera was recording at every sample',
    `${everyRecording}/${samples.length} samples had all ${profile.cameras} recording`,
  );
  /* ⚠️ Recorded, never asserted: other tenants' streams are not this run's to judge. */
  const tenantDown = samples[samples.length - 1]?.tenantStreamsDown ?? 0;
  if (tenantDown > 0) {
    finding(
      'streams outside this run were down (not asserted)',
      `${tenantDown} of ${samples[samples.length - 1]?.tenantStreamsTotal ?? 0} tenant streams — pre-existing, not created by this run`,
    );
  }

  console.log('\n  containers, integrity and environment');
  const restartDelta =
    (samples[samples.length - 1]?.totalRestarts ?? 0) - (samples[0]?.totalRestarts ?? 0);
  check(restartDelta === 0, 'no container restarted during the run', `${restartDelta} restart(s)`);
  check(
    samples.filter((s) => s.containersUnhealthy.length > 0).length === 0,
    'every container reported healthy at every sample',
    `${samples.filter((s) => s.containersUnhealthy.length > 0).length} sample(s) with an unhealthy container`,
  );
  check(
    samples.every((s) => s.integrity.treeClean) && samples.length > 0,
    'the working tree stayed clean for the whole run',
    `${samples.filter((s) => !s.integrity.treeClean).length} dirty sample(s)`,
  );
  check(
    samples.every((s) => s.integrity.imagesSwapped.length === 0) && samples.length > 0,
    'no container image was swapped underneath the run',
    'image ids constant',
  );
  check(
    sum('logErrors') === 0,
    'no error, exception or fatal appeared in any container log',
    `${sum('logErrors')} matching line(s)`,
  );
  if (sum('logWarnings') > 0)
    finding('warnings were logged', `${sum('logWarnings')} line(s) across the run`);
  const logLines = pick((s) => s.logLines);
  const logMean = mean(logLines);
  check(
    guard(logLines, Math.max(...logLines) < Math.max(2000, logMean * 10)),
    'no container flooded its log',
    `${logMean.toFixed(0)} lines/sample mean, peak ${logLines.length ? Math.max(...logLines) : 0}`,
  );
  const diskKb = pick((s) => s.hostDiskUsedKb).filter((v) => v > 0);
  const diskGrowthMb = diskKb.length >= 2 ? (diskKb[diskKb.length - 1] - diskKb[0]) / 1024 : 0;
  check(
    Math.abs(diskGrowthMb) < 20_480,
    'host disk did not grow unboundedly',
    `${diskGrowthMb >= 0 ? '+' : ''}${diskGrowthMb.toFixed(0)}MB over the run`,
  );
  const drifts = pick((s) => s.clockDriftS);
  check(
    guard(drifts, Math.max(...drifts.map(Math.abs)) <= 2),
    'no clock drift between the host and a container',
    `max ${drifts.length ? Math.max(...drifts.map(Math.abs)) : '?'}s`,
  );
  const lastRedis = samples[samples.length - 1]?.redis;
  finding(
    'Redis is deployed and unused, as recorded (DEBT-A)',
    `${lastRedis?.keys ?? 0} keys, ${(lastRedis?.usedMemoryMb ?? 0).toFixed(1)}MB, ${lastRedis?.connectedClients ?? 0} client(s)`,
  );

  console.log('\n  incidents');
  const incLat = pick((s) => s.incidentLatencyMsAvg);
  console.log(
    `  · ${incidentsAtEnd} incident(s) raised by this run's rule(s) over ${samples.length} samples`,
  );
  if (ruleIds.length > 0) {
    /*
     * ⚠️ Asserted only when the profile HAS a live rule that raises. A profile with no rules (the
     * baseline control) legitimately raises nothing, and a check that went red on that would be
     * measuring the profile rather than the platform.
     */
    check(
      incidentsAtEnd > 0,
      '⚠️ the capability produced incidents — the rule path is live, not merely enabled',
      `${incidentsAtEnd} raised`,
    );
    if (incLat.length > 0) {
      console.log(
        `  · incident latency ${Math.min(...incLat).toFixed(0)}–${Math.max(...incLat).toFixed(0)}ms (event occurred → incident raised)`,
      );
    } else {
      finding('incident latency was not measured', 'no incident carried both timestamps');
    }
  }

  integrityAfter = fullIntegrity('after the run');
  check(
    integrityAfter.ok,
    '⚠️ deployment integrity is still green AFTER the run',
    integrityAfter.line,
  );

  flush({ incidentsRaised: incidentsAtEnd, failures, findings });
  console.log(`\n  samples written to ${OUT}`);
} catch (err) {
  aborted = aborted ?? `the run threw: ${err instanceof Error ? err.message : String(err)}`;
  console.error(`\n⛔ ${aborted}\n`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  failures += 1;
  flush();
} finally {
  /* ⚠️ F-4: a throw must never skip cleanup. One unhandled throw once leaked a raised capacity
     declaration into three later ladders, every one of which failed at its first rung. */
  try {
    await restoreCapacity();
  } catch (e) {
    console.error(`  ⚠️ could not restore runtime capacity: ${e.message}`);
  }
  try {
    await cleanup();
  } catch (e) {
    console.error(`  ⚠️ cleanup incomplete: ${e.message}`);
  }
}

const hours = (Date.now() - startedAt.getTime()) / 3_600_000;
console.log(
  failures === 0 && aborted === null
    ? `\n✓ the platform is stable over ${hours.toFixed(2)}h on profile "${profile.id}"${findings.length ? ` · ${findings.length} finding(s)` : ''}\n`
    : `\n✗ ${failures} check(s) failed${aborted ? ` · aborted: ${aborted}` : ''}\n`,
);
process.exit(failures === 0 && aborted === null ? 0 : 1);
