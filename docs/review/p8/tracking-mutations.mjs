/**
 * P-8 Phase 4 · **does the tracking verification fail for the right reason?**
 *
 *   node docs/review/p8/tracking-mutations.mjs              # all five, each applied and restored
 *   node docs/review/p8/tracking-mutations.mjs association  # one by name
 *   node docs/review/p8/tracking-mutations.mjs restore      # ⚠️ if a run was interrupted
 *
 * Five deliberate breaks, one per behaviour the Architect named: track-id generation, association,
 * occlusion recovery, direction calculation, and lifetime. Each asserts two things:
 *
 * 1. the tracking verification goes **red**, and
 * 2. it goes red at the **named check**, not somewhere else.
 *
 * ### ⚠️ Point 2 is the whole exercise
 *
 * "Something failed" is nearly worthless. Breaking occlusion recovery must fail the occlusion check
 * — if it instead fails the crossing check, the suite has caught *a* problem while being unable to
 * say which, and the engineer restoring it learns nothing. A mutation that turns the run red
 * elsewhere is recorded as a **failure of this harness**, not a success.
 *
 * ### ⚠️ Every mutation restores from a byte snapshot, including on a crash
 *
 * Never `git checkout --`. That reverts to HEAD and silently discards uncommitted work while
 * reporting success — it destroyed an uncommitted fix during the Phase 3H run, and the only reason
 * it was noticed is that the post-restore verification went red for a reason the mutation could not
 * explain. The exact bytes found before the edit are written back in a `finally`.
 *
 * ### ⚠️ Each mutation runs only the scenario it should break
 *
 * The full tracking suite takes about three minutes; five mutations plus five rebuilds would take
 * most of an hour. Every mutation names the single scenario that must go red, and only that scenario
 * runs — which is also a *stronger* test, because a mutation that breaks everything cannot hide
 * inside a green average.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Run the tracking verification for one scenario and report which checks went red. */
function verify(scenario) {
  /*
   * ⚠️ BOTH outputs are redirected, and forgetting the second one caused real damage.
   *
   * `tracking.mjs` writes two files. `OUT` was redirected from the start; `TRUTH_OUT` was added in
   * the Phase 4 freeze and was not — so every mutation ran a SUBSET of the scenarios and overwrote
   * the committed `tracking-truth.json` with it. The file then claimed to be a full evidence run
   * while holding one scenario's results, and the nulls in it looked exactly like the honest
   * "scenario did not run" reporting that is supposed to be a feature.
   *
   * This is the "a stage may not write to a tracked file" rule (docs/nightly/README.md) reappearing
   * the moment a script grew a second output. Any future output must be redirected here too.
   */
  const out = shq('node', ['docs/review/p8/tracking.mjs'], {
    env: { ...process.env, SCENARIOS: scenario, OUT: '/dev/null', TRUTH_OUT: '/dev/null' },
  });
  const red = [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].split(' — ')[0].trim());
  return { out, red, green: !/✗/.test(out) };
}

/**
 * Run the BROWSER verification instead of a scenario.
 *
 * ⚠️ Some rules are only observable on a page. "An unmeasurable metric must never render as a
 * number" (ADR-0039) is one: a runtime that reports `0` instead of `null` tracks every identity
 * perfectly, so no scenario can fail — the damage is entirely in what an operator reads.
 *
 * ⚠️ Copied to /private/tmp/pwrun and run from there, as every Playwright script on this project is.
 */
function verifyUi() {
  const staging = '/private/tmp/pwrun';
  mkdirSync(staging, { recursive: true });
  copyFileSync(join(ROOT, 'docs/review/p8/tracking-ui.mjs'), join(staging, 'tracking-ui.mjs'));
  const out = shq('node', ['tracking-ui.mjs'], { cwd: staging, env: { ...process.env, REPO: ROOT } });
  const red = [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].split(' — ')[0].trim());
  return { out, red, green: !/✗/.test(out) };
}

const snapshots = new Map();

