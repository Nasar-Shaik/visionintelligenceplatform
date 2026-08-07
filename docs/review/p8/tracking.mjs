/**
 * P-8 Phase 4 · **does object tracking actually hold an identity?**
 *
 *   node docs/review/p8/tracking.mjs           # the five identity properties, against real RTSP
 *   node docs/review/p8/tracking.mjs clean     # ⚠️ if a run was interrupted
 *   SCENARIOS=walk,crossing node …             # a subset, used by the mutation harness
 *
 * ### ⚠️ What makes this different from every other verification in this directory
 *
 * The others ask "did the platform produce an answer?". This asks "**was the answer right?**" — and
 * that is only a question you can ask when you already know the right answer. So the input is not a
 * camera and not a photograph: it is four clips with **authored trajectories**, built by
 * `tracking-fixtures.mjs`, played through real RTSP into the real frame path. The ground truth is
 * written down before the run, in `ground-truth.json`, and the assertions below are checked against
 * it rather than against whatever the platform happened to do.
 *
 * The five properties, which are the ones an operator actually depends on:
 *
 *   1. a continuously visible object keeps ONE track id
 *   2. an identity survives a brief occlusion
 *   3. an identity survives a temporary disappearance
 *   4. an identity that leaves for good is TERMINATED, and a return is a new id linked to the old
 *   5. two people crossing do not exchange identities
 *
 * ### ⚠️ Property 5 is the one that fails silently everywhere else
 *
 * A swap costs nothing visible: both people still have an id, the counts are still right, the
 * dashboard is still green. It is only wrong in the one place it matters — "who was that?". The
 * crossing clip therefore puts the two subjects at **different heights**, because after they cross,
 * left and right have swapped and position alone cannot distinguish a correct tracker from one that
 * exchanged the identities. Height does not swap.
 *
 * ### ⚠️ This file is the platform's ONLY source of accuracy numbers
 *
 * `/tracking` reports identity switches, re-identification success and false recoveries as `null`,
 * because on a live camera they are unanswerable (ADR-0039). They are answerable HERE, and only
 * here, because the trajectories were written down first. The run therefore emits
 * `tracking-truth.json` — six measurements the nightly report uses to fill those cells, carrying
 * the caveat that they certify the tracking LOGIC against authored clips and never the platform
 * against real CCTV (L-1).
 *
 * ⚠️ A metric whose scenario did not run stays `null`. The mutation harness runs subsets, and a
 * subset that scored 1.0 on something it never exercised would be precisely the lie this file
 * exists to prevent.
 *
 * ### ⚠️ Scenarios run ONE AT A TIME
 *
 * Measured capacity is two cameras and four is provisional ([AI_RUNTIME_BENCHMARK]). Running four
 * scenarios concurrently would drop frames, the dropped frames would break identities, and the run
 * would report a tracking defect that is really a capacity limit. Sequential costs three minutes and
 * measures the thing it claims to measure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assignCameras } from './_assign.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const B = process.env.BASE ?? 'https://localhost';
const TENANT = 'tnt_demo_retail';
const ADMIN = { email: 'security.manager@northgate.demo', password: '12345678' };
const MEDIA = 'vip-prod-media-1';
const FIXTURE = 'vip-tracking-fixture';
const NETWORK = 'vip-prod_default';
const TAG = 'p8-track';
const FIXTURE_DIR = join(ROOT, 'infra/docker/fixtures/media/tracking');
const OUT = process.env.OUT ?? join(ROOT, 'docs/review/p8/tracking-samples.json');
const TRUTH_OUT = process.env.TRUTH_OUT ?? join(ROOT, 'docs/review/p8/tracking-truth.json');
/** Seconds of clip to observe per scenario, and how often to read the live tracks. */
const OBSERVE = Number(process.env.OBSERVE ?? 26);
const POLL_MS = 1000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
 * Read the live tracks straight from the runtime.
 *
 * ⚠️ Through media with `$INTERNAL_API_KEY` expanded **inside** the container that already holds it
 * (ADR-0018) — the key never enters this process. Deliberately NOT through the gateway: this
 * verification is about the tracking engine, and going through two more hops would mean a gateway
 * or console defect could present as a tracking failure.
 */
