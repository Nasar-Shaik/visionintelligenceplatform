/**
 * P-8 Phase 5 · **does the bridge verification fail for the right reason?**
 *
 *   node docs/review/p8/event-bridge-mutations.mjs           # all six, each applied and restored
 *   node docs/review/p8/event-bridge-mutations.mjs ordering  # one by name
 *   node docs/review/p8/event-bridge-mutations.mjs restore    # ⚠️ if a run was interrupted
 *
 * Six deliberate breaks, one per property the Architect named: publisher disabled, queue overflow,
 * schema corruption, ordering violation, retry disabled, broker unavailable. Each asserts two
 * things:
 *
 * 1. the bridge verification goes **red**, and
 * 2. it goes red at the **check that names the fault**, not somewhere else.
 *
 * ### ⚠️ Point 2 is the whole exercise
 *
 * "Something failed" is nearly worthless. Removing the ordering gate must fail the ordering check —
 * if it instead fails "results were published", the suite has caught *a* problem while being unable
 * to say which, and the engineer restoring it learns nothing. A mutation that goes red elsewhere is
 * recorded as a **failure of this harness**, not a success.
 *
 * ### ⚠️ Two kinds of mutation, and the cheap kind is preferred
 *
 * Three of the six are **configuration**: the bridge's enable flag, its queue bound and its retry
 * bound are all deployment variables, so breaking them means restarting a container rather than
 * rebuilding an image. That is not a shortcut — it is a stronger test of the same thing, because it
 * breaks the property the way a misconfigured deployment actually would. The other three need the
 * code changed, and those pay for an image rebuild.
 *
 * ### ⚠️ Every mutation restores from a byte snapshot, including on a crash
 *
 * Never `git checkout --`. That reverts to HEAD and silently discards uncommitted work while
 * reporting success — it destroyed an uncommitted fix during the Phase 3H run. The exact bytes found
 * before the edit are written back in a `finally`, and the container is always returned to the
 * committed configuration.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const MEDIA = 'vip-prod-media-1';
const NATS = 'vip-prod-nats-1';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT, ...opts }).trim();
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
 * ⚠️ **Not split on the em dash.** The tracking harness strips each line at ' — ' to separate the
 * check from its detail, which works only while no check LABEL contains one — and three of the
 * labels here do. An expectation would then silently never match, and the harness would report the
 * verification as failing in the wrong place. Expectations are matched by prefix instead.
 */
const redOf = (out) => [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].trim());
const matches = (red, expected) => red.some((line) => line.startsWith(expected));

/**
 * The end-to-end bridge run — one camera, real frames, real inference.
 *
 * ⚠️ `OUT` is redirected. `event-bridge.mjs` writes a committed evidence file, and a mutation run
 * overwriting it would leave the repository claiming a broken deployment's numbers as its evidence.
 * That exact mistake was made in Phase 4 with `TRUTH_OUT`, and the nulls it wrote looked identical
 * to the honest "not measurable" reporting they were supposed to be distinguishable from.
 */
function verifyBridge(env = {}) {
  const out = shq('node', ['docs/review/p8/event-bridge.mjs'], {
    env: { ...process.env, OUT: '/dev/null', OBSERVE: '20', ...env },
  });
  return { out, red: redOf(out) };
}

/** The resilience run — broker outage and camera re-enable. Slower; used only where it is needed. */
function verifyResilience(env = {}) {
  const out = shq('node', ['docs/review/p8/event-bridge-resilience.mjs'], {
    env: { ...process.env, OUT: '/dev/null', PHASE: '20', ...env },
  });
  return { out, red: redOf(out) };
}

/* ── the two ways to break something ───────────────────────────────────────────────────────────── */

const snapshots = new Map();

function snapshot(relPath) {
  if (!snapshots.has(relPath)) snapshots.set(relPath, readFileSync(join(ROOT, relPath), 'utf8'));
}

