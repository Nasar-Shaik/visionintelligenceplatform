#!/usr/bin/env node
/**
 * Persistent metric history (P-8 Phase 4 freeze).
 *
 *   node scripts/nightly/history.mjs <run-dir>        # append this run's metrics to the ledger
 *   node scripts/nightly/history.mjs --read benchmark # read a ledger back, newest last
 *
 * ### ⚠️ Why a ledger exists when the run directories are already on disk
 *
 * They are, and they survive a restart — but they are **pruned**. `scripts/cleanup.sh --prune`
 * deletes run directories older than `KEEP_RUNS` days, which is correct: a full run directory holds
 * logs, samples and screenshots and there is no reason to keep ninety of them. The consequence is
 * that a trend built by walking run directories has a thirty-day memory, and the questions this data
 * is FOR — "is the p95 creeping up over a quarter?", "how many cameras did we sustain in June?" —
 * are longer than that.
 *
 * So each run appends a few hundred bytes to an append-only ledger. Small enough to keep forever,
 * and structured enough to answer a capacity question.
 *
 * ⚠️ It lives in `scripts/reports/history/`, a **sibling** of `scripts/reports/nightly/`, and that
 * placement is the safety rather than a preference: `cleanup.sh` prunes with
 * `find "$REPORT_ROOT" -maxdepth 1 -type d -mtime +KEEP`, so anything inside the run root is one
 * quiet month away from deletion. Being outside it means the pruner cannot reach this by accident,
 * without anyone having to remember an exclusion.
 *
 * ### ⚠️ Append-only, and never rewritten
 *
 * A line is written once and never edited. Recomputing history is how a regression quietly
 * disappears — and on a platform whose whole verification argument is "measured, not asserted", a
 * mutable measurement record is worth less than none.
 *
 * ### ⚠️ What is NOT carried here
 *
 * No tenant id, no camera id, no track id, no path. This is engineering telemetry about the
 * platform's own behaviour and it is kept far longer than anything else — so it holds counts,
 * timings and verdicts, and nothing that describes a person or a customer's premises.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const HISTORY_DIR = process.env.HISTORY_DIR ?? join(ROOT, 'scripts/reports/history');

/** Bumped when a reader would misread an older line. Readers skip versions they do not know. */
const HISTORY_VERSION = 1;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The largest camera count inside the loss budget, with no earlier rung breaching it. */
function sustainable(rows, budget = 2) {
  let best = 0;
  for (const r of rows) {
    if (r.dropPercent <= budget && (r.failed ?? 0) === 0) best = r.cameras;
    else break;
  }
  return best;
}

/**
 * One run → at most one line per family.
 *
 * ⚠️ A family whose metric file is absent writes NOTHING, rather than a line of nulls. A ledger of
 * empty rows is indistinguishable from a platform that got slower and slower, and the whole point of
 * keeping this data is to be able to tell those apart years later.
 */