function liveTracks(tenant = TENANT) {
  const raw = shq('docker', [
    'exec', MEDIA, 'sh', '-c',
    `curl -s -H "x-internal-key: $INTERNAL_API_KEY" -H "x-tenant-id: ${tenant}" ` +
      'http://inference:8085/tracking/tracks',
  ]);
  try {
    return JSON.parse(raw).data ?? { tracks: [] };
  } catch {
    return { tracks: [] };
  }
}

function trackingStats(tenant = TENANT) {
  const raw = shq('docker', [
    'exec', MEDIA, 'sh', '-c',
    `curl -s -H "x-internal-key: $INTERNAL_API_KEY" -H "x-tenant-id: ${tenant}" ` +
      'http://inference:8085/tracking',
  ]);
  try {
    return JSON.parse(raw).data ?? {};
  } catch {
    return {};
  }
}

async function cleanup(quiet = false) {
  await login();
  const r = await api(`/camera/cameras?limit=200&search=${TAG}`, { headers: H });
  const cams = (r.json?.data?.cameras ?? []).filter((c) => (c.metadata?.tags ?? []).includes(TAG));
  for (const cam of cams) {
    await api(`/media/streams/${cam.id}/stop`, { method: 'POST', headers: H, body: '{}' });
    await api(`/camera/cameras/${cam.id}`, {
      method: 'DELETE',
      headers: { authorization: H.authorization },
    });
  }
  shq('docker', ['rm', '-f', FIXTURE]);
  if (!quiet) console.log(`\nremoved ${cams.length} camera(s) and stopped the tracking fixture\n`);
}

if (process.argv[2] === 'clean') {
  await cleanup();
  process.exit(0);
}

/**
 * Watch one scenario end to end: start a camera on its RTSP path, poll the live tracks for the
 * observation window, then stop and remove the camera.
 *
 * Returns every observation, so an assertion can look at the WHOLE life of each identity rather than
 * its final state. ⚠️ That matters: a track that was briefly duplicated and then settled looks
 * perfect at the end and is a defect in the middle.
 */
async function watch(path, zoneId, seconds = OBSERVE) {
  const made = await api('/camera/cameras', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      zoneId,
      name: `${TAG} ${path}`,
      protocol: 'rtsp',
      streamUrl: `rtsp://${FIXTURE}:8554/${path}`,
      metadata: { tags: [TAG] },
    }),
  });
  const cameraId = made.json?.data?.id;
  if (cameraId === undefined) throw new Error(`could not create a camera for ${path}`);
  await api(`/media/streams/${cameraId}/start`, { method: 'POST', headers: H, body: '{}' });
  /* ⚠️ P-8 Phase 6: a camera with no assignment is never analysed. See `_assign.mjs`. */
  await assignCameras(api, H, [cameraId]);

  const observations = [];
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await sleep(POLL_MS);
    const live = liveTracks();
    observations.push({
      t: Math.round((Date.now() - started) / 100) / 10,
      tracks: (live.tracks ?? [])
        .filter((tr) => tr.cameraId === cameraId)
        .map((tr) => ({
          trackId: tr.trackId,
          identityId: tr.identityId,
          precededBy: tr.precededBy,
          recoveries: tr.recoveries ?? 0,
          state: tr.state,
          label: tr.label,
          hits: tr.hits,
          centroid: tr.centroid ?? [tr.bbox[0] + tr.bbox[2] / 2, tr.bbox[1] + tr.bbox[3] / 2],
          motion: tr.motion ?? null,
          schemaVersion: tr.schemaVersion,
        })),
    });
  }

  await api(`/media/streams/${cameraId}/stop`, { method: 'POST', headers: H, body: '{}' });
  await api(`/camera/cameras/${cameraId}`, {
    method: 'DELETE',
    headers: { authorization: H.authorization },
  });
  return { cameraId, observations };
}