/**
 * Apply every replacement to a file, or fail.
 *
 * ⚠️ **Each pair is checked individually.** A mutation with two edits where one silently fails to
 * match is a weaker test reporting the same green as a strong one — the worst outcome available to
 * a mutation harness, and one this project has already shipped once.
 */
function rewrite(relPath, pairs) {
  const path = join(ROOT, relPath);
  const before = readFileSync(path, 'utf8');
  let after = before;
  for (const [from, to] of pairs) {
    if (!after.includes(from)) {
      throw new Error(`mutation for ${relPath} did not match — the target moved:\n${from.slice(0, 140)}`);
    }
    after = after.replace(from, to);
  }
  if (!snapshots.has(relPath)) throw new Error(`no snapshot taken for ${relPath}`);
  writeFileSync(path, after);
}

function restoreFile(relPath) {
  const before = snapshots.get(relPath);
  // ⚠️ Refuse rather than guess. Falling back to git is what caused the data loss above.
  if (before === undefined) throw new Error(`no snapshot for ${relPath} — refusing to restore from git`);
  writeFileSync(join(ROOT, relPath), before);
  snapshots.delete(relPath);
}

function rebuildMedia() {
  shq('bash', [
    '-c',
    `cd ${ROOT} && ./infra/docker/prod.sh build media && ./infra/docker/prod.sh up -d --no-build media`,
  ]);
}

/**
 * Restart media with environment overrides — the configuration mutations.
 *
 * ⚠️ `up -d --no-build` with the variables exported, so compose re-creates the container from the
 * SAME image with different settings. No rebuild, and the committed compose file is never edited.
 */
function restartMediaWith(env) {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join(' ');
  shq('bash', ['-c', `cd ${ROOT} && ${assignments} ./infra/docker/prod.sh up -d --no-build media`]);
}

async function waitForMedia(seconds = 90) {
  for (let i = 0; i < seconds; i += 1) {
    if (shq('docker', ['inspect', '-f', '{{.State.Health.Status}}', MEDIA]) === 'healthy') return true;
    await sleep(1000);
  }
  return false;
}

const restoreBroker = () => {
  shq('docker', ['start', NATS]);
};

/* ── the six ───────────────────────────────────────────────────────────────────────────────────── */

