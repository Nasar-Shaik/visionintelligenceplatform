/**
 * P-8 Phase 6 · **does the assignment verification fail for the right reason?**
 *
 *   node docs/review/p8/assignment-mutations.mjs              # all eight
 *   node docs/review/p8/assignment-mutations.mjs ordering     # one by name
 *   node docs/review/p8/assignment-mutations.mjs restore      # ⚠️ if a run was interrupted
 *
 * Eight deliberate breaks, one per property the Architect named: assignment disabled, assignment
 * corruption, runtime offline, wrong runtime, duplicate assignment, assignment ordering, capacity
 * exceeded, assignment persistence failure. Each asserts two things:
 *
 * 1. the verification goes **red**, and
 * 2. it goes red at the **check that names the fault**, not somewhere else.
 *
 * ### ⚠️ Point 2 is the whole exercise
 *
 * "Something failed" is nearly worthless. Removing the session-epoch bump must fail the epoch check —
 * if it instead fails "frames reached the runtime", the suite has caught *a* problem while being
 * unable to say which, and the engineer restoring it learns nothing. A mutation that goes red
 * elsewhere is recorded as a **failure of this harness**, not a success.
 *
 * ### ⚠️ Three kinds of mutation, and the cheap kinds are preferred
 *
 * One is **configuration** (the gate's enable flag is a deployment variable, so breaking it is a
 * container restart). One is **operational** — pointing a registered runtime at a dead address
 * through the ordinary API, which is exactly how this fails in the field. The other six need the
 * code changed and pay for an image rebuild.
 *
 * ### ⚠️ Every mutation restores from a byte snapshot, including on a crash
 *
 * Never `git checkout --`. That reverts to HEAD and silently discards uncommitted work while
 * reporting success — it destroyed an uncommitted fix during the Phase 3H run. The exact bytes found
 * before the edit are written back in a `finally`, and the deployment is always returned to the
 * committed configuration.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const MEDIA = 'vip-prod-media-1';
const CAMERA = 'vip-prod-camera-1';
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
    ...opts,
  }).trim();
const shq = (cmd, args, opts = {}) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
const check = (ok, label, detail = '') => {
  console.log(`    ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

/* ── running a verification and reading which checks went red ──────────────────────────────────── */

/**
 * The full red lines from a run's output.
 *
 * ⚠️ **Not split on the em dash.** Several check labels contain one, so splitting would make those
 * expectations silently unmatchable and the harness would report the verification as failing in the
 * wrong place. Expectations are matched by prefix against the whole line.
 */
const redOf = (out) => [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].trim());
const matches = (red, expected) => red.some((line) => line.startsWith(expected));

/**
 * The end-to-end assignment run.
 *
 * ⚠️ `OUT` is redirected to /dev/null. `assignment.mjs` writes a committed evidence file, and a
 * mutation run overwriting it would leave the repository claiming a broken deployment's numbers as
 * its evidence. Phase 4 made exactly that mistake with `TRUTH_OUT`.
 *
 * ⚠️ Shorter windows than a real run. A mutation only has to reach the check that names it, and
 * eight full-length runs is forty minutes of wall clock for no extra information.
 */
function verifyAssignment(env = {}) {
  const out = shq('node', ['docs/review/p8/assignment.mjs'], {
    env: { ...process.env, OUT: '/dev/null', OBSERVE: '12', CONVERGE_MS: '17000', ...env },
  });
  return { out, red: redOf(out) };
}

/** The runtime-orchestration run. Slower; used only by the mutations that need it. */
function verifyRuntime(env = {}) {
  const out = shq('node', ['docs/review/p8/assignment-runtime.mjs'], {
    env: { ...process.env, OUT: '/dev/null', CONVERGE_MS: '17000', ...env },
  });
  return { out, red: redOf(out) };
}

/* ── the ways to break something ───────────────────────────────────────────────────────────────── */

const snapshots = new Map();

function snapshot(relPath) {
  if (!snapshots.has(relPath)) snapshots.set(relPath, readFileSync(join(ROOT, relPath), 'utf8'));
}

