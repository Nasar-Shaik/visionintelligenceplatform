/**
 * P-8 Phase 4 · **what does tracking cost, and does identity survive load?**
 *
 *   node docs/review/p8/tracking-benchmark.mjs        # 1 → 16 cameras
 *   LADDER=1,2 node docs/review/p8/tracking-benchmark.mjs
 *
 * ### ⚠️ The ladder runs the WALK clip, not the still photograph
 *
 * The Phase 3 capacity ladder loops a still image, which is right for throughput and wrong here: a
 * stationary subject produces one track that never has to be re-associated, so "identity stability"
 * against it is 100 % by construction and measures nothing. Every camera on this ladder plays a clip
 * containing **exactly one walking person**, which is what makes the identity numbers meaningful —
 * the ground truth is one identity per camera per pass, so extra identities are countable.
 *
 * ### ⚠️ Identity stability is measured against ground truth, NOT inferred
 *
 * `fragmentation` on the statistics page is a symptom. Here the right answer is known: one person
 * per camera. So `identityOverhead = createdTracks − cameras` is the number of identities the engine
 * produced beyond the truth — the closest thing to an honest "identity switch" count this platform
 * can produce without a labelled dataset, and it is named for what it measures.
 *
 * ### ⚠️ Fresh cameras per rung
 *
 * The Phase 3 ladder adds cameras incrementally, which is correct when the source is an infinite
 * loop. These clips are 70 seconds and play **once** — a camera created at rung 1 would have
 * finished by rung 8, and the top of the ladder would be measuring cameras that had stopped sending.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignCameras, raiseRuntimeCapacity, tryAssignCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const MEDIA = 'vip-prod-media-1';
const RUNTIME = 'vip-prod-inference-1';
const FIXTURE = 'vip-tracking-bench';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-trackbench';
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/tracking-capacity.json');
const LADDER = (process.env.LADDER ?? '1,2,4,8,16').split(',').map(Number);
const WINDOW = Number(process.env.WINDOW ?? 20);
const WARMUP = Number(process.env.WARMUP ?? 8);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const shq = (cmd, args) => {
  try {
    return sh(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * ⚠️ `$INTERNAL_API_KEY` expanded inside the container that holds it (ADR-0018).
 *
 * ⚠️ **Retries, and throws rather than returning an empty object.** The first version swallowed a
 * failed exec and returned `{}`, so every counter read as `0` — and since these readings are
 * differenced, one silent failure turned into a NEGATIVE identity count (measured: −2 identities
 * across a rung). A metric that goes backwards is nonsense a reader will notice; one that reads
 * plausibly-low is nonsense they will not.
 */
function tracking(attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    const raw = shq('docker', [
      'exec', MEDIA, 'sh', '-c',
      `curl -s -H "x-internal-key: $INTERNAL_API_KEY" -H "x-tenant-id: ${TENANT}" http://inference:8085/tracking`,
    ]);
    try {
      const stats = JSON.parse(raw).data?.stats;
      if (stats !== undefined) return stats;
    } catch {
      /* retry */
    }
  }
  throw new Error('the runtime did not return tracking statistics after 3 attempts');
}

function scrape(container, port) {
  const text =
    container === MEDIA
      ? shq('docker', ['exec', container, 'sh', '-c', `curl -s localhost:${port}/metrics`])
      : shq('docker', ['exec', container, 'python', '-c',
          `import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:${port}/metrics',timeout=5).read().decode())`]);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/);
    if (m) out[m[1]] = Number(m[3]);
  }
  return out;
}

/** Container CPU % and RSS in MB, from docker's own accounting. */
function usage(container) {
  const raw = shq('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}', container]);
  const [cpu, mem] = raw.split('\t');
  const memMb = /([\d.]+)\s*([KMG])iB/.exec(mem ?? '');
  const scale = { K: 1 / 1024, M: 1, G: 1024 };
  return {
    cpu: Number((cpu ?? '0').replace('%', '')) || 0,
    memMb: memMb ? Number(memMb[1]) * (scale[memMb[2]] ?? 1) : 0,
  };
}