const MUTATIONS = [
  {
    name: 'disabled',
    breaks: 'the bridge is switched off, so nothing is ever published',
    kind: 'config',
    /*
     * ⚠️ The first check on the page, and the reason it is first. A disabled bridge is a VALID
     * deployment — it is the pre-Phase-5 behaviour and the default. What must never happen is a run
     * that reports a healthy chain while nothing is publishing, so the enable flag is asserted
     * before anything downstream of it is measured.
     */
    expect: ['the event bridge is enabled in this deployment'],
    env: { MEDIA_EVENT_BRIDGE_ENABLED: '0' },
    verify: verifyBridge,
  },
  {
    name: 'retry',
    breaks: 'the retry bound is cut to a single attempt, so nothing is ever retried',
    kind: 'config',
    /*
     * Only observable against a broker that is failing, so this one runs the resilience script.
     * With `maxAttempts: 1` a publish fails once and is counted as failed without a retry — the
     * failure and recovery numbers still move, which is exactly why the retry counter needs its own
     * assertion rather than being inferred from them.
     */
    expect: ['and were retried within the bound before giving up'],
    env: { MEDIA_EVENT_MAX_ATTEMPTS: '1' },
    verify: verifyResilience,
  },
  {
    name: 'broker',
    breaks: 'the broker is stopped before the run, so no publish can be acknowledged',
    kind: 'infra',
    expect: ['the broker acknowledged them'],
    apply: () => {
      shq('docker', ['stop', NATS]);
    },
    restore: async () => {
      restoreBroker();
      await sleep(8000);
    },
    verify: verifyBridge,
  },
  {
    name: 'ordering',
    breaks: 'the ordering gate loses its restart discriminator, so a re-enabled camera is stranded',
    kind: 'code',
    file: 'services/media/src/adapters/event-publisher.ts',
    /*
     * ⚠️ **The restart half of the gate, not the stale half — and the choice is measured, not
     * stylistic.**
     *
     * The obvious mutation is to delete the rejection so stale results publish. It is not reliably
     * observable: the runtime answers four frames concurrently, so out-of-order responses HAPPEN,
     * but a twenty-four second clip can easily produce none — the baseline run above reported
     * "every result arrived in order". Worse, the events service collapses that clip's 39 results
     * into 3 persisted envelopes, so a stale one landing in an already-persisted bucket is deduped
     * away before anything downstream could see it. A mutation that passes or fails on scheduling
     * luck is not a test. The stale path is covered where it CAN be deterministic — three unit
     * tests on the publisher itself.
     *
     * The restart path is deterministic end to end: stop the camera, start it, and its sequence
     * begins at 1 against a `lastSeq` of 100. Without the discriminator every event from the
     * restarted camera is read as stale, for ever — which is exactly the blocker this milestone
     * found and fixed, and exactly what Camera Processing Assignment will do on every enable.
     */
    expect: ['⚠️ the camera was re-enabled and events RESUMED'],
    apply: () =>
      rewrite('services/media/src/adapters/event-publisher.ts', [
        [
          '      const restarted = lastAt !== undefined && Number.isFinite(capturedAt) && capturedAt > lastAt;',
          '      const restarted = false;',
        ],
      ]),
    verify: verifyResilience,
  },
  {
    name: 'schema',
    breaks: 'the publisher emits a result with its tenant stripped, which the contract forbids',
    kind: 'code',
    file: 'services/media/src/adapters/event-publisher.ts',
    /*
     * ⚠️ This mutation corrupts the DATA, and the protection it proves is the fail-closed parse that
     * catches it. A result missing `tenantId` cannot be routed to a tenant subject, cannot be
     * persisted under a tenant scope, and would be dead-lettered by `services/events` after a broker
     * round trip — in another service's log, where nobody debugging media would look. `rejected`
     * staying flat is what says the refusal happened at the producer.
     */
    expect: ['nothing was rejected'],
    apply: () =>
      rewrite('services/media/src/adapters/event-publisher.ts', [
        [
          '    const parsed = DetectionResult.safeParse(raw);',
          "    const parsed = DetectionResult.safeParse({ ...(raw as object), tenantId: '' });",
        ],
      ]),
    verify: verifyBridge,
  },
  {
    name: 'queue',
    breaks: 'the per-camera queue never evicts, so pressure accumulates instead of shedding',
    kind: 'code',
    file: 'services/media/src/adapters/event-publisher.ts',
    /*
     * ⚠️ Eviction removed, not the bound raised. Raising `MEDIA_EVENT_QUEUE_PER_CAMERA` would be the
     * cheaper configuration mutation, but it does not break anything: a larger bound is still a
     * bound, and a check written against the deployment's own bound would correctly stay green.
     * The property under test is that the queue SHEDS, so the shedding is what gets removed.
     */
    expect: ['⚠️ and SHED load rather than accumulating it'],
    apply: () =>
      rewrite('services/media/src/adapters/event-publisher.ts', [
        [
          '    while (q.length > this.#perCamera) {',
          /* ⚠️ Not `while (false)` — that is a constant condition, which the compiler and the linter
             both object to, and a mutation that fails to BUILD proves nothing about the check. */
          '    while (q.length > Number.POSITIVE_INFINITY) {',
        ],
      ]),
    verify: verifyResilience,
  },
];

/* ── the run ───────────────────────────────────────────────────────────────────────────────────── */

if (process.argv[2] === 'restore') {
  console.log('\nrestoring the deployment to its committed state\n');
  restoreBroker();
  rebuildMedia();
  await waitForMedia();
  console.log('media rebuilt from the committed source, broker running\n');
  process.exit(0);
}

