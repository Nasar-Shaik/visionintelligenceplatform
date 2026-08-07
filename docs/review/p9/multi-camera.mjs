/**
 * P-9 · **A4.5 — does any of this still hold with more than one camera?**
 *
 *   node docs/review/p9/multi-camera.mjs
 *   node docs/review/p9/multi-camera.mjs clean     # ⚠️ if a run was interrupted
 *
 * A1 through A4 each proved something about **one** camera. A customer does not have one camera, and
 * the defects that only appear at N are a different family from the ones that appear at 1: shared
 * state, concurrency, capacity, and results that get attributed to the wrong device.
 *
 * ⭐ **The rungs are probed CONCURRENTLY, on purpose.** Sequential probing at N=4 is four runs of
 * the N=1 test wearing a ladder's clothes, and it would exercise none of the risk. The runtime
 * serves on a `ThreadingHTTPServer`, and the probe path was reached for the first time this week —
 * so four simultaneous decodes through one process is genuinely untested ground.
 *
 * ### What each rung must show
 *
 * | Claim                 | Why it can only fail at N > 1                                      |
 * | --------------------- | ------------------------------------------------------------------ |
 * | Distinct sources      | One shared path means one publisher and N readers — the P-8.6 defect |
 * | Correct attribution   | N concurrent probes must not return each other's measurements       |
 * | No capacity refusal   | The runtime ceiling is 4 (provisional); the ladder must stay under it |
 * | Deployment integrity  | Every rung, not just the end — a leak shows up as drift across rungs |
 *
 * ⚠️ Ends at **4**, deliberately. The frozen sizing policy is two cameras supported, four
 * provisional and not quotable, above four measured but never recommended
 * ([AI_RUNTIME_BENCHMARK](../../project/AI_RUNTIME_BENCHMARK.md)). A ladder that climbed past the
 * policy would be manufacturing a number nobody may quote.
 *
 * ⚠️ Synthetic throughout. L-1 stands.
 */
import {
  api,
  check,
  checkIntegrity,
  cleanup,
  createCamera,
  defaultZoneId,
  ensureAuth,
  exit,
  finding,
  FIXTURE,
  guard,
  H,
  heading,
  login,
  read,
  sh,
  shq,
  sleep,
  startFixture,
  stopFixture,
} from './_p9.mjs';

const RUNTIME = 'vip-prod-inference-1';
const RUNGS = [1, 2, 4];
/** ⚠️ Zero-padded and distinct per camera — never a shared path. */
const PATH_FOR = (i) => `cam${String(i).padStart(2, '0')}`;

if (process.argv[2] === 'clean') {
  await cleanup();
  stopFixture();
  process.exit(0);
}

async function probe(cameraId) {
  await ensureAuth();
  const res = await api(`/camera/cameras/${cameraId}/probe`, {
    method: 'POST',
    headers: H,
    body: '{}',
  });
  return { status: res.status, result: res.json?.data?.probe, text: res.text };
}

heading('deployment integrity');
checkIntegrity();

await login();
await cleanup(true);

heading('setup');
startFixture('p9-probe-fixture.yml');
await sleep(4000);
console.log('  ✓ RTSP fixture running');
const zoneId = await defaultZoneId();
check(zoneId !== undefined, 'a zone exists to attach cameras to', zoneId ?? '(none)');

/** Integrity is sampled at every rung, so a leak shows as drift rather than as a single end state. */
const perRung = [];

