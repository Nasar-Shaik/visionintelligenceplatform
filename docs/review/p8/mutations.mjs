/**
 * P-8 Phase 3H · **do the inference verifications fail for the right reason?**
 *
 *   node docs/review/p8/mutations.mjs            # all seven, each applied and restored
 *   node docs/review/p8/mutations.mjs decoder    # one by name
 *   node docs/review/p8/mutations.mjs restore    # ⚠️ if a run was interrupted
 *
 * A verification suite that has never been broken is a suite nobody has tested. This breaks the
 * inference platform seven ways — model, registry, decoder, runtime, metrics, dashboard, gateway —
 * and asserts two things each time:
 *
 * 1. the verification goes **red**, and
 * 2. it goes red for the **stated reason**, not for a side-effect.
 *
 * ### ⚠️ Point 2 is the whole exercise
 *
 * "Something failed" is nearly worthless. When a mutation is restored, the engineer who broke it
 * must be able to read which check named the fault — so each mutation below declares the exact
 * check text it must produce, and a mutation that turns the suite red *somewhere else* is recorded
 * as a **failure of this harness**, not a success.
 *
 * ### ⚠️ Every mutation restores, including on a crash
 *
 * The runtime is recreated from its committed compose configuration and any edited file is written
 * back **from a byte snapshot taken before the edit**, in a `finally`. A mutation harness that can
 * leave the deployment broken is a liability rather than a test — and one that restores from git
 * is worse than a liability, because it silently discards uncommitted work while reporting success.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const RUNTIME = 'vip-prod-inference-1';

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

/** Run the fast half of the inference verification and return its output + exit status. */
function verify() {
  const out = shq('node', ['docs/review/p8/inference.mjs'], { env: { ...process.env, FAST: '1' } });
  const red = [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].split(' — ')[0].trim());
  return { out, red, green: !/✗/.test(out) };
}