/**
 * Apply every replacement to a file, or fail.
 *
 * ⚠️ **Each pair is checked individually.** A mutation with two edits where one silently fails to
 * match is a weaker test reporting the same green as a strong one — the worst outcome available to a
 * mutation harness, and one this project has already shipped once.
 */
function rewrite(relPath, pairs) {
  const path = join(ROOT, relPath);
  let after = readFileSync(path, 'utf8');
  for (const [from, to] of pairs) {
    if (!after.includes(from)) {
      throw new Error(
        `mutation for ${relPath} did not match — the target moved:\n${from.slice(0, 140)}`,
      );
    }
    after = after.replace(from, to);
  }
  if (!snapshots.has(relPath)) throw new Error(`no snapshot taken for ${relPath}`);
  writeFileSync(path, after);
}

function restoreFile(relPath) {
  const before = snapshots.get(relPath);
  /* ⚠️ Refuse rather than guess. Falling back to git is what caused the data loss above. */
  if (before === undefined) {
    throw new Error(`no snapshot for ${relPath} — refusing to restore from git`);
  }
  writeFileSync(join(ROOT, relPath), before);
  snapshots.delete(relPath);
}

function rebuild(service) {
  shq('bash', [
    '-c',
    `cd ${ROOT} && ./infra/docker/prod.sh build ${service} && ./infra/docker/prod.sh up -d --no-build ${service}`,
  ]);
}

/** Restart a service with environment overrides — the configuration mutation. */
function restartWith(service, env) {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');
  shq('bash', [
    '-c',
    `cd ${ROOT} && ${assignments} ./infra/docker/prod.sh up -d --no-build ${service}`,
  ]);
}

async function waitHealthy(container, seconds = 120) {
  for (let i = 0; i < seconds; i += 1) {
    if (shq('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]) === 'healthy') {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

/* ── the operational mutation needs the API ────────────────────────────────────────────────────── */

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
  H = { authorization: `Bearer ${r.json.data.accessToken}`, 'content-type': 'application/json' };
}

/** The URL the seeded runtime is meant to have, captured before it is broken. */
let realRuntimeUrl = null;
let realRuntimeId = null;

async function pointRuntimeAt(url) {
  await login();
  const runtimes = (await api('/camera/processing-runtimes', { headers: H })).json?.data ?? [];
  const rt = runtimes[0];
  if (rt === undefined) throw new Error('no runtime registered — cannot apply the offline mutation');
  if (realRuntimeUrl === null) {
    realRuntimeUrl = rt.url;
    realRuntimeId = rt.id;
  }
  await api(`/camera/processing-runtimes/${realRuntimeId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ url }),
  });
}

async function restoreRuntimeUrl() {
  if (realRuntimeUrl === null || realRuntimeId === null) return;
  await login();
  await api(`/camera/processing-runtimes/${realRuntimeId}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ url: realRuntimeUrl }),
  });
  realRuntimeUrl = null;
  realRuntimeId = null;
}

/* ── the eight ─────────────────────────────────────────────────────────────────────────────────── */

const GATE = 'services/media/src/application/assignment-gate.ts';
const SERVICE = 'services/camera/src/application/assignment-service.ts';
const DOMAIN = 'services/camera/src/domain/assignment.ts';
const PLACEMENT = 'services/camera/src/domain/placement.ts';