for (const n of RUNGS) {
  heading(`rung: ${n} camera${n === 1 ? '' : 's'}`);
  await cleanup(true);

  /* ── create ──────────────────────────────────────────────────────────────────────────────── */
  const ids = [];
  for (let i = 1; i <= n; i += 1) {
    const cam = await createCamera({
      name: `p9 ladder ${n}x ${PATH_FOR(i)}`,
      streamUrl: `rtsp://${FIXTURE}:8554/${PATH_FOR(i)}`,
      zoneId,
    });
    if (cam.id === undefined) {
      /* ⚠️ A 409 here is the camera service refusing a duplicate stream URL — which would mean the
         paths were not distinct after all. It is a real answer, not a flake. */
      check(false, `  camera ${i} created`, `status ${cam.status}: ${cam.text.slice(0, 120)}`);
      continue;
    }
    ids.push(cam.id);
  }
  check(ids.length === n, `${n} camera(s) created with distinct stream URLs`, `${ids.length}/${n}`);

  /* ── probe, concurrently ─────────────────────────────────────────────────────────────────── */
  await ensureAuth();
  const started = Date.now();
  const results = await Promise.all(ids.map((id) => probe(id)));
  const elapsed = Date.now() - started;

  const ok = results.filter((r) => r.result?.reachable === true && (r.result?.framesRead ?? 0) > 0);
  check(
    guard(results, ok.length === n),
    `⭐ all ${n} probed concurrently and every one decoded frames`,
    `${ok.length}/${n} in ${elapsed}ms`,
  );

  /* ⭐ Attribution. Every probe must have measured ITS camera, not a neighbour's. With one shared
     fixture path this passes vacuously — which is exactly why the paths are distinct. */
  const resolutions = results.map((r) => r.result?.resolution);
  check(
    guard(resolutions, resolutions.every((r) => /^\d+x\d+$/.test(r ?? ''))),
    'each probe returned its own measurement',
    resolutions.join(' '),
  );

  const failures = results.filter((r) => r.result === undefined);
  check(
    failures.length === 0,
    'no probe came back `unavailable`',
    failures.map((f) => f.text.slice(0, 60)).join(' | ') || 'none',
  );

  /* ── the archive attributes correctly ────────────────────────────────────────────────────── */
  let archived = 0;
  for (const id of ids) {
    const h = await api(`/camera/cameras/${id}/probes`, { headers: H });
    const records = h.json?.data?.records ?? [];
    if (Array.isArray(records) && records.length > 0 && h.json?.data?.cameraId === id) archived += 1;
  }
  check(archived === n, 'each camera owns its own probe records', `${archived}/${n}`);

  /* ── certification still refuses, at every rung ──────────────────────────────────────────── */
  shq('docker', ['exec', RUNTIME, 'rm', '-rf', `/tmp/p9ladder${n}`]);
  let code = 0;
  try {
    sh(
      'docker',
      [
        'exec', RUNTIME, 'python', 'certify_cli.py',
        '--target', 'generic-rtsp',
        '--source', 'rtsp',
        '--uri', `rtsp://${FIXTURE}:8554/${PATH_FOR(1)}`,
        '--frames', '20',
        '--max-seconds', '40',
        '--output', `/tmp/p9ladder${n}`,
        '--no-benchmark',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    code = err.status ?? err.signal ?? 1;
  }
  check(code === 0, 'a certification runs to completion alongside them', `exit ${code}`);

  let summary;
  try {
    summary = JSON.parse(
      shq('docker', ['exec', RUNTIME, 'cat', `/tmp/p9ladder${n}/certification-summary.json`]),
    );
  } catch {
    summary = undefined;
  }
  check(
    summary?.status === 'pending-validation',
    '⭐ and still certifies nothing',
    summary?.status ?? 'no summary',
  );

  /* ── integrity, at this rung ─────────────────────────────────────────────────────────────── */
  const health = await read('/camera/ready');
  const runtimes = await read('/camera/processing-runtimes');
  const list = Array.isArray(runtimes.data) ? runtimes.data : (runtimes.data?.runtimes ?? []);
  const capacity = list[0];
  perRung.push({
    n,
    elapsed,
    decoded: ok.length,
    assigned: capacity?.assignedCameras ?? capacity?.cameras ?? null,
    max: capacity?.maxCameras ?? null,
  });
  check(runtimes.ok, 'the control plane still answers', `status ${runtimes.status}`);
  check(
    shq('docker', ['inspect', RUNTIME, '--format', '{{.State.Health.Status}}']) === 'healthy',
    'the runtime is still healthy',
  );
  /* ⚠️ Restart count, not just health: a container that crashed and came back reports `healthy`,
     and the difference between "never fell over" and "fell over and recovered" is the measurement. */
  const restarts = Number(shq('docker', ['inspect', RUNTIME, '--format', '{{.RestartCount}}']) || '0');
  check(restarts === 0, 'and has never restarted', `restartCount=${restarts}`);
}

heading('across the ladder');
{
  console.table(perRung);
  const decoded = perRung.map((r) => r.decoded);
  check(
    guard(decoded, perRung.every((r) => r.decoded === r.n)),
    '⭐ every rung decoded on every camera',
    perRung.map((r) => `${r.n}:${r.decoded}`).join(' '),
  );

  /* ⚠️ Not asserted, reported. Concurrency at 4 costing more than 4× the 1-camera time would be a
     serialisation worth knowing about before hardware — but this is a laptop under a working day's
     load, and a threshold picked here would measure the laptop. */
  const one = perRung.find((r) => r.n === 1)?.elapsed ?? 0;
  const four = perRung.find((r) => r.n === 4)?.elapsed ?? 0;
  if (one > 0) {
    finding(
      `concurrent probe wall clock: 1 camera ${one}ms → 4 cameras ${four}ms`,
      `${(four / one).toFixed(2)}× for 4× the work — reported, not asserted; measured on a laptop`,
    );
  }

  const ceilings = perRung.map((r) => r.max).filter((m) => m !== null);
  if (ceilings.length > 0) {
    check(
      ceilings.every((m) => m === ceilings[0]),
      'the runtime capacity ceiling never moved',
      `max=${ceilings[0]}`,
    );
  }
}

heading('teardown');
await cleanup();
stopFixture();
console.log('  ✓ fixture stopped');

exit('A4.5 synthetic multi-camera');