/** Bring the runtime back to exactly its committed configuration. */
function recreate(env = {}) {
  const assignments = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  shq('bash', ['-c', `cd ${ROOT} && ${assignments} ./infra/docker/prod.sh up -d --force-recreate --no-build inference`]);
}
function rebuildRuntime() {
  shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh build inference && ./infra/docker/prod.sh up -d inference`]);
}
function rebuildConsoleAndGateway() {
  shq('bash', [
    '-c',
    `cd ${ROOT} && ./infra/docker/prod.sh build console gateway && ./infra/docker/prod.sh up -d console gateway`,
  ]);
}
/**
 * ⚠️ **Never `git checkout --` to undo a mutation.** That reverts the file to HEAD, and a file with
 * *uncommitted* work in it loses that work — silently, because the mutation harness reports success
 * either way. This is not hypothetical: it destroyed an uncommitted fix to `AiRuntimePage.tsx`
 * during the Phase 3H run, and the only reason it was noticed is that the post-restore verification
 * went red for a reason the mutation could not explain.
 *
 * The exact bytes are snapshotted before the first write and written back verbatim. The snapshot is
 * the whole file, so it restores the developer's tree, not the repository's.
 */
const snapshots = new Map();

/**
 * Rewrite a source file in place.
 *
 * ⚠️ Node's `writeFileSync`, not `printf '%s' "$(...)" > file`. The shell version was written first
 * and is silently wrong: `JSON.stringify` escapes a newline as backslash-`n`, and inside shell
 * double quotes that stays two literal characters — every mutated file would have arrived as one
 * line of source with `\n` sprinkled through it, and the resulting build failure would have looked
 * like the mutation working.
 */
function rewrite(relPath, mutate) {
  const path = join(ROOT, relPath);
  const before = readFileSync(path, 'utf8');
  const after = mutate(before);
  if (after === before) throw new Error(`mutation for ${relPath} matched nothing — the target moved`);
  if (!snapshots.has(relPath)) snapshots.set(relPath, before);
  writeFileSync(path, after);
}

/** Put back the exact bytes `rewrite` found, including any uncommitted work they contained. */
function restoreFile(relPath) {
  const before = snapshots.get(relPath);
  // ⚠️ Refuse rather than guess. Falling back to git here is what caused the data loss above.
  if (before === undefined) throw new Error(`no snapshot for ${relPath} — refusing to restore from git`);
  writeFileSync(join(ROOT, relPath), before);
  snapshots.delete(relPath);
}

async function waitForRuntime(seconds = 45) {
  for (let i = 0; i < seconds; i += 1) {
    const raw = shq('docker', [
      'exec', RUNTIME, 'python', '-c',
      "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8085/runtime',timeout=3).read().decode())",
    ]);
    if (raw.includes('"health": "ok"')) return true;
    await sleep(1000);
  }
  return false;
}

/* ── the seven ───────────────────────────────────────────────────────────────────────────────── */

const MUTATIONS = [
  {
    name: 'model',
    breaks: 'a byte flipped inside the registered ONNX artifact',
    // The runtime verifies the checksum at start, so this must stop the process, not corrupt output.
    expect: ['every registered artifact matches its recorded sha256', 'health is derived from the capabilities, and every one is READY'],
    async apply() {
      shq('docker', ['exec', '-u', 'root', RUNTIME, 'sh', '-c',
        'printf "\\x00\\x01\\x02" | dd of=/opt/vip/models/yolox-nano-1.0.0.onnx bs=1 seek=1000 conv=notrunc 2>/dev/null']);
      shq('docker', ['restart', RUNTIME]);
      await sleep(12000);
    },
    async restore() {
      // The corruption lives in the container's writable layer; recreating restores the built image.
      shq('docker', ['stop', RUNTIME]);
      recreate();
      await waitForRuntime();
    },
  },
  {
    name: 'registry',
    breaks: 'the catalogue asked for a model that is not registered',
    expect: ['health is derived from the capabilities, and every one is READY', 'the model bound is the catalogue default'],
    async apply() {
      recreate({ INFERENCE_ACTIVE_MODEL: 'a-model-that-does-not-exist' });
      await sleep(12000);
    },
    async restore() {
      recreate();
      await waitForRuntime();
    },
  },
  {
    name: 'decoder',
    breaks: "the catalogue declares an outputFormat no decoder is registered for",
    expect: ['health is derived from the capabilities, and every one is READY'],
    async apply() {
      rewrite('ai/inference/models/registry.json', (s) =>
        s.replace('"outputFormat": "yolox"', '"outputFormat": "rt-detr"'),
      );
      rebuildRuntime();
      await sleep(12000);
    },
    async restore() {
      restoreFile('ai/inference/models/registry.json');
      rebuildRuntime();
      await waitForRuntime();
    },
  },
  {
    name: 'runtime',
    breaks: 'the container is stopped',
    expect: ['the running container is configured for the real backend', 'the runtime answered'],
    async apply() {
      shq('docker', ['stop', RUNTIME]);
      await sleep(3000);
    },
    async restore() {
      shq('docker', ['start', RUNTIME]);
      await waitForRuntime();
    },
  },
  {
    name: 'metrics',
    breaks: 'a Prometheus series is renamed, so the number the dashboard reads is gone',
    // ⚠️ Nothing in inference.mjs §0–4 reads this series — it is read by hardening.mjs §5 and by the
    // dashboard. So the assertion is that the *truthfulness* check catches it, not this one.
    verifyWith: 'truthfulness',
    expect: ["detectionsTotal is the runtime's own number"],
    async apply() {
      rewrite('ai/inference/metrics.py', (s) =>
        s.replace('"inference_detections_total"', '"inference_detections_renamed_total"'),
      );
      rebuildRuntime();
      await sleep(12000);
    },
    async restore() {
      restoreFile('ai/inference/metrics.py');
      rebuildRuntime();
      await waitForRuntime();
    },
  },
  {
    name: 'gateway',
    breaks: 'the gateway is pointed at a media service that is not there',
    expect: ['an administrator can read the runtime view'],
    async apply() {
      /*
       * ⚠️ The compose value, not a shell variable. The first version exported
       * `MEDIA_URL=http://media-does-not-exist:8083` before `prod.sh up` and changed nothing:
       * `docker-compose.prod.yml` sets `MEDIA_URL: http://media:8083` as a literal under
       * `environment:`, and a literal beats the process environment. The mutation applied cleanly,
       * the gateway came up healthy, and the verification stayed green — a mutation that mutates
       * nothing is indistinguishable from a verification that does not look.
       */
      rewrite('infra/docker/docker-compose.prod.yml', (s) =>
        s.replace('MEDIA_URL: http://media:8083', 'MEDIA_URL: http://media-does-not-exist:8083'),
      );
      shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh up -d --force-recreate --no-build gateway`]);
      await sleep(10000);
    },
    async restore() {
      restoreFile('infra/docker/docker-compose.prod.yml');
      shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh up -d --force-recreate --no-build gateway`]);
      await sleep(10000);
    },
  },
  {
    name: 'dashboard',
    breaks: 'the page renders a fabricated zero where nothing was measured',
    // ⚠️ The mutation a dashboard actually suffers: not a crash, a plausible number. `Measured`
    // renders "not measured" for null/undefined; making it print 0 instead is a one-word change and
    // is invisible in a screenshot.
    verifyWith: 'browser',
    expect: ['⚠️ GPU says “none in this deployment”, not “0%”'],
    async apply() {
      // ⚠️ `>none in this deployment<` — the JSX text node, not the phrase. `String.replace` with a
      // string argument replaces the FIRST match only, and the first match is inside the comment
      // three lines above that explains why the phrase is there. The first version of this mutation
      // rewrote that comment, shipped an identical page, and reported "red, but not at the named
      // check" — a mutation that mutates nothing looks exactly like a verification gap.
      rewrite('apps/console/src/features/system/AiRuntimePage.tsx', (s) =>
        s.replace('>none in this deployment<', '>0 %<'),
      );
      rebuildConsoleAndGateway();
      await sleep(8000);
    },
    async restore() {
      restoreFile('apps/console/src/features/system/AiRuntimePage.tsx');
      rebuildConsoleAndGateway();
      await sleep(8000);
    },
  },
];

