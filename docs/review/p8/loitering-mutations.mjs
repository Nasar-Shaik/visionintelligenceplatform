/**
 * P-8 Phase 7 · **does the loitering verification fail for the right reason?**
 *
 *   node docs/review/p8/loitering-mutations.mjs                 # all eight
 *   node docs/review/p8/loitering-mutations.mjs missing-identity # one by name
 *   node docs/review/p8/loitering-mutations.mjs restore          # ⚠️ if a run was interrupted
 *
 * Eight deliberate breaks, one per property the Architect named: rule disabled, wrong zone, wrong
 * dwell time, identity fragmentation, missing identity, event loss, duplicate events, candidate
 * suppression. Each asserts two things:
 *
 * 1. the verification goes **red**, and
 * 2. it goes red at the **check that names the fault**.
 *
 * ### ⚠️ Point 2 is the whole exercise
 *
 * "Something failed" is nearly worthless at 2 a.m. Stamping the wrong zone must fail the *zone*
 * check — if it instead fails "the live rule raised an incident", the suite has caught a problem
 * while being unable to say which, and whoever restores it learns nothing. A mutation that goes red
 * elsewhere is recorded as a **failure of this harness**, not a success.
 *
 * ### ⚠️ Every mutation restores from a byte snapshot, including on a crash
 *
 * Never `git checkout --`. That reverts to HEAD and silently discards uncommitted work while
 * reporting success — it destroyed an uncommitted fix during the Phase 3H run, and in P-8 Phase 6 a
 * `git add -A` during a live mutation committed a break into the history. The exact bytes found
 * before the edit are written back in a `finally`, and the harness checks the tree at the end.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const MEDIA = 'vip-prod-media-1';
const EVENTS = 'vip-prod-events-1';
const RULES = 'vip-prod-rules-1';
const CAMERA = 'vip-prod-camera-1';

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

/**
 * The full red lines from a run's output.
 *
 * ⚠️ **Not split on the em dash.** Several check labels contain one, so splitting would make those
 * expectations silently unmatchable and the harness would report the verification as failing in the
 * wrong place — a mutation suite reporting a false success about itself.
 */
const redOf = (out) => [...out.matchAll(/^ {2}✗ (.+)$/gm)].map((m) => m[1].trim());
const matches = (red, expected) => red.some((line) => line.startsWith(expected));

/**
 * The loitering end-to-end run.
 *
 * ⚠️ `OUT` is redirected to /dev/null. `loitering.mjs` writes a committed evidence file, and a
 * mutation run overwriting it would leave the repository claiming a broken deployment's numbers as
 * its evidence — the mistake Phase 4 made with `TRUTH_OUT`.
 *
 * ⚠️ A shorter window than a real run, but not much shorter: dwell needs the platform's ~10 s
 * observation interval to happen several times, and a window that cannot accumulate would make
 * every mutation red for the same uninformative reason.
 */