const MUTATIONS = [
  {
    name: 'disabled',
    breaks: 'the assignment gate is switched off, so every camera is analysed regardless of the plan',
    kind: 'config',
    async apply() {
      restartWith('media', { MEDIA_ASSIGNMENT_ENABLED: '0' });
      await waitHealthy(MEDIA);
    },
    async restore() {
      restartWith('media', { MEDIA_ASSIGNMENT_ENABLED: '1' });
      await waitHealthy(MEDIA);
    },
    verify: verifyAssignment,
    expect: 'the assignment gate is enabled in this deployment',
  },
  {
    name: 'runtime-offline',
    breaks: 'the registered runtime points at an address nothing listens on',
    kind: 'operational',
    async apply() {
      /* ⚠️ Through the ordinary API — exactly how this fails in the field. */
      await pointRuntimeAt('http://127.0.0.1:9');
      await sleep(20_000);
    },
    async restore() {
      await restoreRuntimeUrl();
      await sleep(15_000);
    },
    verify: verifyAssignment,
    expect: 'and media has measured it healthy',
  },
  {
    name: 'wrong-runtime',
    breaks: 'the plan sends every camera to an empty runtime address',
    kind: 'code',
    async apply() {
      snapshot(SERVICE);
      rewrite(SERVICE, [['        runtimeUrl: runtime.url,', "        runtimeUrl: '',"]]);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    async restore() {
      restoreFile(SERVICE);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    verify: verifyAssignment,
    expect: 'frames reached the runtime',
  },
  {
    name: 'corruption',
    breaks: 'the gate ignores the plan’s intent, so a paused camera keeps being analysed',
    kind: 'code',
    async apply() {
      snapshot(GATE);
      rewrite(GATE, [
        [
          "    if (held.entry.intent === 'hold') return { deliver: false, reason: 'held' };",
          '    /* mutation: intent ignored */',
        ],
      ]);
      rebuild('media');
      await waitHealthy(MEDIA);
    },
    async restore() {
      restoreFile(GATE);
      rebuild('media');
      await waitHealthy(MEDIA);
    },
    verify: verifyAssignment,
    expect: '⚠️ frame delivery STOPPED',
  },
  {
    name: 'ordering',
    breaks: 'the session epoch never moves, so a re-enabled camera inherits the old ordering gate',
    kind: 'code',
    async apply() {
      snapshot(DOMAIN);
      rewrite(DOMAIN, [
        ['  const sessionEpoch = newSession ? doc.sessionEpoch + 1 : doc.sessionEpoch;',
         '  const sessionEpoch = doc.sessionEpoch;'],
      ]);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    async restore() {
      restoreFile(DOMAIN);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    verify: verifyAssignment,
    expect: '⚠️ with a NEW session epoch',
  },
  {
    name: 'duplicate',
    breaks: 'every audit entry claims the same identity, so the second write of a change collides',
    kind: 'code',
    async apply() {
      snapshot('services/camera/src/index.ts');
      rewrite('services/camera/src/index.ts', [
        ["const assignmentIds = { historyId: () => `ash_${randomUUID().replace(/-/g, '')}` };",
         "const assignmentIds = { historyId: () => 'ash_duplicate' };"],
      ]);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    async restore() {
      restoreFile('services/camera/src/index.ts');
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    verify: verifyAssignment,
    expect: 'the camera was enabled through the control plane',
  },
  {
    name: 'persistence',
    breaks: 'accepted changes are never written, so nothing survives the request that made it',
    kind: 'code',
    async apply() {
      snapshot(SERVICE);
      rewrite(SERVICE, [
        [`      await this.#assignments.updateOne(
        { _id: write.doc._id } as never,
        { $set: write.doc as never },
        { upsert: true },
      );`,
         '      /* mutation: the assignment write is skipped */'],
      ]);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    async restore() {
      restoreFile(SERVICE);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    verify: verifyAssignment,
    expect: '⚠️ and the ENFORCEMENT POINT confirmed it',
  },
  {
    name: 'capacity',
    breaks: 'capacity is unbounded, so a full runtime accepts another camera',
    kind: 'code',
    async apply() {
      snapshot(PLACEMENT);
      rewrite(PLACEMENT, [
        ['  if (doc.maxCameras === 0) return null;\n  return doc.maxCameras - used;',
         '  if (doc.maxCameras === 0) return null;\n  return Number.POSITIVE_INFINITY;'],
      ]);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    async restore() {
      restoreFile(PLACEMENT);
      rebuild('camera');
      await waitHealthy(CAMERA);
    },
    verify: verifyRuntime,
    expect: '⚠️ the second is REFUSED — capacity is enforced',
  },
];

/* ── the runner ────────────────────────────────────────────────────────────────────────────────── */

async function restoreEverything() {
  for (const relPath of [...snapshots.keys()]) restoreFile(relPath);
  await restoreRuntimeUrl().catch(() => {});
  restartWith('media', { MEDIA_ASSIGNMENT_ENABLED: '1' });
  rebuild('camera');
  rebuild('media');
  await waitHealthy(CAMERA);
  await waitHealthy(MEDIA);
}

if (process.argv[2] === 'restore') {
  console.log('\nrestoring the deployment to its committed state\n');
  shq('bash', ['-c', `cd ${ROOT} && git status --porcelain services packages`]);
  await restoreEverything();
  shq('node', ['docs/review/p8/assignment.mjs', 'clean']);
  shq('node', ['docs/review/p8/assignment-runtime.mjs', 'clean']);
  process.exit(0);
}

const only = process.argv[2];
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (selected.length === 0) {
  console.error(`unknown mutation "${only}" — one of: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

console.log('\nP-8 Phase 6 · assignment mutation testing\n');
console.log('  Each break must turn the verification RED at the check that names it.\n');

/*
 * ⚠️ A baseline is NOT re-run here. `assignment.mjs` and `assignment-runtime.mjs` are run green
 * before this suite and their result is the baseline; re-running them per mutation would double an
 * already long suite to prove something that was proved five minutes earlier.
 */
for (const mutation of selected) {
  console.log(`\n── ${mutation.name} (${mutation.kind}) ─────────────────────────────────────────`);
  console.log(`   breaks: ${mutation.breaks}`);
  let applied = false;
  try {
    await mutation.apply();
    applied = true;
    /* Fixtures from an interrupted previous run would confuse the numbers. */
    shq('node', ['docs/review/p8/assignment.mjs', 'clean']);
    const { red } = mutation.verify();
    const wentRed = check(red.length > 0, 'the verification went red', `${red.length} failed check(s)`);
    const rightPlace = check(
      matches(red, mutation.expect),
      'and red at the check that names the fault',
      `expected "${mutation.expect}"`,
    );
    if (wentRed && !rightPlace) {
      /*
       * ⚠️ Reported in full. A mutation that goes red somewhere else is a failure of THIS harness —
       * the verification caught a problem and cannot say which, and the next engineer learns
       * nothing from it.
       */
      console.log('      red lines were:');
      for (const line of red) console.log(`        · ${line}`);
    }
    results.push({ name: mutation.name, kind: mutation.kind, red: red.length, rightPlace });
  } catch (err) {
    check(false, 'the mutation could not be applied', err instanceof Error ? err.message : String(err));
    results.push({ name: mutation.name, kind: mutation.kind, red: 0, rightPlace: false });
  } finally {
    if (applied) {
      try {
        await mutation.restore();
      } catch (err) {
        console.log(`    ⚠️ restore failed: ${err instanceof Error ? err.message : String(err)}`);
        failures += 1;
      }
    }
  }
}

/* ⚠️ Whatever happened above, the tree and the deployment go back to committed state. */
try {
  await restoreEverything();
  shq('node', ['docs/review/p8/assignment.mjs', 'clean']);
  shq('node', ['docs/review/p8/assignment-runtime.mjs', 'clean']);
} catch (err) {
  console.log(`\n⚠️ final restore failed: ${err instanceof Error ? err.message : String(err)}`);
  failures += 1;
}

const dirty = shq('bash', ['-c', `cd ${ROOT} && git status --porcelain services packages`]);
check(dirty === '', '⚠️ the working tree is back to its committed state', dirty.slice(0, 200) || 'clean');

console.log('\n  mutation                kind          red   at the right check');
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(22)}  ${r.kind.padEnd(12)}  ${String(r.red).padStart(3)}   ${r.rightPlace ? '✓' : '✗'}`,
  );
}

console.log(
  failures === 0
    ? '\n✅ every assignment property is verified by a check that fails when it is broken\n'
    : `\n❌ ${failures} mutation check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