/**
 * Apply every replacement to a file, or fail.
 *
 * ⚠️ **Each pair is checked individually, and that is not pedantry.** The first version took a
 * `mutate` callback and only asserted that the file had *changed* — so in a mutation with two
 * `.replace()` calls, one succeeding masked the other silently failing. Measured: the occlusion
 * mutation's second edit targeted `predict_bbox` with eight spaces of indentation where the function
 * has four, never matched, and the mutation ran for the whole phase disabling ONE of the two
 * mechanisms it claimed to disable. It still went red, so nothing looked wrong — a weaker test
 * reporting the same green as a strong one is the worst outcome available to a mutation harness.
 */
function rewrite(relPath, pairs) {
  const path = join(ROOT, relPath);
  const before = readFileSync(path, 'utf8');
  let after = before;
  for (const [from, to] of pairs) {
    if (!after.includes(from)) {
      throw new Error(
        `mutation for ${relPath} did not match — the target moved:\n${from.slice(0, 120)}`,
      );
    }
    after = after.replace(from, to);
  }
  if (!snapshots.has(relPath)) throw new Error(`no snapshot taken for ${relPath}`);
  writeFileSync(path, after);
}

/** Take the byte snapshot before anything is written, so a failed match still restores cleanly. */
function snapshot(relPath) {
  if (!snapshots.has(relPath)) snapshots.set(relPath, readFileSync(join(ROOT, relPath), 'utf8'));
}

function restoreFile(relPath) {
  const before = snapshots.get(relPath);
  // ⚠️ Refuse rather than guess. Falling back to git is what caused the data loss above.
  if (before === undefined) throw new Error(`no snapshot for ${relPath} — refusing to restore from git`);
  writeFileSync(join(ROOT, relPath), before);
  snapshots.delete(relPath);
}

function rebuildRuntime() {
  shq('bash', ['-c', `cd ${ROOT} && ./infra/docker/prod.sh build inference && ./infra/docker/prod.sh up -d --no-build inference`]);
}