/* ── the alternative verifications ───────────────────────────────────────────────────────────── */

/*
 * ⚠️ This runs the **shipped** truthfulness check (`hardening.mjs` §5), not a reimplementation of it.
 * The first version of this function re-derived the answer by grepping `/metrics` here, which would
 * have proved only that the grep in this file works — the mutation could have sailed past the check
 * that actually runs in review and this harness would have reported success.
 */
function verifyTruthfulness() {
  const out = shq('node', ['docs/review/p8/hardening.mjs'], { env: { ...process.env, SECTIONS: '5' } });
  const red = [...out.matchAll(/^ *✗ (.+)$/gm)].map((m) => m[1].split(' — ')[0].trim());
  return { out, red, green: !/✗/.test(out) };
}

function verifyBrowser() {
  const out = shq('bash', ['-c',
    `cp ${ROOT}/docs/review/p8/runtime-ui.mjs /private/tmp/pwrun/p8-runtime-ui.mjs && cd /private/tmp/pwrun && ` +
    `OUT=/tmp REPO=${ROOT} node p8-runtime-ui.mjs`]);
  const red = [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].split(' — ')[0].trim());
  return { out, red, green: !/✗/.test(out) };
}

const VERIFIERS = { default: verify, truthfulness: verifyTruthfulness, browser: verifyBrowser };

/* ── run ─────────────────────────────────────────────────────────────────────────────────────── */