/** Every distinct track id seen, in first-seen order. */
function identities(observations) {
  const seen = [];
  for (const obs of observations) {
    for (const tr of obs.tracks) if (!seen.includes(tr.trackId)) seen.push(tr.trackId);
  }
  return seen;
}

/** The last observation of a given track id. */
function lastOf(observations, trackId) {
  let out = null;
  for (const obs of observations) {
    for (const tr of obs.tracks) if (tr.trackId === trackId) out = tr;
  }
  return out;
}

/** Observations in which anything at all was tracked — the denominator for coverage. */
const coverage = (observations) => observations.filter((o) => o.tracks.length > 0).length;

// ── the run ──────────────────────────────────────────────────────────────────────────────────────

await login();
await cleanup(true);

if (!existsSync(join(FIXTURE_DIR, 'ground-truth.json'))) {
  console.log('\ntracking fixtures are missing — generating them first\n');
  sh('node', [join(ROOT, 'docs/review/p8/tracking-fixtures.mjs'), '--verify'], { stdio: 'inherit' });
}
const truth = JSON.parse(readFileSync(join(FIXTURE_DIR, 'ground-truth.json'), 'utf8'));

console.log('\nP-8 Phase 4 · object tracking against authored ground truth\n');
console.log(`  ⚠️ ${truth.warning}\n`);

shq('docker', ['rm', '-f', FIXTURE]);
sh('docker', [
  'run', '-d', '--rm', '--name', FIXTURE, '--network', NETWORK,
  '-v', `${ROOT}/infra/docker/fixtures/tracking-fixture.yml:/mediamtx.yml:ro`,
  '-v', `${ROOT}/infra/docker/fixtures/media:/fixtures/media:ro`,
  'bluenviron/mediamtx:latest-ffmpeg',
]);
await sleep(3000);

const zoneId = (await api('/camera/cameras?limit=1', { headers: H })).json.data.cameras[0].zoneId;
const wanted = (process.env.SCENARIOS ?? 'walk,occlusion,reentry,crossing')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const results = {};

/**
 * The six ground-truth measurements, and the ONLY place on this platform they can be made.
 *
 * ⚠️ **Every one of these is unanswerable on a live camera**, which is why `/tracking` reports three
 * of them as `null` (ADR-0039). They are answerable here for exactly one reason: the trajectories
 * were written down before the run. `ground-truth.json` says one person walks left to right, that
 * nobody leaves during the crossing clip, that the subject in the re-entry clip genuinely departs.
 * Against that, "was the tracker right?" has an answer.
 *
 * ⚠️ **A metric whose scenario did not run stays `null`.** The mutation harness runs subsets, and a
 * subset that scored 1.0 on a metric nothing exercised would be the exact failure this file exists
 * to prevent.
 */
const measured = {
  identityStability: null,
  reidentificationSuccess: null,
  occlusionRecovery: null,
  crossingCorrectness: null,
  identitySwitches: null,
  terminationCorrectness: null,
  falseRecoveries: null,
};
const basis = {};

const record = (metric, value, scenario, detail) => {
  measured[metric] = value;
  basis[metric] = { scenario, detail };
};