const selected = process.argv[2]
  ? MUTATIONS.filter((m) => m.name === process.argv[2])
  : MUTATIONS;
if (selected.length === 0) {
  console.error(`unknown mutation: ${process.argv[2]}`);
  console.error(`known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

console.log('\nP-8 Phase 5 · six mutations against the event bridge');
console.log('each must go red, and red at the check that names it\n');

for (const mutation of selected) {
  console.log(`· ${mutation.name} — ${mutation.breaks}  [${mutation.kind}]`);
  let applied = false;
  try {
    if (mutation.kind === 'code') {
      snapshot(mutation.file);
      mutation.apply();
      applied = true;
      rebuildMedia();
      if (!(await waitForMedia())) throw new Error('media did not come back healthy after the rebuild');
    } else if (mutation.kind === 'config') {
      restartMediaWith(mutation.env);
      applied = true;
      if (!(await waitForMedia())) throw new Error('media did not come back healthy after the restart');
    } else {
      await mutation.apply();
      applied = true;
    }

    const { out, red } = mutation.verify();
    const hit = mutation.expect.filter((label) => matches(red, label));
    const stray = red.filter((line) => !mutation.expect.some((label) => line.startsWith(label)));

    check(red.length > 0, 'the verification went red');
    check(
      hit.length === mutation.expect.length,
      '⚠️ and red at the check that NAMES this fault',
      hit.length === mutation.expect.length
        ? mutation.expect.join(' · ')
        : `expected ${JSON.stringify(mutation.expect)}, got ${JSON.stringify(red)}`,
    );
    /*
     * ⚠️ Reported, never asserted. A break rarely stays inside one check — a disabled bridge fails
     * everything downstream of it, and that is correct behaviour, not harness noise. What would be
     * a real problem is the named check staying GREEN, and that is what the assertion above covers.
     */
    if (stray.length > 0) {
      console.log(`      · ${stray.length} further check(s) also went red: ${stray.slice(0, 4).join(' · ')}`);
    }
    results.push({ mutation: mutation.name, red, named: hit, stray });
    if (!/✗|✓/.test(out)) {
      console.log('      ⚠️ the verification produced no checks at all — output follows');
      console.log(out.split('\n').slice(-12).map((l) => `      | ${l}`).join('\n'));
    }
  } catch (err) {
    check(false, 'the mutation could be applied', err instanceof Error ? err.message : String(err));
    results.push({ mutation: mutation.name, error: String(err) });
  } finally {
    if (applied) {
      if (mutation.kind === 'code') {
        restoreFile(mutation.file);
        rebuildMedia();
        await waitForMedia();
      } else if (mutation.kind === 'config') {
        /* Back to the committed compose defaults — no overrides exported. */
        shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh up -d --no-build media`]);
        await waitForMedia();
      } else {
        await mutation.restore();
      }
    }
  }
  console.log('');
}

/*
 * ⚠️ The deployment is left exactly as it was found, whatever happened above — the broker running,
 * media built from committed source with committed configuration. A mutation harness that leaves a
 * broken deployment behind poisons every run after it, and the next person to look would be
 * debugging this script rather than their own change.
 */
restoreBroker();
rebuildMedia();
await waitForMedia();

const { out: finalOut } = verifyBridge();
const stillGreen = !/✗/.test(finalOut);
check(stillGreen, '⚠️ the restored deployment verifies GREEN again', stillGreen ? 'every mutation reverted cleanly' : 'THE RESTORE DID NOT WORK');

writeFileSync(
  join(ROOT, 'docs/review/p8/event-bridge-mutations.json'),
  `${JSON.stringify({ at: new Date().toISOString(), results, restoredGreen: stillGreen }, null, 2)}\n`,
);

console.log(
  failures === 0
    ? '\nevery mutation went red at the check that names it — the bridge verification is load-bearing\n'
    : `\n${failures} mutation check(s) failed — the verification does not catch what it claims to\n`,
);
process.exit(failures === 0 ? 0 : 1);