async function cleanup(quiet = false) {
  await login();
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} camera(s) and stopped the benchmark fixture\n`);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

await login();
await cleanup(true);

/*
 * ⚠️ **The ladder raises the runtime's DECLARED capacity for the run and restores it afterwards.**
 *
 * The seeded runtime declares 4 cameras — the provisional sizing figure — and from P-8 Phase 6 the
 * control plane enforces it, so an 8-camera rung is refused with a 409 by the control plane doing
 * exactly its job. This ladder climbed to 16 the week before that gate shipped and stopped at 4
 * afterwards; the first full nightly since is what found it. See `raiseRuntimeCapacity`.
 *
 * ⚠️ The sizing policy is untouched: no capacity number is published from one run, and a rung that
 * drops frames still reports dropped frames.
 */
const restoreCapacity = await raiseRuntimeCapacity(api, H, Math.max(...LADDER) + 8);
/** The rung the control plane refused, if any — published beside the table, never thrown. */
let refusedAt = null;


if (!existsSync(join(ROOT, 'infra/docker/fixtures/media/tracking/walk.mp4'))) {
  console.log('\ntracking fixtures are missing — generating them first\n');
  sh('node', [join(ROOT, 'docs/review/p8/tracking-fixtures.mjs')], { stdio: 'inherit' });
}

console.log(`\nP-8 Phase 4 · tracking capacity at ${LADDER.join(', ')} cameras (${WINDOW}s windows)\n`);
console.log('  ⚠️ Each camera plays ONE walking person. Ground truth is one identity per camera.\n');

shq('docker', ['rm', '-f', FIXTURE]);
sh('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
]);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const rows = [];

try {
  for (const cameras of LADDER) {
    /*
     * ⚠️ The identity baseline is taken BEFORE the cameras start, not after the warm-up.
     *
     * One walking person produces exactly one identity, and it is created on the first frame — which
     * lands during the warm-up. Baselining after the warm-up therefore measured zero identities
     * created during the window, and reported "0 identities at one camera" for a rung that had
     * tracked the subject perfectly. Throughput still baselines after the warm-up, because that
     * number IS about the steady state.
     */
    const identityBase = tracking();
    const made = [];
    for (let i = 0; i < cameras; i += 1) {
      const cam = await api('/camera/cameras', {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          zoneId,
          name: `${TAG} ${cameras}-${i}`,
          protocol: 'rtsp',
          /*
           * ⚠️ Each camera gets its OWN path, and that was measured rather than assumed. Pointing
           * every camera at one shared path left offered frames pinned at 2 fps regardless of the
           * rung — only one camera was receiving video, so every rung above the first was measuring
           * a single stream while reporting a camera count.
           */
          streamUrl: `rtsp://${FIXTURE}:8554/walk${String(i + 1).padStart(2, '0')}`,
          metadata: { tags: [TAG] },
        }),
      });
      made.push(cam.json?.data?.id);
      await api(`/media/streams/${made[i]}/start`, { method: 'POST', headers: H, body: '{}' });
    }
    /*
     * ⚠️ A control-plane refusal ends the ladder; it does not fail it. See `tryAssignCameras` — the
     * 2026-08-06 run threw here and discarded every rung it had already measured, then leaked its
     * assignments into the next three stages.
     */
    const placed = await tryAssignCameras(api, H, made);
    if (!placed.ok) {
      refusedAt = { cameras: made.length, reason: placed.reason };
      console.log(`\n  ⚠️ refused at ${made.length} camera(s) — ${placed.reason.replace(/^could not assign \S+ for AI processing \(HTTP 409\): /, '')}`);
      console.log('     the rungs below stand; the ladder is truncated, not failed.');
      break;
    }

    await sleep(WARMUP * 1000);
    const m0 = scrape(MEDIA, 8083);
    const started = Date.now();

    // Sample resources THROUGH the window; a single reading at the end catches the quietest moment.
    let cpuPeak = 0;
    let memPeak = 0;
    const polls = Math.max(2, Math.floor(WINDOW / 5));
    for (let p = 0; p < polls; p += 1) {
      await sleep((WINDOW / polls) * 1000);
      const u = usage(RUNTIME);
      cpuPeak = Math.max(cpuPeak, u.cpu);
      memPeak = Math.max(memPeak, u.memMb);
    }

    const elapsed = (Date.now() - started) / 1000;
    const m1 = scrape(MEDIA, 8083);
    const t1 = tracking();
    const mediaUsage = usage(MEDIA);

    const delivered = (m1.media_perception_frames_delivered_total ?? 0) - (m0.media_perception_frames_delivered_total ?? 0);
    const offered = (m1.media_perception_frames_offered_total ?? 0) - (m0.media_perception_frames_offered_total ?? 0);
    const dropped = (m1.media_perception_frames_dropped_total ?? 0) - (m0.media_perception_frames_dropped_total ?? 0);
    const created = (t1.createdTracks ?? 0) - (identityBase.createdTracks ?? 0);
    const framesTracked = (t1.framesTracked ?? 0) - (identityBase.framesTracked ?? 0);

    const row = {
      cameras,
      windowSeconds: Number(elapsed.toFixed(1)),
      offeredFps: Number((offered / elapsed).toFixed(2)),
      analysedFps: Number((delivered / elapsed).toFixed(2)),
      droppedFrames: dropped,
      dropPercent: offered > 0 ? Number(((dropped / offered) * 100).toFixed(2)) : 0,
      framesTracked,
      // Over the whole rung (warm-up included), because that is the interval the identities span.
      tracksPerSecond: Number((created / (elapsed + WARMUP)).toFixed(3)),
      createdTracks: created,
      activeTracks: t1.activeTracks ?? 0,
      confirmedTracks: t1.confirmedTracks ?? 0,
      lostTracks: t1.lostTracks ?? 0,
      recoveredTracks: (t1.recoveredTracks ?? 0) - (identityBase.recoveredTracks ?? 0),
      /*
       * ⚠️ Ground-truth based. One walking person per camera means `cameras` identities is the right
       * answer; anything above that is the engine fragmenting or switching. Named `identityOverhead`
       * rather than "identity switches" because it cannot distinguish the two without a labelled
       * dataset — and a number that claims more precision than it has is worse than a vaguer one.
       */
      identityOverhead: Math.max(0, created - cameras),
      identityStability: created > 0 ? Number((Math.min(cameras, created) / created).toFixed(3)) : null,
      trackingMsAvg: t1.averageTrackingMs ?? null,
      outOfOrderFrames: (t1.outOfOrderFrames ?? 0) - (identityBase.outOfOrderFrames ?? 0),
      // --- the permanent tracking metrics, differenced against this rung's baseline -------------
      occlusionsSurvived: (t1.occlusionsSurvived ?? 0) - (identityBase.occlusionsSurvived ?? 0),
      crossings: (t1.crossings ?? 0) - (identityBase.crossings ?? 0),
      reentryOpportunities: (t1.reentryOpportunities ?? 0) - (identityBase.reentryOpportunities ?? 0),
      removedTracks: (t1.removedTracks ?? 0) - (identityBase.removedTracks ?? 0),
      averageTrackLifetimeSeconds: t1.averageTrackLifetimeSeconds ?? null,
      averageTrackAgeFrames: t1.averageTrackAgeFrames ?? null,
      fragmentation: t1.fragmentation ?? null,
      /*
       * ⚠️ Carried as `null`, deliberately, on EVERY rung. This ladder runs against live streams, so
       * it is as blind to identity switches as production is — one walking person per camera tells
       * you how many identities appeared, never whether two were exchanged. The numbers exist in
       * `tracking-truth.json`, from the authored scenarios. Emitting the keys keeps the shape
       * complete; filling them from this ladder would be inventing accuracy. See ADR-0039.
       */
      identitySwitches: null,
      reidentificationSuccessRate: null,
      falseRecoveries: null,
      runtimeCpu: Number(cpuPeak.toFixed(1)),
      runtimeMemMb: Number(memPeak.toFixed(1)),
      mediaCpu: Number(mediaUsage.cpu.toFixed(1)),
      mediaMemMb: Number(mediaUsage.memMb.toFixed(1)),
    };
    rows.push(row);
    console.log(
      `  ${String(cameras).padStart(2)} cam · analysed ${row.analysedFps.toFixed(1).padStart(5)} fps · ` +
        `dropped ${row.dropPercent.toFixed(1).padStart(5)}% · tracks/s ${row.tracksPerSecond.toFixed(2)} · ` +
        `identities ${created} (overhead ${row.identityOverhead}) · ` +
        `track ${row.trackingMsAvg === null ? ' n/a ' : `${row.trackingMsAvg.toFixed(3)}ms`} · ` +
        `cpu ${row.runtimeCpu.toFixed(0)}% mem ${row.runtimeMemMb.toFixed(0)}MB`,
    );

    for (const id of made) {
      await api(`/media/streams/${id}/stop`, { method: 'POST', headers: H, body: '{}' });
      await api(`/camera/cameras/${id}`, { method: 'DELETE', headers: { authorization: H.authorization } });
    }
    // Let the removed cameras' identities age out before the next rung's baseline is taken.
    await sleep(3000);
  }
} finally {
  await restoreCapacity();
  await cleanup(true);
}