try {
  // ── 1 · a continuously visible object keeps ONE identity ──────────────────────────────────────
  if (wanted.includes('walk')) {
    console.log(`1 · stable identity — one person crossing, always visible (${OBSERVE}s)`);
    const { observations } = await watch('walk', zoneId);
    const ids = identities(observations);
    const seen = coverage(observations);
    results.walk = { ids, observations: observations.length, tracked: seen };

    check(seen >= OBSERVE * 0.5, 'the subject was tracked for most of the window',
      `${seen}/${observations.length} polls had a live track`);
    check(ids.length === 1, 'a continuously visible person holds exactly ONE track id',
      ids.length === 1 ? ids[0] : `${ids.length} ids: ${ids.join(', ')}`);

    const last = ids.length > 0 ? lastOf(observations, ids[0]) : null;
    check(last?.schemaVersion === '1.1', 'every track carries its schema version',
      last?.schemaVersion ?? 'absent');
    check(last?.identityId === ids[0], 'a first appearance is its own identity',
      `identityId=${last?.identityId ?? 'absent'}`);
    check(last?.motion != null && last.motion.pathLengthNormalized > 0,
      'movement was measured, not merely present',
      last?.motion ? `travelled ${last.motion.pathLengthNormalized.toFixed(3)} fw, heading ${last.motion.headingLabel}` : 'no motion');
    /*
     * ⚠️ The subject walks LEFT TO RIGHT in this clip, by construction. A tracker that reported
     * "left" here would be producing a plausible-looking heading from a correct path, which is
     * exactly the kind of defect a smoke test misses.
     */
    check(last?.motion?.headingLabel === 'right', 'the measured direction matches the authored one',
      last?.motion?.headingLabel ?? 'not measured');
    /*
     * ⚠️ Ground truth: the clip contains exactly ONE person. So the ideal identity count is 1, and
     * anything above it is fragmentation measured against a known answer rather than guessed at
     * from a ratio. 1.0 is perfect; 0.5 means the person became two identities.
     */
    record('identityStability', ids.length > 0 ? Number((1 / ids.length).toFixed(4)) : 0,
      'walk', `1 authored person → ${ids.length} identity(ies)`);
    console.log('');
  }

  // ── 2 · an identity survives a brief occlusion ────────────────────────────────────────────────
  if (wanted.includes('occlusion')) {
    console.log(`2 · occlusion — the same person walks behind a pillar and out again (${OBSERVE}s)`);
    const { observations } = await watch('occlusion', zoneId);
    const ids = identities(observations);
    const everLost = observations.some((o) => o.tracks.some((t) => t.state === 'lost'));
    results.occlusion = { ids, everLost, observations: observations.length, tracked: coverage(observations) };

    /*
     * ⚠️ Asserted FIRST, because it is what makes the next assertion mean anything. If the pillar
     * never actually hid the subject, "one identity" is true and proves nothing — the scenario would
     * have quietly degraded into the walk test.
     */
    check(everLost, 'the occlusion really happened — the track was observed in the `lost` state',
      everLost ? 'the engine held the identity open' : 'the subject was never lost; the pillar hid nothing');
    check(ids.length === 1, 'the identity SURVIVES the occlusion — one id across the gap',
      ids.length === 1 ? ids[0] : `${ids.length} ids: ${ids.join(', ')}`);
    /*
     * ⚠️ Scored 0 when the pillar hid nothing, NOT 1. A run where the occlusion never happened has
     * not demonstrated recovery — it has demonstrated a walk — and crediting it would let a broken
     * fixture certify the mechanism it was supposed to test.
     */
    record('occlusionRecovery', everLost && ids.length === 1 ? 1 : 0, 'occlusion',
      everLost ? `${ids.length} identity(ies) across an observed gap` : 'the subject was never lost');
    console.log('');
  }

  // ── 3 + 4 · disappearance, termination, and a linked return ───────────────────────────────────
  if (wanted.includes('reentry')) {
    /*
     * ⚠️ A LONGER window than the other scenarios, and it has to be. The clip's subject leaves at
     * t=20s and returns at t=30s, so the default 26-second window closes before the return — the run
     * then reports "re-entry was not observed" and looks like a tracking defect when the only defect
     * is that nobody watched long enough. Found exactly that way: the first run printed a duration
     * it was not actually using.
     */
    const window = OBSERVE + 20;
    const budget = trackingStats().engine?.reentryGapSeconds ?? 12;
    console.log(`3 · disappearance and return — the person leaves the frame and comes back (${window}s)`);
    const { observations } = await watch('reentry', zoneId, window);
    const ids = identities(observations);
    const returned = ids.length > 1 ? lastOf(observations, ids[ids.length - 1]) : null;
    const firstGone = observations.some(
      (o, i) => i > 0 && o.tracks.length === 0 && observations[i - 1].tracks.length > 0,
    );
    results.reentry = {
      ids,
      firstGone,
      linked: returned?.identityId === ids[0],
      precededBy: returned?.precededBy ?? null,
      observations: observations.length,
    };

    /*
     * ⚠️ The gap is MEASURED and printed, because it is the single number that decides whether a
     * re-entry link is even eligible — and when the link does not form, "no link" and "the gap was
     * longer than the budget" are completely different findings. The first is a defect; the second
     * is a scenario that walked outside the engine's configured window, which the run must say
     * plainly rather than report as a broken tracker.
     */
    const lastSeenFirst = observations.findLastIndex((o) => o.tracks.some((t) => t.trackId === ids[0]));
    const firstSeenSecond =
      ids.length > 1 ? observations.findIndex((o) => o.tracks.some((t) => t.trackId === ids[1])) : -1;
    const gapSeconds =
      lastSeenFirst >= 0 && firstSeenSecond >= 0
        ? observations[firstSeenSecond].t - observations[lastSeenFirst].t
        : null;
    results.reentry.gapSeconds = gapSeconds;
    if (gapSeconds !== null) {
      console.log(`  · measured absence: ${gapSeconds.toFixed(1)}s (engine re-entry window is ${budget}s)`);
    }

    check(firstGone, 'the subject genuinely left — a poll saw no live track at all',
      firstGone ? 'the frame emptied' : 'the subject never left the frame');
    check(ids.length >= 2, 'a return after termination gets a NEW track id — ids are never reused',
      `${ids.length} id(s): ${ids.join(' → ')}`);
    if (ids.length >= 2) {
      check(returned?.precededBy === ids[0], 'the returning track names its predecessor',
        `precededBy=${returned?.precededBy ?? 'absent'} (expected ${ids[0]})`);
      check(returned?.identityId === ids[0], 'the IDENTITY is preserved across the gap',
        `identityId=${returned?.identityId ?? 'absent'}`);
      check((returned?.recoveries ?? 0) >= 1, 'the recovery is counted', `recoveries=${returned?.recoveries ?? 0}`);
    } else {
      finding('re-entry was not observed',
        'the subject did not return within the window, or the gap fell outside the re-entry budget');
    }
    if (gapSeconds !== null && gapSeconds > budget) {
      finding('the absence exceeded the engine budget',
        `${gapSeconds.toFixed(1)}s absent against a ${budget}s re-entry window — no link is EXPECTED here, ` +
          'and this scenario is measuring the budget rather than the linking logic');
    }

    /*
     * ⚠️ Two DIFFERENT questions, scored separately.
     *
     * Termination correctness asks whether the departed identity was retired — the subject left, so
     * a track that stayed alive is wrong regardless of what happened next.
     *
     * Re-identification success asks whether the return was linked to the right predecessor. It is
     * scored only when a link was even eligible: an absence longer than the engine's window means
     * NO link is the correct answer, and scoring that as a failure would penalise the tracker for
     * obeying its own configuration. `null` — not 0 — when the scenario could not pose the question.
     */
    record('terminationCorrectness', firstGone && ids.length >= 2 ? 1 : 0, 'reentry',
      firstGone ? `${ids.length} id(s), the first retired on departure` : 'the subject never left');
    if (gapSeconds !== null && gapSeconds > budget) {
      basis.reidentificationSuccess = {
        scenario: 'reentry',
        detail: `not eligible — ${gapSeconds.toFixed(1)}s absence exceeds the ${budget}s window`,
      };
    } else if (ids.length >= 2) {
      record('reidentificationSuccess', returned?.identityId === ids[0] ? 1 : 0, 'reentry',
        `identityId=${returned?.identityId ?? 'absent'} against predecessor ${ids[0]}`);
    }
    console.log('');
  }

  // ── 5 · two people crossing do not exchange identities ────────────────────────────────────────
  if (wanted.includes('crossing')) {
    console.log(`4 · crossing — two people walk through each other's path (${OBSERVE}s)`);
    const { observations } = await watch('crossing', zoneId);
    const ids = identities(observations);
    results.crossing = { ids, observations: observations.length, tracked: coverage(observations) };

    check(ids.length >= 2, 'both people were tracked', `${ids.length} id(s)`);

    /*
     * ⚠️ The swap test, and the reason the two walk at different heights.
     *
     * After the crossing, left and right have exchanged places — so a tracker that swapped the two
     * identities produces exactly the same left/right sequence as a correct one. Height does not
     * swap: whoever started high must still be high at the end. Each identity's observed y values
     * are therefore checked for a jump between the two bands.
     */
    const byId = new Map();
    for (const obs of observations) {
      for (const tr of obs.tracks) {
        if (!byId.has(tr.trackId)) byId.set(tr.trackId, []);
        byId.get(tr.trackId).push(tr.centroid[1]);
      }
    }
    let swapped = 0;
    const spans = [];
    for (const [id, ys] of byId) {
      const span = Math.max(...ys) - Math.min(...ys);
      spans.push({ id, span: Number(span.toFixed(3)), samples: ys.length });
      // The two lanes are ~0.22 of frame height apart; a track that moves more than half that
      // vertically has changed lane, which is what an exchanged identity looks like.
      if (ys.length >= 3 && span > 0.11) swapped += 1;
    }
    results.crossing.lanes = spans;
    check(swapped === 0, 'no identity changed lane — the two people did not swap',
      swapped === 0
        ? `vertical spread ${spans.map((s) => s.span.toFixed(3)).join(', ')}`
        : `${swapped} track(s) crossed between lanes: ${JSON.stringify(spans)}`);

    /*
     * ⚠️ **`identitySwitches` as an actual COUNT** — the metric `/tracking` reports as `null`. It is
     * countable here and nowhere else: the clip authored two people into two vertical lanes, so a
     * track that changes lane has taken the other person's identity. On a live camera the same
     * event is invisible.
     */
    record('identitySwitches', swapped, 'crossing', `${spans.length} track(s) examined by lane`);
    record('crossingCorrectness', ids.length >= 2 && swapped === 0 ? 1 : 0, 'crossing',
      `${ids.length} identity(ies), ${swapped} lane change(s)`);
    /*
     * ⚠️ **`falseRecoveries` is reported `null` here, and finding out why was the point.**
     *
     * The intent was sound: nobody leaves and returns in this clip, so any re-entry link formed
     * would be wrong by construction. The check was then written, ran green — and a mutation that
     * opened the re-entry gate to 10 000 seconds and ten frame-widths **left it green**.
     *
     * The reason is that a link needs a *departed* identity to link back TO. Both subjects appear at
     * the start of this clip and neither is retired inside the window, so the resolver never holds a
     * candidate and no gate width can produce a link. The check could not fail. A check that cannot
     * fail is worth less than no check, because it reports the same green as a real one.
     *
     * So the count is recorded only when the scenario actually presented the opportunity, and is
     * `null` otherwise — ADR-0039 applied to a metric of this file's own making. See
     * L-45 in KNOWN_LIMITATIONS; measuring it needs a fixture where a genuine stranger arrives after a departure, and
     * ⚠️ authoring one is not free: under L-42 re-entry is appearance-blind, so a stranger arriving
     * near the exit point inside the window SHOULD link, and a naive clip would assert against
     * documented correct behaviour.
     */
    const linked = observations
      .flatMap((o) => o.tracks)
      .filter((t) => (t.recoveries ?? 0) > 0 || t.precededBy != null)
      .map((t) => t.trackId);
    const departures = observations.filter(
      (o, i) => i > 0 && o.tracks.length < observations[i - 1].tracks.length,
    ).length;
    if (departures > 0) {
      record('falseRecoveries', new Set(linked).size, 'crossing',
        `${departures} departure(s) created a re-entry opportunity in a clip where nobody returns`);
      check(new Set(linked).size === 0, 'no FALSE re-entry link was formed — nobody left this clip',
        linked.length === 0 ? 'no track claimed a predecessor' : [...new Set(linked)].join(', '));
    } else {
      basis.falseRecoveries = {
        scenario: 'crossing',
        detail: 'not measurable — no identity was retired, so no link could form either way',
      };
      console.log('  · falseRecoveries not measurable here — nobody departed, so no link was possible');
    }
    console.log('');
  }

  // ── the runtime's own account of it ────────────────────────────────────────────────────────────
  console.log('5 · what the runtime reports about itself');
  const stats = trackingStats();
  results.stats = stats.stats ?? {};
  results.engine = stats.engine ?? {};
  check(stats.enabled === true, 'tracking reports itself enabled');
  check((stats.stats?.createdTracks ?? 0) > 0, 'the runtime counted the identities it created',
    `created ${stats.stats?.createdTracks ?? 0}, recovered ${stats.stats?.recoveredTracks ?? 0}`);
  /*
   * ⚠️ Out-of-order frames are reported, not asserted to be zero. Media runs up to four requests in
   * flight, so on a busy camera they genuinely happen — the platform counts and skips them, which is
   * correct. A hard zero here would be a flaky assertion about scheduling rather than about tracking.
   */
  const ooo = stats.stats?.outOfOrderFrames ?? 0;
  if (ooo > 0) finding('frames arrived out of order', `${ooo} skipped rather than tracked backwards`);
  else console.log('  · no frames arrived out of order in this run');
  console.log('');
} finally {
  await cleanup(true);
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    { at: new Date().toISOString(), observeSeconds: OBSERVE, groundTruth: truth.scenarios, results, findings },
    null,
    2,
  )}\n`,
);

/*
 * ⚠️ A SEPARATE file, and separate on purpose. `tracking-samples.json` is a record of a run;
 * this is the platform's only source of accuracy numbers, and the nightly report reads it to fill
 * the three cells `/tracking` reports as `null`. Keeping them apart means a report can never
 * accidentally source an accuracy figure from a live runtime's statistics.
 */
writeFileSync(
  TRUTH_OUT,
  `${JSON.stringify(
    {
      at: new Date().toISOString(),
      scenariosRun: wanted,
      /*
       * ⚠️ Carried with the numbers so nobody has to go looking for it. These are measurements
       * against AUTHORED clips — synthetic sprites on a plain background, with trajectories written
       * down in advance. They say the tracking logic is correct on the scenarios it was given. They
       * do NOT say what the tracker does on real CCTV; no camera has ever been connected (L-1).
       */
      caveat:
        'measured against authored synthetic clips, not real CCTV. These certify the tracking ' +
        'logic against known trajectories — never the platform against real footage (L-1).',
      metrics: measured,
      basis,
    },
    null,
    2,
  )}\n`,
);

console.log('');
console.log('6 · ground truth — the questions a live camera cannot answer');
for (const [metric, value] of Object.entries(measured)) {
  const where = basis[metric];
  console.log(
    value === null
      ? `  · ${metric} — not measured${where ? ` (${where.detail})` : ' (scenario did not run)'}`
      : `  ✓ ${metric} = ${value}${where ? ` — ${where.detail}` : ''}`,
  );
}
console.log('');

console.log(`samples → ${OUT.replace(`${ROOT}/`, '')}`);
console.log(`ground truth → ${TRUTH_OUT.replace(`${ROOT}/`, '')}`);
console.log(
  failures === 0
    ? `\ntracking holds identity across all ${wanted.length} authored scenarios\n`
    : `\n${failures} tracking check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
