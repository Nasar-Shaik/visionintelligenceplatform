/**
 * P-9 · **A3 + A4 — does the certification procedure run where it has to, and does it still refuse?**
 *
 *   node docs/review/p9/certification.mjs
 *   node docs/review/p9/certification.mjs --write-baseline    # regenerate the committed baseline
 *
 * ### A3 — in the container, not on the host
 *
 * `certify_cli.py` needs `cv2`, `numpy` and the model catalogue. None of that is on a developer's
 * Mac, and an installer's laptop is not the deployment either. The only honest place to run it is
 * the image the customer gets — which is also the only place a missing dependency can be found.
 *
 * ⛔ **Three defects came out of running it there, and all three were invisible until A1 and A2.**
 * A live run hung forever, then segfaulted, and had never once been executed against a real decoder.
 * See the commit message; the residue is asserted below.
 *
 * ### A4 — the baseline is a verdict, not a byte-image
 *
 * A bundle carries `generatedAt`, host fingerprints and per-stage timings, so committing one raw
 * would produce a file that differs from itself on every run and a diff nobody reads. The committed
 * baseline is the **normalised** bundle: the check list, each check's status and evidence class, the
 * blockers, and the verdict. That is what a hardware run must be compared against, and it is exactly
 * the part that must not drift.
 *
 * ### ⭐ The assertion that matters most
 *
 * **Nothing here may produce `certified`.** Not the simulated source, not the live fixture, not both
 * together. [CONSTRAINTS §18](../../project/CONSTRAINTS.md) is the rule; this is the check that the
 * rule is still load-bearing rather than merely written down.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  checkIntegrity,
  exit,
  finding,
  FIXTURE,
  guard,
  heading,
  ROOT,
  sh,
  shq,
  sleep,
  startFixture,
  stopFixture,
} from './_p9.mjs';

const RUNTIME = 'vip-prod-inference-1';
const BASELINE = join(ROOT, 'docs/review/p9/baseline/generic-rtsp-simulated.json');
const WRITE = process.argv.includes('--write-baseline');

/** Run the CLI inside the deployed runtime image and return `{ code, out }` — never throwing. */
function certify(args) {
  const argv = ['exec', RUNTIME, 'python', 'certify_cli.py', ...args];
  try {
    return { code: 0, out: sh('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    /* ⚠️ The exit code IS the measurement here. A2's first live run printed a complete summary and
       then died with SIGSEGV while writing its bundle — reading stdout alone would have called that
       a pass. `status` is the signal-aware code node reports for a killed child. */
    return { code: err.status ?? err.signal ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const readJson = (path) => {
  const raw = shq('docker', ['exec', RUNTIME, 'cat', path]);
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const filesIn = (dir) =>
  shq('docker', ['exec', RUNTIME, 'sh', '-c', `ls ${dir} 2>/dev/null`])
    .split('\n')
    .filter(Boolean);

/**
 * The committed shape: the verdict and the reasoning, with every volatile field removed.
 * ⚠️ Timings, ids and host fingerprints are deliberately dropped — a baseline that changes on every
 * run is a baseline nobody diffs.
 */
function normalise(bundle, summary, compatibility) {
  return {
    bundleVersion: bundle.bundleVersion,
    status: summary.status,
    evidenceClass: summary.evidenceClass,
    blockers: [...(summary.blockers ?? [])].sort(),
    bundleKeys: Object.keys(bundle).sort(),
    checks: (compatibility.checks ?? [])
      .map((c) => ({ name: c.name, status: c.status, evidenceClass: c.evidenceClass }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

heading('deployment integrity');
checkIntegrity();
check(
  shq('docker', ['exec', RUNTIME, 'python', '-c', 'import cv2; print(cv2.__version__)']) !== '',
  'the deployed runtime image has a decoder',
  'cv2 was absent until A2 and every live endpoint raised ModuleNotFoundError',
);

heading('setup');
startFixture('p9-probe-fixture.yml');
await sleep(4000);
console.log('  ✓ RTSP fixture running');

/* ── A3 · the simulated procedure ─────────────────────────────────────────────────────────────── */

heading('A3 · the procedure against the simulated source');
let baseline;
{
  shq('docker', ['exec', RUNTIME, 'rm', '-rf', '/tmp/p9sim']);
  const run = certify([
    '--target', 'generic-rtsp',
    '--source', 'simulated',
    '--frames', '40',
    '--output', '/tmp/p9sim',
    '--no-benchmark',
  ]);
  check(run.code === 0, 'the CLI exits cleanly', `exit ${run.code}`);

  const files = filesIn('/tmp/p9sim');
  check(files.length === 4, 'it wrote all four artifacts', files.join(' '));

  const summary = readJson('/tmp/p9sim/certification-summary.json');
  const bundle = readJson('/tmp/p9sim/validation-bundle.json');
  const compatibility = readJson('/tmp/p9sim/compatibility.json');
  check(
    summary !== undefined && bundle !== undefined && compatibility !== undefined,
    'and every artifact is valid JSON',
  );

  check(summary?.status === 'pending-validation', '⭐ status is pending-validation', summary?.status);
  check(summary?.evidenceClass === 'simulated', 'evidence is simulated', summary?.evidenceClass);

  const blockers = summary?.blockers ?? [];
  check(guard(blockers, true), 'it names its blockers', `${blockers.length}`);
  for (const needle of ['reconnect-recovery', 'clean-shutdown', 'physical hardware']) {
    check(
      blockers.some((b) => b.includes(needle)),
      `  a blocker names '${needle}'`,
      blockers.find((b) => b.includes(needle))?.slice(0, 76) ?? 'missing',
    );
  }

  baseline = normalise(bundle ?? {}, summary ?? {}, compatibility ?? {});
}

/* ── A3 · the live procedure ──────────────────────────────────────────────────────────────────── */

heading('A3 · the same procedure against a live RTSP transport');
{
  shq('docker', ['exec', RUNTIME, 'rm', '-rf', '/tmp/p9live']);
  const run = certify([
    '--target', 'generic-rtsp',
    '--source', 'rtsp',
    '--uri', `rtsp://${FIXTURE}:8554/p9probe`,
    '--frames', '40',
    '--max-seconds', '45',
    '--output', '/tmp/p9live',
    '--no-benchmark',
  ]);

  /* ⛔ Three separate defects lived on this one line and each produced a different wrong answer:
     the run hung forever (inline pump on an unbounded source), then segfaulted while writing its
     bundle (decoder released under a live pump thread), then wrote a zero-byte artifact and
     reported success on stdout. Exit code and file count together are what catch all three. */
  check(run.code === 0, '⭐ the CLI exits cleanly on a LIVE source', `exit ${run.code}`);
  const files = filesIn('/tmp/p9live');
  check(files.length === 4, 'and wrote all four artifacts', files.join(' '));

  const summary = readJson('/tmp/p9live/certification-summary.json');
  const compatibility = readJson('/tmp/p9live/compatibility.json');
  const checks = compatibility?.checks ?? [];
  check(guard(checks, true), 'the compatibility report has checks', `${checks.length}`);

  const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
  check(byName['connect']?.status === 'pass', 'connect passed', byName['connect']?.status);
  check(
    byName['stream-acquisition']?.status === 'pass',
    'stream-acquisition passed',
    byName['stream-acquisition']?.status,
  );

  /* ⭐ The checks a live transport CAN produce carry hardware evidence… */
  const observed = checks.filter((c) => c.status !== 'not-executed');
  check(
    guard(observed, observed.every((c) => c.evidenceClass === 'hardware')),
    'every executed check carries hardware evidence',
    `${observed.length} executed`,
  );

  /* …and the two only a person can produce do not, which is the whole mechanism. */
  const manual = checks.filter((c) => c.status === 'not-executed');
  check(
    guard(manual, manual.every((c) => c.evidenceClass === 'simulated')),
    'and the two human-only checks stay simulated',
    manual.map((c) => c.name).join(', '),
  );

  check(
    summary?.evidenceClass === 'simulated',
    '⭐ so the summary is the WEAKEST link, not the average',
    summary?.evidenceClass,
  );
  check(
    summary?.status === 'pending-validation',
    '⭐ and a live camera still does not certify',
    summary?.status,
  );

  if ((summary?.blockers ?? []).some((b) => b.includes("evidence class is 'simulated'"))) {
    finding(
      "the blocker reads \"evidence class is 'simulated'\" after 7 of 9 checks ran on hardware",
      'accurate about the summary, imprecise about the run; the next two blockers name the real cause',
    );
  }
}

/* ── ⭐ certification cannot be weakened ──────────────────────────────────────────────────────── */

heading('⭐ no invocation reachable from this repository can certify anything');
{
  const attempts = [
    ['--target', 'hikvision-generic', '--source', 'simulated', '--frames', '10', '--no-benchmark'],
    ['--target', 'generic-rtsp', '--source', 'rtsp', '--uri', `rtsp://${FIXTURE}:8554/p9probe`,
     '--frames', '10', '--max-seconds', '30', '--no-benchmark'],
    /* The permissive-budget attempt: a floor of zero and a ceiling of a hundred percent. If a
       budget could buy a certification, this is the invocation that would. */
    ['--target', 'generic-rtsp', '--source', 'rtsp', '--uri', `rtsp://${FIXTURE}:8554/p9probe`,
     '--frames', '10', '--max-seconds', '30', '--min-fps', '0', '--max-loss', '100', '--no-benchmark'],
  ];
  const verdicts = [];
  for (const [i, args] of attempts.entries()) {
    const out = `/tmp/p9w${i}`;
    shq('docker', ['exec', RUNTIME, 'rm', '-rf', out]);
    certify([...args, '--output', out]);
    const summary = readJson(`${out}/certification-summary.json`);
    verdicts.push(summary?.status ?? 'no-summary');
  }
  check(
    guard(verdicts, verdicts.every((v) => v === 'pending-validation')),
    '⭐ every attempt stays pending-validation',
    verdicts.join(' · '),
  );
  check(
    !verdicts.includes('certified'),
    'and none of them reached `certified`',
    verdicts.join(' · '),
  );
}

/* ── A4 · the committed baseline ──────────────────────────────────────────────────────────────── */

heading('A4 · the committed baseline');
{
  mkdirSync(join(ROOT, 'docs/review/p9/baseline'), { recursive: true });
  if (WRITE) {
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`  ✓ baseline written to ${BASELINE}`);
  }
  check(existsSync(BASELINE), 'the baseline is committed to the repository', BASELINE);

  if (existsSync(BASELINE)) {
    const committed = JSON.parse(readFileSync(BASELINE, 'utf8'));
    check(
      committed.status === 'pending-validation',
      '⭐ and it claims nothing — status pending-validation',
      committed.status,
    );
    check(committed.evidenceClass === 'simulated', 'on simulated evidence', committed.evidenceClass);
    check(
      JSON.stringify(committed) === JSON.stringify(baseline),
      '⭐ and today\'s run still matches it exactly',
      'the diff target for every hardware run',
    );
  }
}

heading('teardown');
stopFixture();
console.log('  ✓ fixture stopped');

exit('A3+A4 certification');
