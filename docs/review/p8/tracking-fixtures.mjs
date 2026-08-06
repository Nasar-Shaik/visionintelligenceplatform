/**
 * Motion fixtures for tracking verification (P-8 Phase 4).
 *
 * ### ⚠️ Why these have to exist
 *
 * The RTSP fixture the platform has measured against since Phase 3 is `mediamtx` looping a **still
 * photograph**. Nothing in it moves. That is exactly right for measuring throughput and for proving
 * the detector finds two people — and it is completely useless for tracking, because every identity
 * question is about change over time:
 *
 *   - do track ids stay stable?          nothing moves, so nothing can destabilise them
 *   - do ids survive occlusion?          nothing ever occludes anything
 *   - do ids survive a disappearance?    nobody ever leaves
 *   - do ids terminate correctly?        nothing ever ends
 *   - do two people crossing swap?       nobody crosses
 *
 * A tracker verified against a still image is verified against none of its own behaviour. So this
 * generates short clips with **authored trajectories** and writes the ground truth beside them.
 *
 * ### ⚠️ What these are, said plainly
 *
 * Real person pixels — cropped from the same CC0 photograph, at the exact boxes the deployed model
 * detects — composited onto a plain background along scripted paths, encoded as H.264, and served
 * over **real RTSP** through the same `mediamtx → ffmpeg → JPEG → runtime` path production uses.
 *
 * They are **not** real CCTV footage and nothing here weakens [L-1]. A composited sprite has no
 * motion blur, no lighting change, no perspective change and no gait. It proves the tracking *logic*
 * behaves correctly on known input; it proves nothing about how the tracker performs on a real
 * camera, which is P-9's job. That distinction is the whole reason the ground truth is authored: on
 * real footage nobody knows the right answer, so nothing can be asserted — only observed.
 *
 * ### ⚠️ The sprites come from the detector, not from my eyes
 *
 * The crop boxes are obtained by running `scene-people.jpg` through the **deployed runtime** and
 * using the boxes it returns. Cropping by hand would risk building a fixture the model cannot see,
 * and a tracking test that fails because the detector found nothing tells you nothing about tracking.
 *
 * Usage:
 *   node docs/review/p8/tracking-fixtures.mjs            # generate into the fixtures dir
 *   node docs/review/p8/tracking-fixtures.mjs --verify   # generate, then assert each clip detects
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const MEDIA = 'vip-prod-media-1';
const SCENE = join(ROOT, 'infra/docker/fixtures/media/scene-people.jpg');
const OUT_DIR = join(ROOT, 'infra/docker/fixtures/media/tracking');
const FFMPEG_IMAGE = 'bluenviron/mediamtx:latest-ffmpeg';
const TENANT = process.env.TENANT ?? 'tnt_demo_retail';

/** Source frame geometry. Everything below is in source pixels. */
const W = 640;
const H = 360;
const FPS = 15;
/** ⚠️ Long enough that a 45-second observation window never reaches the end of the clip. A stream
 *  that ends mid-window makes media reconnect, and a reconnect looks exactly like a lost camera. */
const DURATION = 70;

/** Sprite height in the output frame. Large enough for yolox-nano at 416×416 to be reliable. */
const SPRITE_H = 190;
/**
 * The occlusion walker crosses in 30 s rather than 70.
 *
 * ⚠️ Speed is what decides whether this scenario tests occlusion RECOVERY or track TERMINATION, and
 * the two are opposite assertions. The engine holds a lost identity for `maxAgeFrames` (8) which at
 * the deployment's 2 fps is about four seconds. A slow walker spends longer than that behind the
 * pillar, the track is correctly removed, and the scenario would be asserting the wrong behaviour
 * while looking entirely reasonable. Crossing faster keeps the blind window comfortably inside the
 * budget — and `--verify` MEASURES the window rather than trusting this arithmetic.
 */
const OCCLUSION_TRAVERSE = 22;
/** A background the detector must find nothing in — asserted by `--verify`, never assumed. */
const BACKGROUND = '0x5a5f66';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