/*
 * ⚠️ Recovery after an interrupted run undoes the **exact substitution**, never the file.
 *
 * A fresh process has no snapshots, and the obvious fallback — `git checkout --` on the three files
 * — is precisely the bug this harness already caused once: it reverts to HEAD and takes any
 * uncommitted work with it. Reversing the one string each mutation wrote touches nothing else, and
 * a mutation that was never applied simply finds no match.
 */
if (process.argv[2] === 'restore') {
  const inverses = [
    ['ai/inference/models/registry.json', '"outputFormat": "rt-detr"', '"outputFormat": "yolox"'],
    ['ai/inference/metrics.py', '"inference_detections_renamed_total"', '"inference_detections_total"'],
    ['apps/console/src/features/system/AiRuntimePage.tsx', '>0 %<', '>none in this deployment<'],
    ['infra/docker/docker-compose.prod.yml', 'MEDIA_URL: http://media-does-not-exist:8083', 'MEDIA_URL: http://media:8083'],
  ];
  let undone = 0;
  for (const [relPath, mutated, original] of inverses) {
    const path = join(ROOT, relPath);
    const before = readFileSync(path, 'utf8');
    if (!before.includes(mutated)) continue;
    writeFileSync(path, before.replace(mutated, original));
    console.log(`  undid the ${relPath} mutation`);
    undone += 1;
  }
  console.log(undone === 0 ? 'no file mutation was left applied' : `${undone} file(s) restored`);
  rebuildRuntime();
  rebuildConsoleAndGateway();
  shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh up -d --force-recreate --no-build gateway`]);
  console.log('deployment restored');
  process.exit(0);
}

const only = process.argv[2];
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (selected.length === 0) {
  console.error(`no mutation named '${only}'. Known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

console.log(`\nP-8 Phase 3H · mutation-testing the inference verifications (${selected.length})\n`);

/* ⚠️ Green FIRST. A suite that was already red would make every mutation below look successful. */
console.log('0 · baseline');
{
  const base = verify();
  check(base.green, 'the verification is green before anything is broken', base.red.join('; ').slice(0, 160));
  if (!base.green) {
    console.log('\n✗ refusing to mutation-test a suite that is already failing\n');
    process.exit(1);
  }
}

for (const mutation of selected) {
  console.log(`\n· ${mutation.name} — ${mutation.breaks}`);
  const verifier = VERIFIERS[mutation.verifyWith ?? 'default'];
  let outcome = { red: [], green: true, out: '' };
  try {
    await mutation.apply();
    outcome = verifier();
    const wentRed = check(!outcome.green, 'the verification turns RED', `${outcome.red.length} check(s) failed`);
    // ⚠️ Red is not enough. It must be red at the check that names this fault — otherwise the suite
    // is detecting a side-effect and an engineer reading it would look in the wrong place.
    // ⚠️ Apostrophes are normalised before matching. `expect` and the shipped check live in
    // different files, and a straight-vs-curly quote already produced one false "red, but not at the
    // named check" here — a harness that cries wolf over typography is a harness people stop reading.
    const flat = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    const named = mutation.expect.filter((e) => outcome.red.some((r) => flat(r).includes(flat(e))));
    check(
      wentRed && named.length > 0,
      'and RED at the check that names the fault',
      named.length > 0 ? named.join('; ').slice(0, 140) : `expected one of: ${mutation.expect.join(' | ')}`,
    );
    results.push({ name: mutation.name, breaks: mutation.breaks, red: outcome.red.length, named });
  } finally {
    await mutation.restore();
  }
  const after = verifier();
  check(after.green, 'and GREEN again once restored', after.green ? '' : after.red.join('; ').slice(0, 160));
}

console.log('\nsummary\n');
console.log('mutation   | checks red | named the fault');
for (const r of results) {
  console.log(
    `${r.name.padEnd(10)} | ${String(r.red).padStart(10)} | ${r.named.length > 0 ? '✓ ' + r.named[0].slice(0, 60) : '✗'}`,
  );
}

console.log(
  failures === 0
    ? '\n✓ every verification fails for the reason it claims, and recovers\n'
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