function verify(env = {}) {
  const out = shq('node', ['docs/review/p8/loitering.mjs'], {
    env: { ...process.env, OUT: '/dev/null', OBSERVE: '55', DWELL: '20', ...env },
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

async function waitHealthy(container, seconds = 150) {
  for (let i = 0; i < seconds; i += 1) {
    if (shq('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]) === 'healthy') {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

/* ── the eight ─────────────────────────────────────────────────────────────────────────────────── */

const RESOLVER = 'services/media/src/application/zone-resolver.ts';
const NORMALIZER = 'services/events/src/domain/event-normalizer.ts';
const DWELL = 'services/rules/src/domain/dwell.ts';
const ENGINE = 'services/rules/src/application/rule-engine.ts';
const RULE_STORE = 'services/rules/src/adapters/mongo-rule-store.ts';

const MUTATIONS = [
  {
    name: 'rule-disabled',
    breaks: 'a rule the operator enabled is silently not evaluated',
    kind: 'code',
    async apply() {
      snapshot(RULE_STORE);
      /*
       * ⚠️ The engine reads `listEnabled`; the console reads `list`. Breaking only the former is the
       * shape of a lifecycle bug that looks completely fine from every operator surface: the rule
       * list shows `enabled`, the validation report is green, the audit trail records the
       * activation — and nothing is ever evaluated.
       */
      rewrite(RULE_STORE, [
        [
          "      .find({ tenantId: scope.tenantId, lifecycle: 'enabled' } as never, STRIP)",
          "      .find({ tenantId: scope.tenantId, lifecycle: 'no-such-lifecycle' } as never, STRIP)",
        ],
      ]);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    async restore() {
      restoreFile(RULE_STORE);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    /*
     * ⚠️ The **dwell clock**, not "no incident". A rule that is never compiled accumulates nothing,
     * so the earliest and most specific symptom is that no clock is running mid-observation — the
     * check that says "the engine is not evaluating", rather than one that says "no incident
     * appeared" and leaves eight possible causes.
     */
    expect: '⚠️ a dwell clock is RUNNING mid-observation',
  },
  {
    name: 'wrong-zone',
    breaks: 'the resolver stamps a zone id that is not the zone the subject was in',
    kind: 'code',
    async apply() {
      snapshot(RESOLVER);
      rewrite(RESOLVER, [["      (hits ??= []).push(zone.zoneId);", "      (hits ??= []).push(`${zone.zoneId}-wrong`);"]]);
      rebuild('media');
      await waitHealthy(MEDIA);
    },
    async restore() {
      restoreFile(RESOLVER);
      rebuild('media');
      await waitHealthy(MEDIA);
    },
    expect: '⚠️ and they carry the DETECTION ZONE',
  },
  {
    name: 'wrong-dwell-time',
    breaks: 'the accumulated duration is computed from the wrong end of the visit',
    kind: 'code',
    async apply() {
      snapshot(DWELL);
      /*
       * ⚠️ `lastObserved − lastObserved` is always zero, so the threshold is never reached. The
       * subtler half of this mutation is that everything else still works perfectly: observations
       * accumulate, the timeline fills, the clock appears on the live page reading 0.0s.
       */
      rewrite(DWELL, [
        ['  const observedMs = record.lastObservedAtMs - record.firstObservedAtMs;',
         '  const observedMs = record.lastObservedAtMs - record.lastObservedAtMs;'],
      ]);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    async restore() {
      restoreFile(DWELL);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    expect: 'the live rule raised an incident',
  },
  {
    name: 'identity-fragmentation',
    breaks: 're-entry linking fails, so every sighting of one person is a different identity',
    kind: 'code',
    async apply() {
      snapshot(NORMALIZER);
      /*
       * ⚠️ **The most important mutation in this suite, and the one that would ship.**
       *
       * The first version of this mutation swapped `identityId ?? trackId` for `trackId ??
       * identityId` in the dwell stage — a one-word change, correct-looking, and it **stayed green**:
       * the fixture clip never fragments, so the two ids agreed throughout and the mutation asserted
       * nothing. That is the vacuous-check failure this whole harness exists to find, found in the
       * harness itself.
       *
       * This version breaks the thing ADR-0041 actually protects: identity STABILITY. Stamping the
       * event's own id makes every sighting a different person, which is exactly what a re-entry
       * linker that has stopped working produces. Dwell then never accumulates — and the symptom is
       * a status page full of clocks all reading 0.0 s, which "a clock is running" cannot see.
       */
      rewrite(NORMALIZER, [
        [
          '  if (detection.identityId) subject.identityId = detection.identityId;',
          '  if (detection.identityId) subject.identityId = `${detection.identityId}-${Math.random()}`;',
        ],
      ]);
      rebuild('events');
      await waitHealthy(EVENTS);
    },
    async restore() {
      restoreFile(NORMALIZER);
      rebuild('events');
      await waitHealthy(EVENTS);
    },
    expect: '⚠️ and it has ACCUMULATED across observations',
  },
  {
    name: 'missing-identity',
    breaks: 'events reach the dwell stage with no identity, and it invents one',
    kind: 'code',
    async apply() {
      snapshot(NORMALIZER);
      snapshot(DWELL);
      /* The producer stops carrying identity… */
      rewrite(NORMALIZER, [
        ['  if (detection.identityId) subject.identityId = detection.identityId;', '  /* mutation: identity dropped */'],
      ]);
      /* …and the consumer buckets everybody under one key instead of refusing. */
      rewrite(DWELL, [
        ['  return subject.identityId ?? subject.trackId;', "  return subject.identityId ?? subject.trackId ?? 'unknown';"],
      ]);
      rebuild('events');
      rebuild('rules');
      await waitHealthy(EVENTS);
      await waitHealthy(RULES);
    },
    async restore() {
      restoreFile(NORMALIZER);
      restoreFile(DWELL);
      rebuild('events');
      rebuild('rules');
      await waitHealthy(EVENTS);
      await waitHealthy(RULES);
    },
    expect: '⚠️ every zoned event carries an IDENTITY',
  },
  {
    name: 'event-loss',
    breaks: 'the per-zone fan-out drops the zoned envelope and keeps only the zoneless one',
    kind: 'code',
    async apply() {
      snapshot(NORMALIZER);
      /*
       * ⚠️ Events still flow, in the same volume, with the same subjects. Only the ZONE is gone —
       * so a zone-scoped rule declines every event at the scope stage and produces nothing, quietly.
       */
      rewrite(NORMALIZER, [
        [
          '    const group = zones.map((zoneId) => toEnvelope(result, detection, deps, zoneId));',
          '    const group = [toEnvelope(result, detection, deps)];',
        ],
      ]);
      rebuild('events');
      await waitHealthy(EVENTS);
    },
    async restore() {
      restoreFile(NORMALIZER);
      rebuild('events');
      await waitHealthy(EVENTS);
    },
    expect: '⚠️ and they carry the DETECTION ZONE',
  },
  {
    name: 'duplicate-events',
    breaks: 'the engine evaluates every event twice, past the store’s dedup',
    kind: 'code',
    async apply() {
      snapshot(ENGINE);
      /*
       * ⚠️ **A negative control: this mutation is EXPECTED to stay green, and that is the result.**
       *
       * The first version duplicated envelopes in the normalizer, where the events store collapsed
       * them on their shared dedup key before they reached a rule — so it proved only that dedup
       * works, which another check already owns. This version duplicates the observation *inside the
       * engine*, past every dedup the platform has.
       *
       * Dwell still cannot be inflated, because it measures **elapsed time between the first and most
       * recent sighting**, not a count of events. A `window` rule under this mutation would double
       * its count and fire at half its threshold. That difference is the design decision ADR-0044
       * records, and this is the mutation that demonstrates it rather than asserting it.
       */
      rewrite(ENGINE, [
        [
          '      const outcome = await this.#observeDwell(rule, envelope);',
          '      await this.#observeDwell(rule, envelope);\n      const outcome = await this.#observeDwell(rule, envelope);',
        ],
      ]);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    async restore() {
      restoreFile(ENGINE);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    expect: 'the live rule raised an incident',
    tolerateGreen:
      'dwell measures elapsed time rather than counting events, so duplicates cannot inflate it — ' +
      'this mutation is a negative control and staying green IS the result',
  },
  {
    name: 'candidate-suppression',
    breaks: 'the engine builds the candidate and never publishes it',
    kind: 'code',
    async apply() {
      snapshot(ENGINE);
      /*
       * ⚠️ The dry-run path, applied to every rule. Everything upstream is perfect — the clock runs,
       * the threshold is crossed, the candidate is built, the live status page shows a `met` timer —
       * and no incident ever appears. It is the failure an operator reports as "the rule does not
       * work" and an engineer cannot reproduce from logs.
       */
      rewrite(ENGINE, [
        ['      const willRaise = wouldRaise && !rule.dryRun;', '      const willRaise = false && wouldRaise;'],
      ]);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    async restore() {
      restoreFile(ENGINE);
      rebuild('rules');
      await waitHealthy(RULES);
    },
    expect: 'the live rule raised an incident',
  },
];

/* ── restore-everything, used by `restore` and by the final sweep ──────────────────────────────── */

async function restoreEverything() {
  for (const relPath of [...snapshots.keys()]) restoreFile(relPath);
  const dirty = shq('bash', ['-c', `cd ${ROOT} && git status --porcelain services packages`]);
  if (dirty !== '') {
    console.log(`\n⚠️ the tree is still dirty after restore:\n${dirty}`);
  }
  rebuild('media');
  rebuild('events');
  rebuild('rules');
  rebuild('camera');
  await waitHealthy(MEDIA);
  await waitHealthy(EVENTS);
  await waitHealthy(RULES);
  await waitHealthy(CAMERA);
}

if (process.argv[2] === 'restore') {
  console.log('\nrestoring the tree and rebuilding every mutated service\n');
  shq('bash', ['-c', `cd ${ROOT} && git checkout -- services packages 2>/dev/null || true`]);
  await restoreEverything();
  shq('node', ['docs/review/p8/loitering.mjs', 'clean']);
  console.log('done\n');
  process.exit(0);
}

const only = process.argv[2];
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (selected.length === 0) {
  console.log(`no mutation called "${only}". Known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(1);
}

console.log('\nP-8 Phase 7 · loitering mutations — does each check fail for its own reason?\n');

/* ⚠️ A baseline first. A suite that never establishes green cannot distinguish "the mutation broke
 * it" from "it was already broken", and would report eight successes against a dead deployment. */
console.log('  0 · baseline — the verification is green before anything is broken');
const baseline = verify();
check(baseline.red.length === 0, 'the loitering run passes unmutated', `${baseline.red.length} red`);
if (baseline.red.length > 0) {
  for (const line of baseline.red) console.log(`      · ${line}`);
  console.log('\n❌ refusing to mutate a deployment that is already failing\n');
  process.exit(1);
}
console.log('');

for (const mutation of selected) {
  console.log(`  · ${mutation.name} — ${mutation.breaks}`);
  let applied = false;
  try {
    await mutation.apply();
    applied = true;
    const { red } = mutation.verify === undefined ? verify() : mutation.verify();

    if (red.length === 0 && mutation.tolerateGreen !== undefined) {
      /*
       * ⚠️ A recorded, explained tolerance — never a silent one. Two of these mutations degrade a
       * guarantee the fixture clip does not exercise; saying so is honest, and hiding it behind a
       * green tick would be the vacuous check this suite exists to find.
       */
      console.log(`    ⚠️ stayed green — ${mutation.tolerateGreen}`);
      results.push({ name: mutation.name, kind: mutation.kind, red: 0, rightPlace: null });
      continue;
    }

    const wentRed = check(red.length > 0, 'the verification went red', `${red.length} check(s)`);
    const rightPlace = wentRed && matches(red, mutation.expect);
    check(rightPlace, `and at the check that names the fault — "${mutation.expect}"`);
    if (!rightPlace && wentRed) {
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
  console.log('');
}

try {
  await restoreEverything();
  shq('node', ['docs/review/p8/loitering.mjs', 'clean']);
} catch (err) {
  console.log(`\n⚠️ final restore failed: ${err instanceof Error ? err.message : String(err)}`);
  failures += 1;
}

const dirty = shq('bash', ['-c', `cd ${ROOT} && git status --porcelain services packages`]);
check(dirty === '', '⚠️ the working tree is back to its committed state', dirty.slice(0, 300) || 'clean');

console.log('\n  mutation                  kind      red   at the right check');
for (const r of results) {
  const mark = r.rightPlace === null ? '· tolerated' : r.rightPlace ? '✓' : '✗';
  console.log(`  ${r.name.padEnd(24)}  ${r.kind.padEnd(8)}  ${String(r.red).padStart(3)}   ${mark}`);
}

console.log(
  failures === 0
    ? '\n✅ every loitering property is verified by a check that fails when it is broken\n'
    : `\n❌ ${failures} mutation check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