/** Run ffmpeg inside the fixture image — the host has none, and adding one would be a new dependency. */
function ffmpeg(args, mounts = []) {
  return sh('docker', [
    'run', '--rm',
    ...mounts.flatMap((m) => ['-v', m]),
    '--entrypoint', 'ffmpeg',
    FFMPEG_IMAGE,
    '-hide_banner', '-loglevel', 'error', '-y',
    ...args,
  ]);
}

/**
 * Ask the DEPLOYED runtime where the people are.
 *
 * ⚠️ Through media, with `$INTERNAL_API_KEY` expanded **inside** the container that already holds it
 * (ADR-0018). The key is never read into this process.
 */
function detect(jpegPath) {
  const body = {
    capabilityId: 'perception.person-detection',
    context: { tenantId: TENANT },
    frame: { cameraId: 'fixture-probe', seq: 1, capturedAt: new Date().toISOString(), source: 'probe' },
    imageBase64: readFileSync(jpegPath).toString('base64'),
  };
  const staged = join(tmpdir(), `p8-fixture-${process.pid}.json`);
  writeFileSync(staged, JSON.stringify(body));
  try {
    sh('docker', ['cp', staged, `${MEDIA}:/tmp/p8-fixture.json`]);
    const raw = sh('docker', [
      'exec', MEDIA, 'sh', '-c',
      'curl -s -X POST http://inference:8085/infer -H "content-type: application/json" ' +
        '-H "x-internal-key: $INTERNAL_API_KEY" --data-binary @/tmp/p8-fixture.json',
    ]);
    return JSON.parse(raw).data?.detections ?? [];
  } finally {
    try { unlinkSync(staged); } catch { /* best effort */ }
  }
}