export function summarise(runDir) {
  const metrics = join(runDir, 'metrics');
  const runId = basename(runDir);
  const at = new Date().toISOString();
  const out = [];

  const bench = readJson(join(metrics, 'benchmark.json'));
  if (bench?.rows?.length) {
    const cams = sustainable(bench.rows);
    const at_ = bench.rows.find((r) => r.cameras === cams) ?? bench.rows[0];
    out.push({
      family: 'benchmark',
      row: {
        v: HISTORY_VERSION,
        runId,
        at,
        sustainableCameras: cams,
        latencyP95Ms: at_?.latencyP95Ms ?? null,
        runtimeMemMb: at_?.runtimeMem ?? null,
        runtimeCpu: at_?.runtimeCpu ?? null,
        dropPercent: at_?.dropPercent ?? null,
        topCameras: bench.rows[bench.rows.length - 1]?.cameras ?? null,
        topDropPercent: bench.rows[bench.rows.length - 1]?.dropPercent ?? null,
      },
    });
  }

  const stability = readJson(join(metrics, 'stability.json'));
  if (stability?.samples?.length) {
    const s = stability.samples;
    const memory = s.map((x) => x.runtimeMem).filter((n) => typeof n === 'number' && n > 0);
    const half = Math.floor(s.length / 2);
    const first = mean(s.slice(0, half).map((x) => x.runtimeMem).filter(Boolean));
    const second = mean(s.slice(half).map((x) => x.runtimeMem).filter(Boolean));
    out.push({
      family: 'stability',
      row: {
        v: HISTORY_VERSION,
        runId,
        at,
        minutes: s.length,
        cameras: stability.cameras ?? null,
        frames: s.reduce((a, x) => a + (x.delivered || 0), 0),
        dropped: s.reduce((a, x) => a + (x.dropped || 0), 0),
        memoryLowMb: memory.length ? Math.min(...memory) : null,
        memoryHighMb: memory.length ? Math.max(...memory) : null,
        memoryDriftPercent:
          first && second ? Number((((second - first) / first) * 100).toFixed(2)) : null,
      },
    });
  }

  const tracking = readJson(join(metrics, 'tracking-benchmark.json'));
  if (tracking?.rows?.length) {
    const top = tracking.rows[tracking.rows.length - 1];
    const clean = tracking.rows.filter((r) => r.identityOverhead === 0).map((r) => r.cameras);
    out.push({
      family: 'tracking',
      row: {
        v: HISTORY_VERSION,
        runId,
        at,
        identityIntactToCameras: clean.length ? Math.max(...clean) : 0,
        topCameras: top?.cameras ?? null,
        topIdentityOverhead: top?.identityOverhead ?? null,
        topDropPercent: top?.dropPercent ?? null,
        trackingMsMax: Math.max(...tracking.rows.map((r) => r.trackingMsAvg ?? 0)),
        occlusionsSurvived: tracking.rows.reduce((a, r) => a + (r.occlusionsSurvived ?? 0), 0),
        crossings: tracking.rows.reduce((a, r) => a + (r.crossings ?? 0), 0),
        /*
         * ⚠️ Recorded as `false` on every ladder line, forever. A future reader asking "were these
         * accuracy-verified?" must get an answer, and the answer is no — a live ladder cannot see an
         * identity switch. The `tracking-truth` family below is where accuracy lives.
         */
        groundTruth: false,
      },
    });
  }

  const truth = readJson(join(metrics, 'tracking-truth.json'));
  if (truth?.metrics) {
    out.push({
      family: 'tracking-truth',
      row: {
        v: HISTORY_VERSION,
        runId,
        at,
        scenarios: truth.scenariosRun ?? [],
        ...truth.metrics,
        /*
         * ⚠️ The caveat is stored with the numbers, not left in a README. In two years somebody will
         * read `identityStability: 1.0` off this ledger; it must arrive already saying that it was
         * measured against authored synthetic clips and never against real CCTV.
         */
        measuredAgainst: 'authored synthetic clips, not real CCTV (L-1)',
      },
    });
  }

  return out;
}

export function append(runDir) {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const written = [];
  for (const { family, row } of summarise(runDir)) {
    appendFileSync(join(HISTORY_DIR, `${family}.jsonl`), `${JSON.stringify(row)}\n`);
    written.push(family);
  }
  return written;
}

/** A ledger, oldest first. Lines this build cannot read are skipped rather than guessed at. */
export function read(family, limit = 0) {
  const path = join(HISTORY_DIR, `${family}.jsonl`);
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row.v === HISTORY_VERSION) rows.push(row);
    } catch {
      // A truncated final line is expected if a run was killed mid-append. Ignore it.
    }
  }
  return limit > 0 ? rows.slice(-limit) : rows;
}

export function families() {
  if (!existsSync(HISTORY_DIR)) return [];
  return readdirSync(HISTORY_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, arg] = process.argv.slice(2);
  if (command === '--read') {
    const rows = read(arg ?? 'benchmark');
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === '--families') {
    console.log(families().join('\n'));
  } else if (command !== undefined) {
    const written = append(command);
    console.log(
      written.length > 0
        ? `history: appended ${written.join(', ')} → ${HISTORY_DIR.replace(`${ROOT}/`, '')}`
        : 'history: this run produced no metrics worth recording',
    );
  } else {
    console.error('usage: history.mjs <run-dir> | --read <family> | --families');
    process.exit(2);
  }
}