console.log('');
const first = rows[0];
check(rows.length === LADDER.length, 'every rung produced a measurement', `${rows.length}/${LADDER.length}`);
check(
  first !== undefined && first.createdTracks > 0,
  'the ladder actually tracked something',
  first ? `${first.createdTracks} identities at one camera` : 'no rows',
);
/*
 * ⚠️ Asserted at ONE camera only, and reported everywhere else. At one camera nothing competes for
 * CPU, so a broken tracker has no excuse. Higher rungs drop frames by design, and dropped frames
 * legitimately fragment identities — asserting stability there would be asserting that the host is
 * fast, which is a different claim and one this ladder is built to measure rather than require.
 */
check(
  first !== undefined && first.createdTracks > 0 && first.identityOverhead <= 1,
  'at one camera, one walking person produces one identity',
  first ? `${first.createdTracks} identities for 1 camera (overhead ${first.identityOverhead})` : 'no rows',
);
/*
 * ⚠️ Too FEW identities is a failure too, and the overhead metric cannot see it — `max(0, created −
 * cameras)` is zero both when the ladder is perfect and when it tracked nothing. Every rung must
 * produce at least one identity per camera, because every camera is playing a person.
 */
const starved = rows.find((r) => r.createdTracks < r.cameras);
check(
  starved === undefined,
  'every camera on every rung produced an identity',
  starved
    ? `${starved.cameras} cameras produced only ${starved.createdTracks} identities — cameras were not all streaming`
    : rows.map((r) => `${r.cameras}→${r.createdTracks}`).join(' · '),
);
const costly = rows.find((r) => (r.trackingMsAvg ?? 0) > 5);
check(
  costly === undefined,
  'tracking stays a rounding error beside inference',
  costly ? `${costly.trackingMsAvg}ms at ${costly.cameras} cameras` : `≤ ${Math.max(...rows.map((r) => r.trackingMsAvg ?? 0)).toFixed(3)}ms per frame`,
);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      windowSeconds: WINDOW,
      /*
       * ⚠️ The rung the control plane refused, beside the numbers. A ladder that stopped because a
       * runtime degraded under the previous rung's load found its edge; one that stopped because it
       * was configured to is a different statement, and a table that cannot tell you which is
       * unreadable a month later. `null` means the ladder ran to its configured top.
       */
      refusedAt,
      /*
       * ⚠️ The sizing policy travels WITH the measurements, because the two get separated. A table
       * of camera counts read on its own invites "it did 16, so sell 16" — and this ladder's rungs
       * are a synthetic clip that is far cheaper to decode than a real scene. The supported number
       * is 2. See docs/project/AI_RUNTIME_BENCHMARK.md.
       */
      sizingPolicy: {
        supported: 2,
        provisional: 4,
        rule: 'no sizing recommendation is published until three independent runs agree',
        note: 'this ladder measures IDENTITY under load, not the supported camera count',
      },
      /*
       * ⚠️ Named, not filled. This ladder is as blind to identity switching as production is; the
       * numbers live in tracking-truth.json, from clips whose trajectories were authored first.
       */
      groundTruth: {
        available: false,
        reason: 'a live ladder cannot know which real object each identity belonged to',
        measuredBy: 'docs/review/p8/tracking-truth.json',
      },
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(`\nsamples → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(failures === 0 ? '\ntracking capacity measured\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