/** Even dimensions, because H.264 requires them and the failure is a cryptic encoder error. */
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function extractSprites() {
  mkdirSync(OUT_DIR, { recursive: true });
  const people = detect(SCENE)
    .filter((d) => d.label === 'person')
    .sort((a, b) => a.bbox[0] - b.bbox[0]);
  if (people.length < 2) {
    throw new Error(
      `the fixture photograph produced ${people.length} person detection(s); two are needed to build ` +
        'a crossing scenario. The scene or the model changed.',
    );
  }
  const sprites = [];
  people.slice(0, 2).forEach((person, index) => {
    const [x, y, w, h] = person.bbox;
    const crop = {
      x: Math.max(0, Math.floor(x * W)),
      y: Math.max(0, Math.floor(y * H)),
      w: even(Math.min(W, w * W)),
      h: even(Math.min(H, h * H)),
    };
    const path = join(OUT_DIR, `person-${index + 1}.png`);
    ffmpeg(
      ['-i', '/f/scene-people.jpg', '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, `/out/person-${index + 1}.png`],
      [`${join(ROOT, 'infra/docker/fixtures/media')}:/f:ro`, `${OUT_DIR}:/out`],
    );
    sprites.push({ path, crop, confidence: person.confidence });
  });
  return sprites;
}

/**
 * The four scenarios, each with the ground truth an assertion can be written against.
 *
 * ⚠️ Timings are in **seconds of clip**, and the runtime samples at 2 fps — so a 3-second occlusion
 * is about 6 analysed frames. Every window below is chosen against the engine's configured
 * `maxAgeFrames` (8 at 2 fps ≈ 4 s), because a scenario that accidentally sits on the boundary tests
 * the boundary rather than the behaviour.
 */
function scenarios(sprites) {
  const [a, b] = sprites;
  const aspect = (s) => (s.crop.w / s.crop.h) * SPRITE_H;
  const wA = even(aspect(a));

  return [
    {
      id: 'walk',
      title: 'One person crosses, continuously visible',
      /** What must be true, in the language the verification asserts. */
      expect: {
        identities: 1,
        survivesOcclusion: false,
        ends: false,
        note: 'A single object visible in every frame must hold exactly one track id.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]overlay=x='-${wA}+(${W + wA * 2})*(t/${DURATION})':y=${H - SPRITE_H - 20}`,
    },
    {
      id: 'occlusion',
      title: 'One person walks behind a pillar and out the other side',
      expect: {
        identities: 1,
        survivesOcclusion: true,
        ends: false,
        // 55 px of full occlusion at ~11 px/s ≈ 5 s, ≈ 10 analysed frames at 2 fps.
        note: 'The identity must survive the gap. A new id here is the defect predictive association exists to prevent.',
      },
      inputs: [a.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]overlay=x='min(-${wA}+(${W + wA * 2})*(t/${OCCLUSION_TRAVERSE}), ${W + wA * 2})':y=${H - SPRITE_H - 20}[o];` +
        // ⚠️ The pillar is drawn AFTER the overlay, so it genuinely hides the person rather than
        // sitting behind them. A pillar underneath would occlude nothing and the test would pass
        // for the wrong reason.
        `[o]drawbox=x=${Math.round(W * 0.44)}:y=0:w=${Math.round(W * 0.2)}:h=${H}:color=0x2b2f36:t=fill`,
    },
    {
      id: 'exit-reentry',
      title: 'One person leaves the frame and comes back',
      expect: {
        identities: 2,
        survivesOcclusion: false,
        ends: true,
        linked: true,
        note:
          'The identity must END and a NEW track id must appear — ids are never reused. The two must ' +
          'be linked by identityId, because the same person came back.',
      },
      inputs: [a.path],
      /*
       * Out of frame from t=20 to t=27 — seven seconds. ⚠️ Chosen between two thresholds on purpose:
       * longer than `maxAgeFrames` (≈4 s), so the track genuinely terminates rather than coasting;
       * shorter than the re-entry window (12 s), so the return is eligible to be linked. A gap that
       * satisfied only one of those would test only half the behaviour.
       */
      filter:
        `[1:v]scale=-2:${SPRITE_H}[p];` +
        `[0:v][p]overlay=x='if(lt(t,20), -${wA}+(${W + wA})*(t/20), if(lt(t,27), ${W + wA * 2}, ${W} - (${W}-${Math.round(W * 0.2)})*((t-27)/25)))':` +
        `y=${H - SPRITE_H - 20}`,
    },
    {
      id: 'crossing',
      title: 'Two people walk toward each other and cross',
      expect: {
        identities: 2,
        survivesOcclusion: false,
        ends: false,
        noSwap: true,
        /*
         * ⚠️ The two walk at DIFFERENT heights, and that is what makes the assertion possible. After
         * they cross, "left" and "right" have swapped, so position alone cannot tell a correct
         * tracker from one that exchanged the identities. Height does not swap: whoever started high
         * must still be high at the end. Without this the scenario would look rigorous and assert
         * nothing.
         */
        note: 'Each identity must keep its own height throughout. A swap shows as a track that changes rows.',
        highY: (H - SPRITE_H - 90) / H,
        lowY: (H - SPRITE_H - 10) / H,
      },
      inputs: [a.path, b.path],
      filter:
        `[1:v]scale=-2:${SPRITE_H}[pa];[2:v]scale=-2:${SPRITE_H}[pb];` +
        `[0:v][pa]overlay=x='${Math.round(W * 0.1)}+(${Math.round(W * 0.6)})*(t/${DURATION})':y=${H - SPRITE_H - 90}[t1];` +
        `[t1][pb]overlay=x='${Math.round(W * 0.7)}-(${Math.round(W * 0.6)})*(t/${DURATION})':y=${H - SPRITE_H - 10}`,
    },
  ];
}

function build(scenario) {
  /*
   * ⚠️ `-loop 1` on every sprite, and NOT `shortest` on the overlay. A PNG is a single frame, so an
   * overlay told to stop with the shortest input stops after one frame — measured: `walk.mp4` came
   * out as a 1.6 kB clip containing nothing, and the scenario silently had no motion to track.
   */
  const inputs = scenario.inputs.flatMap((p) => ['-loop', '1', '-i', `/out/${p.split('/').pop()}`]);
  ffmpeg(
    [
      '-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${W}x${H}:r=${FPS}:d=${DURATION}`,
      ...inputs,
      '-filter_complex', scenario.filter,
      '-t', String(DURATION),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(FPS * 2),
      `/out/${scenario.id}.mp4`,
    ],
    [`${OUT_DIR}:/out`],
  );
  return join(OUT_DIR, `${scenario.id}.mp4`);
}

/**
 * ⚠️ Prove the fixture before trusting a test built on it.
 *
 * Two things are checked against the **deployed model**: that the empty background produces ZERO
 * detections (otherwise a "person" in a later assertion might be the wallpaper), and that a frame
 * from the middle of each clip produces the expected number of people. A tracking suite running on
 * a fixture the detector cannot see would fail for reasons that have nothing to do with tracking,
 * and the failure would be blamed on the tracker.
 */
function verify(scenarioList) {
  const frameDir = join(OUT_DIR, 'frames');
  mkdirSync(frameDir, { recursive: true });
  let failures = 0;

  ffmpeg(
    [
      '-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${W}x${H}`,
      '-frames:v', '1',
      // ⚠️ mjpeg refuses limited-range YUV outright rather than converting.
      '-pix_fmt', 'yuvj420p',
      '/out/frames/background.jpg',
    ],
    [`${OUT_DIR}:/out`],
  );
  const background = detect(join(frameDir, 'background.jpg')).filter((d) => d.label === 'person');
  if (background.length === 0) {
    console.log('  ✓ the empty background produces zero person detections');
  } else {
    console.log(`  ✗ the background alone produced ${background.length} person detection(s) — the fixture is unusable`);
    failures += 1;
  }

  for (const scenario of scenarioList) {
    /*
     * ⚠️ Probed where the subject is KNOWN to be visible, per scenario. The first version probed
     * every clip at its midpoint, which for the occlusion scenario is the exact moment the person is
     * correctly hidden — so a working fixture reported "model found 0" and looked broken.
     */
    const at = { 'exit-reentry': 10, occlusion: 5, crossing: Math.round(DURATION / 2) }[scenario.id] ??
      Math.round(DURATION / 2);
    ffmpeg(
      [
        '-ss', String(at), '-i', `/out/${scenario.id}.mp4`,
        '-frames:v', '1', '-pix_fmt', 'yuvj420p',
        `/out/frames/${scenario.id}.jpg`,
      ],
      [`${OUT_DIR}:/out`],
    );
    const found = detect(join(frameDir, `${scenario.id}.jpg`)).filter((d) => d.label === 'person');
    const wanted = scenario.id === 'crossing' ? 2 : 1;
    if (found.length === wanted) {
      console.log(
        `  ✓ ${scenario.id.padEnd(13)} ${found.length} person at t=${at}s ` +
          `(confidence ${found.map((d) => d.confidence.toFixed(2)).join(', ')})`,
      );
    } else {
      console.log(`  ✗ ${scenario.id.padEnd(13)} expected ${wanted} person at t=${at}s, model found ${found.length}`);
      failures += 1;
    }
  }
  failures += measureOcclusionWindow(frameDir);
  return failures;
}

/**
 * How long is the subject actually invisible behind the pillar?
 *
 * ⚠️ **Measured, not computed.** The arithmetic above says the fully-obscured window is about a
 * second, but partial occlusion also defeats a detector and nobody knows in advance at what fraction
 * of a body yolox-nano stops firing. If the real blind window exceeds `maxAgeFrames`, the engine is
 * *correct* to end the track — and an "identity survives occlusion" assertion built on that fixture
 * would be asserting a behaviour the scenario does not actually produce, then failing honestly and
 * being blamed on the tracker.
 *
 * So the clip is sampled every half second across the pillar and the blind run is reported. The
 * budget below is the engine's own `maxAgeFrames` expressed in seconds at the deployment's 2 fps.
 */
function measureOcclusionWindow(frameDir) {
  const budgetSeconds = 4;
  const samples = [];
  /*
   * ⚠️ The window is derived from the traverse, not fixed. A fixed 6–26 s window measured 3.5 s of
   * blindness at a 30 s traverse and 7.5 s at 22 s — the *faster* walker appearing to be hidden for
   * longer, which is impossible. The window had simply run past the end of the walk, so "has left
   * the frame" was being counted as "is behind the pillar". Scaling with the traverse keeps the
   * samples inside the part of the clip where the subject is on screen.
   */
  const from = OCCLUSION_TRAVERSE * 0.12;
  const to = OCCLUSION_TRAVERSE * 0.88;
  for (let t = from; t <= to; t += 0.5) {
    const name = `occ-${t.toFixed(1).replace('.', '_')}.jpg`;
    ffmpeg(
      ['-ss', String(t), '-i', '/out/occlusion.mp4', '-frames:v', '1', '-pix_fmt', 'yuvj420p', `/out/frames/${name}`],
      [`${OUT_DIR}:/out`],
    );
    const seen = detect(join(frameDir, name)).filter((d) => d.label === 'person').length;
    samples.push({ t, seen });
  }
  let longest = 0;
  let run = 0;
  for (const s of samples) {
    run = s.seen === 0 ? run + 0.5 : 0;
    longest = Math.max(longest, run);
  }
  const visible = samples.filter((s) => s.seen > 0).length;
  console.log(
    `  · occlusion measured: blind for ${longest.toFixed(1)}s · detected in ${visible}/${samples.length} samples`,
  );
  if (longest === 0) {
    console.log('  ✗ the pillar never actually hides the subject — the scenario tests nothing');
    return 1;
  }
  if (longest >= budgetSeconds) {
    console.log(
      `  ✗ blind for ${longest.toFixed(1)}s, which is at or past the ${budgetSeconds}s the engine holds a ` +
        'lost identity. This clip tests TERMINATION, not occlusion recovery.',
    );
    return 1;
  }
  console.log(`  ✓ blind window ${longest.toFixed(1)}s is inside the ${budgetSeconds}s the engine holds an identity`);
  return 0;
}

function main() {
  if (!existsSync(SCENE)) throw new Error(`missing ${SCENE}`);
  console.log('\nBuilding tracking fixtures from the pixels the deployed model detects\n');

  const sprites = extractSprites();
  console.log(
    `  sprites: ${sprites.map((s, i) => `person-${i + 1} ${s.crop.w}×${s.crop.h} (conf ${s.confidence.toFixed(2)})`).join(' · ')}`,
  );

  const list = scenarios(sprites);
  for (const scenario of list) {
    build(scenario);
    console.log(`  built ${scenario.id.padEnd(13)} ${DURATION}s · ${scenario.title}`);
  }

  const truth = {
    /*
     * ⚠️ **No `generatedAt`, and its removal is the point.** This file is a tracked ground truth
     * derived deterministically from the deployed model, so regenerating it should change nothing —
     * and for the whole of P-8 it changed on every run, because it stamped the clock. Two costs: the
     * working tree drifted after every unattended run (which blocks the next one — mutation stages
     * refuse a dirty tree), and `git diff` could never answer the one question tracking it exists to
     * answer, *did the fixtures actually move?* A field that always changes reports nothing.
     * When it changed is what the git history is for.
     */
    source: 'infra/docker/fixtures/media/scene-people.jpg (CC0)',
    frame: { width: W, height: H, fps: FPS, durationSeconds: DURATION },
    warning:
      'Composited sprites on a plain background. Real person pixels on authored trajectories — NOT ' +
      'real CCTV footage. L-1 stands: no camera has ever been connected. These prove tracking logic ' +
      'against known input, never tracker performance on real video.',
    scenarios: list.map((s) => ({ id: s.id, title: s.title, expect: s.expect })),
  };
  writeFileSync(join(OUT_DIR, 'ground-truth.json'), `${JSON.stringify(truth, null, 2)}\n`);
  console.log(`\n  ground truth → ${join('infra/docker/fixtures/media/tracking', 'ground-truth.json')}`);

  if (process.argv.includes('--verify')) {
    console.log('\nVerifying the fixtures against the deployed model\n');
    const failures = verify(list);
    console.log('');
    if (failures > 0) {
      console.log(`${failures} fixture check(s) failed — do not run the tracking suite against these clips.\n`);
      process.exit(1);
    }
    console.log('every fixture is detectable and the background is empty\n');
  }
}

main();