async function waitForRuntime(seconds = 60) {
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

/* ── the five ────────────────────────────────────────────────────────────────────────────────── */

const MUTATIONS = [
  {
    name: 'trackid',
    breaks: 'track ids are recycled instead of being unique per session',
    scenario: 'crossing',
    /*
     * ⚠️ CROSSING, not walk — and the first version got this wrong in an instructive way.
     *
     * A constant track id makes every object look like the same object forever. On a clip with ONE
     * person that is indistinguishable from correct behaviour: there is one identity either way, so
     * "exactly one track id" passes and the mutation reported green. Measured, not reasoned.
     *
     * Two people is where a recycled id becomes visible: the second spawn overwrites the first in
     * the live store, so two people collapse into one identity and the crossing check fails on the
     * count. That is the check that names this fault.
     */
    expect: ['both people were tracked'],
    file: 'ai/inference/track_manager.py',
    apply: () =>
      rewrite('ai/inference/track_manager.py', [
        [
          'tid = f"trk_{camera_id}_{self._session_id}_{self._seq}"',
          'tid = f"trk_{camera_id}_{self._session_id}_1"',
        ],
      ]),
  },
  {
    name: 'association',
    breaks: 'association never matches, so every frame invents a new identity',
    scenario: 'walk',
    expect: ['a continuously visible person holds exactly ONE track id'],
    file: 'ai/inference/tracker.py',
    apply: () =>
      rewrite('ai/inference/tracker.py', [
        [
          '                if score >= floor:\n                    candidates.append((score, t.track_id, di))',
          '                if False:\n                    candidates.append((score, t.track_id, di))',
        ],
      ]),
  },
  {
    name: 'occlusion',
    breaks: 'a coasting track is not predicted forward, so it cannot be re-acquired',
    scenario: 'occlusion',
    // ⚠️ The label only, no detail. `verify()` splits each red line on ' — ' to separate the
    // check from its detail, so an expectation carrying the detail can never match.
    expect: ['the identity SURVIVES the occlusion'],
    file: 'ai/inference/tracker.py',
    /*
     * ⚠️ Prediction AND distance re-acquisition are both disabled, because either alone recovers the
     * occlusion. Breaking only one would leave the verification green and the harness would report
     * that as "the check does not catch this" — when in fact the platform has two mechanisms and the
     * mutation only removed one.
     */
    apply: () =>
      rewrite('ai/inference/tracker.py', [
        ['            coasting = (frame_index - t.last_seen_frame) > 1', '            coasting = False'],
        // ⚠️ FOUR spaces. `predict_bbox` is a module-level function, not a method — the first version
        // wrote eight, matched nothing, and disabled only half the mutation without saying so.
        [
          '    gap = frame_index - track.last_seen_frame\n    if gap <= 0:\n        return track.bbox',
          '    gap = frame_index - track.last_seen_frame\n    if gap >= 0:\n        return track.bbox',
        ],
      ]),
  },
  {
    name: 'direction',
    breaks: 'heading is computed with the vertical component flipped',
    scenario: 'walk',
    /*
     * ⚠️ Flipping `dy` is chosen over flipping `dx` on purpose. A person walking right has almost no
     * vertical component, so `dy` sign errors are exactly the class of bug that survives a smoke
     * test — the arrow still points roughly right and nobody notices until a rule fires on
     * "northbound" traffic. The verification asserts the authored direction, so it must catch it.
     */
    expect: ['the measured direction matches the authored one'],
    file: 'ai/inference/track_motion.py',
    apply: () =>
      rewrite('ai/inference/track_motion.py', [
        [
          '    return math.degrees(math.atan2(dy, dx)) % 360.0',
          '    return math.degrees(math.atan2(-dy, -dx)) % 360.0',
        ],
      ]),
  },
  {
    name: 'lifetime',
    breaks: 'a lost track is never removed, so an identity outlives the object',
    scenario: 'reentry',
    /*
     * With `max_age` effectively infinite the departed track never terminates, so the returning
     * person is re-associated onto the SAME id — which the re-entry check catches as "no new id".
     */
    expect: ['a return after termination gets a NEW track id'],
    file: 'ai/inference/track_manager.py',
    apply: () =>
      rewrite('ai/inference/track_manager.py', [
        ['        if live.misses > self._max_age:', '        if live.misses > 10_000_000:'],
      ]),
  },
  /*
   * ⚠️ **There is deliberately no `false-recovery` mutation, and the absence is a finding.**
   *
   * One was written: open the re-entry gate to 10 000 seconds and ten frame-widths, and assert the
   * crossing verification goes red at "no FALSE re-entry link was formed". It **stayed green**.
   *
   * A re-entry link needs a departed identity to link back TO. Both subjects appear at the start of
   * the crossing clip and neither is retired inside the window, so the resolver never holds a
   * candidate and no gate width can produce a link. The check could not fail — and a check that
   * cannot fail reports the same green as a real one, which is the worst outcome a suite can have.
   *
   * `tracking.mjs` now reports `falseRecoveries` as `null` for that scenario rather than `0`. The
   * mutation is not listed here because listing one that cannot go red would recreate the problem it
   * found. See L-45 in KNOWN_LIMITATIONS; it becomes possible when a fixture presents a genuine stranger after a
   * departure, which is not free to author (L-42 makes appearance-blind linking correct behaviour).
   */
  {
    name: 'ground-truth-honesty',
    breaks: 'an unmeasurable metric is reported as 0 instead of null',
    /*
     * ⚠️ This mutates the ADR-0039 RULE rather than the tracker, and it is verified in the BROWSER
     * rather than by a scenario — because the rule's whole point is what an operator ends up
     * reading. A runtime claiming `identitySwitches: 0` has made a confident, verified-looking
     * claim that nothing checked, and the page must refuse to render it as a number.
     *
     * It is the one mutation here that would leave every identity behaviour perfectly correct.
     */
    scenario: null,
    verifyWith: 'ui',
    expect: ['no ground-truth metric renders as a number the runtime cannot know'],
    file: 'ai/inference/runtime_tracking.py',
    apply: () =>
      rewrite('ai/inference/runtime_tracking.py', [
        ['            "identitySwitches": None,', '            "identitySwitches": 0,'],
        ['            "reidentificationSuccessRate": None,', '            "reidentificationSuccessRate": 0,'],
        ['            "falseRecoveries": None,', '            "falseRecoveries": 0,'],
      ]),
  },
];

if (process.argv[2] === 'restore') {
  rebuildRuntime();
  await waitForRuntime();
  shq('node', ['docs/review/p8/tracking.mjs', 'clean']);
  console.log('runtime rebuilt from the committed source and fixtures cleaned up');
  process.exit(0);
}

const wanted = process.argv[2]
  ? MUTATIONS.filter((m) => m.name === process.argv[2])
  : MUTATIONS;
if (wanted.length === 0) {
  console.log(`unknown mutation. Known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

console.log('\nP-8 Phase 4 · tracking mutation verification\n');
console.log('  ⚠️ This EDITS REAL SOURCE FILES and REBUILDS the runtime image. Every edit is restored');
console.log('     from a byte snapshot in a finally.');
console.log('  ⚠️ Never run it with uncommitted work in flight — AND never commit while it is running.');
console.log('     A `git add -A` during a mutation stages the mutation; the harness then restores the');
console.log('     working tree, leaving the tree correct and the COMMIT wrong. That has happened.\n');

for (const mutation of wanted) {
  console.log(`▶ ${mutation.name} — ${mutation.breaks}`);
  let applied = false;
  try {
    snapshot(mutation.file);
    mutation.apply();
    applied = true;
    rebuildRuntime();
    const up = await waitForRuntime();
    if (!up) {
      check(false, 'the runtime came back after the mutation', 'it never reported healthy');
      continue;
    }

    const what = mutation.verifyWith === 'ui' ? 'browser' : mutation.scenario;
    const broken = mutation.verifyWith === 'ui' ? verifyUi() : verify(mutation.scenario);
    const wentRed = !broken.green;
    check(wentRed, `the ${what} verification goes RED`, wentRed ? broken.red.join(' · ') : 'it stayed green');

    if (wentRed) {
      const named = mutation.expect.some((want) => broken.red.some((r) => normalise(r).includes(normalise(want))));
      check(
        named,
        'it goes red at the check that names this fault',
        named ? mutation.expect[0] : `expected one of [${mutation.expect.join(' | ')}], got [${broken.red.join(' | ')}]`,
      );
      results.push({ mutation: mutation.name, red: broken.red, named });
    } else {
      results.push({ mutation: mutation.name, red: [], named: false });
    }
  } finally {
    if (applied) restoreFile(mutation.file);
    rebuildRuntime();
    await waitForRuntime();
  }

  const restored = mutation.verifyWith === 'ui' ? verifyUi() : verify(mutation.scenario);
  check(restored.green, 'and it is GREEN again once the mutation is restored', restored.green ? '' : restored.red.join(' · '));
  console.log('');
}

shq('node', ['docs/review/p8/tracking.mjs', 'clean']);

/**
 * ⚠️ Apostrophes are normalised before comparison. The typographic and the straight apostrophe are
 * different code points, and a check text that gained one produced a "red, but not at the named
 * check" failure that took longer to diagnose than the mutation it was testing.
 */
function normalise(text) {
  return text.replace(/[‘’ʼ]/g, "'").toLowerCase().trim();
}

const redThenGreen = results.filter((r) => r.named).length;
console.log(
  failures === 0
    ? `\nall ${wanted.length} tracking mutations went red at the named check and green again\n`
    : `\n${failures} mutation check(s) failed · ${redThenGreen}/${wanted.length} named their fault correctly\n`,
);
process.exit(failures === 0 ? 0 : 1);
