/**
 * Build the permanent validation dataset (P-8.5 Product Validation).
 *
 *   node tools/dataset/generate.mjs             # build every clip
 *   node tools/dataset/generate.mjs --verify    # build, then MEASURE each against the deployed model
 *   node tools/dataset/generate.mjs --only=crowd,night-footage
 *
 * ### ⭐ Why the manifest is written from measurements and not from the catalogue
 *
 * `scenarios.mjs` records what the author *intended* each clip to contain. This script asks the
 * **deployed runtime** what it actually finds and writes that into `manifest.json`. Tests read the
 * manifest.
 *
 * The alternative — asserting against the intent — produces a suite that fails whenever the model
 * is upgraded, in a way indistinguishable from a real regression. Worse, it lets a fixture the
 * detector cannot see sit in the repo looking authoritative: the `crowd` clip is *authored* with
 * eight people, and if the model reliably finds six because NMS suppresses the overlapping pair,
 * then six is the truth about this platform and eight is a wish. The gap is recorded as a finding.
 *
 * ⚠️ Every disagreement between intent and measurement is printed. For clips marked `uncertain` it
 * is information; for the others it is a **fixture defect** and the exit code says so.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { authored, variants, corrupt, procurement, W, H, FPS, BACKGROUND, DURATION, even } from './scenarios.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MEDIA = 'vip-prod-media-1';
const SCENE = join(ROOT, 'infra/docker/fixtures/media/scene-people.jpg');
const OUT_DIR = join(ROOT, 'infra/docker/fixtures/media/validation');
const FFMPEG_IMAGE = 'bluenviron/mediamtx:latest-ffmpeg';
const TENANT = process.env.TENANT ?? 'tnt_demo_retail';

const VERIFY = process.argv.includes('--verify');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').replace('--only=', '');
const wanted = ONLY === '' ? null : new Set(ONLY.split(','));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

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

function ffprobe(relPath) {
  const raw = sh('docker', [
    'run', '--rm', '-v', `${OUT_DIR}:/out:ro`,
    '--entrypoint', 'ffprobe',
    FFMPEG_IMAGE,
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', `/out/${relPath}`,
  ]);
  return JSON.parse(raw);
}

/**
 * Ask the DEPLOYED runtime where the people are.
 *
 * ⚠️ Through the media container with `$INTERNAL_API_KEY` expanded **inside** the container that
 * already holds it (ADR-0018). The key is never read into this process.
 */
function detect(absJpegPath) {
  const body = {
    capabilityId: 'perception.person-detection',
    context: { tenantId: TENANT },
    frame: { cameraId: 'dataset-probe', seq: 1, capturedAt: new Date().toISOString(), source: 'probe' },
    imageBase64: readFileSync(absJpegPath).toString('base64'),
  };
  const staged = join(tmpdir(), `vip-dataset-${process.pid}.json`);
  writeFileSync(staged, JSON.stringify(body));
  try {
    sh('docker', ['cp', staged, `${MEDIA}:/tmp/vip-dataset.json`]);
    const raw = sh('docker', [
      'exec', MEDIA, 'sh', '-c',
      'curl -s -X POST http://inference:8085/infer -H "content-type: application/json" ' +
        '-H "x-internal-key: $INTERNAL_API_KEY" --data-binary @/tmp/vip-dataset.json',
    ]);
    return JSON.parse(raw).data?.detections ?? [];
  } finally {
    try { unlinkSync(staged); } catch { /* best effort */ }
  }
}

/**
 * Crop the two people out of the reference photograph at the boxes **the model returns**.
 *
 * ⚠️ Cropping by eye would risk building a library the detector cannot see, and every downstream
 * failure would then be blamed on tracking or rules rather than on the fixture.
 */
function extractSprites() {
  mkdirSync(OUT_DIR, { recursive: true });
  const people = detect(SCENE).filter((d) => d.label === 'person').sort((x, y) => x.bbox[0] - y.bbox[0]);
  if (people.length < 2) {
    throw new Error(
      `the reference photograph produced ${people.length} person detection(s); two are needed. ` +
        'The scene or the model changed — fix that before regenerating the library.',
    );
  }
  return people.slice(0, 2).map((person, index) => {
    const [x, y, w, h] = person.bbox;
    const crop = {
      x: Math.max(0, Math.floor(x * W)),
      y: Math.max(0, Math.floor(y * H)),
      w: even(Math.min(W, w * W)),
      h: even(Math.min(H, h * H)),
    };
    const name = `person-${index + 1}.png`;
    ffmpeg(
      ['-i', '/f/scene-people.jpg', '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, `/out/${name}`],
      [`${join(ROOT, 'infra/docker/fixtures/media')}:/f:ro`, `${OUT_DIR}:/out`],
    );
    return { path: join(OUT_DIR, name), name, crop, confidence: person.confidence };
  });
}

function buildScenario(s) {
  const fps = s.fps ?? FPS;
  const duration = s.duration ?? DURATION;
  /*
   * ⚠️ `-loop 1` on every sprite, and NOT `shortest`. A PNG is a single frame, so an overlay told to
   * stop with the shortest input stops after one frame — which once produced a 1.6 kB clip
   * containing no motion at all while looking entirely plausible in a directory listing.
   */
  const inputs = s.inputs.flatMap((p) => ['-loop', '1', '-i', `/out/${p.split('/').pop()}`]);
  const args = [
    '-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${W}x${H}:r=${fps}:d=${duration}`,
    ...inputs,
  ];
  if (s.filter) args.push('-filter_complex', s.filter);
  args.push(
    '-t', String(duration),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    /* ⚠️ A keyframe every 2 s. The snapshot extractor seeks accurately and pays at most one GOP;
     * a 10 s GOP would make every evidence still cost five seconds of decode. */
    '-g', String(Math.max(1, fps * 2)),
    '-movflags', '+faststart',
    `/out/${s.id}.mp4`,
  );
  ffmpeg(args, [`${OUT_DIR}:/out`]);
  return `${s.id}.mp4`;
}

function buildVariant(v) {
  const base = `/out/single-person-walking.mp4`;
  const args = ['-i', base];
  const vf = [];
  if (v.scale) vf.push(`scale=${v.scale}`);
  if (v.vf) vf.push(v.vf);
  if (vf.length > 0) args.push('-vf', vf.join(','));
  const codec = v.codec ?? ['libx264'];
  args.push('-c:v', ...codec);
  if (codec[0] === 'libx265') {
    args.push('-x265-params', 'log-level=none');
    /* ⚠️ `hvc1` vs `hev1` is a MUXER tag, not a different bitstream — the same encode, labelled
     * two ways, and WebKit accepts only one of them (TD-29). */
    args.push('-tag:v', v.tag ?? 'hvc1');
  } else if (v.tag && v.tag !== 'avc1') {
    args.push('-tag:v', v.tag);
  }
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', `/out/${v.id}.mp4`);
  ffmpeg(args, [`${OUT_DIR}:/out`]);
  return `${v.id}.mp4`;
}

/**
 * Damage a good clip in one specific way.
 *
 * ⚠️ Built from `single-person-walking.mp4` so that "this file is broken" is the ONLY difference
 * from a file the platform is already known to handle.
 */
function buildCorrupt(c) {
  const src = join(OUT_DIR, 'single-person-walking.mp4');
  const out = join(OUT_DIR, `${c.id}.mp4`);
  const good = readFileSync(src);
  switch (c.id) {
    case 'corrupt-zero-bytes':
      writeFileSync(out, Buffer.alloc(0));
      break;
    case 'corrupt-truncated-header':
      writeFileSync(out, good.subarray(0, 200));
      break;
    case 'corrupt-truncated-tail':
      writeFileSync(out, good.subarray(0, Math.floor(good.length * 0.6)));
      break;
    case 'corrupt-not-a-video':
      writeFileSync(out, Buffer.from('This is not a video. A customer will upload this file.\n'.repeat(200), 'utf8'));
      break;
    case 'corrupt-audio-only':
      ffmpeg(
        ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:a', 'aac', '-movflags', '+faststart', `/out/${c.id}.mp4`],
        [`${OUT_DIR}:/out`],
      );
      break;
    case 'corrupt-bitflips': {
      const damaged = Buffer.from(good);
      /* ⚠️ Deterministic. A random seed would make a failure impossible to reproduce, and a
       * corruption test that cannot be reproduced is an anecdote. */
      let seed = 0x5eed;
      const start = Math.floor(damaged.length * 0.35);
      for (let n = 0; n < 64; n += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const at = start + (seed % Math.floor(damaged.length * 0.4));
        damaged[at] = (damaged[at] ?? 0) ^ 0xff;
      }
      writeFileSync(out, damaged);
      break;
    }
    default:
      throw new Error(`no build rule for ${c.id}`);
  }
  return `${c.id}.mp4`;
}

/** Pull one frame and ask the model what is in it. */
function probe(file, atSeconds) {
  const frameDir = join(OUT_DIR, 'frames');
  mkdirSync(frameDir, { recursive: true });
  const name = `${file.replace('.mp4', '')}.jpg`;
  ffmpeg(
    [
      '-ss', String(atSeconds), '-i', `/out/${file}`,
      '-frames:v', '1',
      /* ⚠️ mjpeg refuses limited-range YUV outright rather than converting. */
      '-pix_fmt', 'yuvj420p',
      `/out/frames/${name}`,
    ],
    [`${OUT_DIR}:/out`],
  );
  const abs = join(frameDir, name);
  if (!existsSync(abs)) return null;
  return detect(abs).filter((d) => d.label === 'person');
}

/* ───────────────────────────────  run  ─────────────────────────────── */

console.log('\nVIP validation dataset\n');
mkdirSync(OUT_DIR, { recursive: true });

console.log('sprites (cropped at the boxes the deployed model returns)');
const sprites = extractSprites();
for (const s of sprites) {
  check(true, s.name, `${s.crop.w}×${s.crop.h} @ confidence ${s.confidence.toFixed(2)}`);
}

const scenarioList = authored(sprites).filter((s) => !wanted || wanted.has(s.id));
const manifest = { generatedAt: new Date().toISOString(), tenant: TENANT, clips: [], procurement };

console.log('\nscenarios');
for (const s of scenarioList) {
  const file = buildScenario(s);
  const meta = ffprobe(file);
  const v = meta.streams.find((x) => x.codec_type === 'video');
  const entry = {
    id: s.id,
    file: `validation/${file}`,
    title: s.title,
    category: s.category,
    kind: 'authored',
    durationSeconds: Number(meta.format.duration),
    bytes: Number(meta.format.size),
    width: v.width,
    height: v.height,
    fps: eval(v.r_frame_rate), // eslint-disable-line no-eval -- ffprobe returns "15/1"
    codec: v.codec_name,
    intent: s.expect,
    note: s.expect.note,
  };
  if (VERIFY) {
    const found = probe(file, s.probeAt);
    entry.measured = {
      probeAtSeconds: s.probeAt,
      people: found === null ? null : found.length,
      confidences: found === null ? [] : found.map((d) => Number(d.confidence.toFixed(3))),
    };
    const want = s.expect.people;
    const got = entry.measured.people;
    const agrees = got === want;
    if (agrees) {
      check(true, s.id.padEnd(24), `${got} person(s) at t=${s.probeAt}s`);
    } else if (s.expect.uncertain) {
      console.log(`  ⓘ ${s.id.padEnd(24)} — authored ${want}, model found ${got}. Recorded as measured truth.`);
      entry.measured.divergedFromIntent = true;
    } else {
      check(false, s.id.padEnd(24), `authored ${want}, model found ${got} — FIXTURE DEFECT`);
      entry.measured.divergedFromIntent = true;
    }
  } else {
    check(true, s.id.padEnd(24), `${entry.width}×${entry.height} ${entry.fps}fps ${entry.durationSeconds.toFixed(1)}s`);
  }
  manifest.clips.push(entry);
}

if (!wanted) {
  console.log('\ntransport variants (one axis at a time)');
  for (const v of variants) {
    const file = buildVariant(v);
    const meta = ffprobe(file);
    const st = meta.streams.find((x) => x.codec_type === 'video');
    const entry = {
      id: v.id,
      file: `validation/${file}`,
      title: v.title,
      category: 'transport',
      axis: v.axis,
      kind: 'authored',
      durationSeconds: Number(meta.format.duration),
      bytes: Number(meta.format.size),
      width: st.width,
      height: st.height,
      fps: eval(st.r_frame_rate), // eslint-disable-line no-eval
      codec: st.codec_name,
      codecTag: st.codec_tag_string,
      intent: { people: v.expectPeople },
    };
    if (VERIFY) {
      const found = probe(file, 15);
      entry.measured = {
        probeAtSeconds: 15,
        people: found === null ? null : found.length,
        confidences: found === null ? [] : found.map((d) => Number(d.confidence.toFixed(3))),
      };
      const agrees = entry.measured.people === v.expectPeople;
      if (agrees) check(true, v.id.padEnd(24), `${entry.width}×${entry.height} ${entry.codec}/${entry.codecTag} → ${entry.measured.people}`);
      else if (v.uncertain) console.log(`  ⓘ ${v.id.padEnd(24)} — authored ${v.expectPeople}, model found ${entry.measured.people} (${entry.codec}/${entry.codecTag})`);
      else check(false, v.id.padEnd(24), `authored ${v.expectPeople}, model found ${entry.measured.people}`);
    } else {
      check(true, v.id.padEnd(24), `${entry.width}×${entry.height} ${entry.codec}/${entry.codecTag}`);
    }
    manifest.clips.push(entry);
  }

  console.log('\ncorrupted inputs (an expected refusal, not an expected detection)');
  for (const c of corrupt) {
    const file = buildCorrupt(c);
    const bytes = statSync(join(OUT_DIR, file)).size;
    let probes = 'unreadable';
    try {
      const meta = ffprobe(file);
      const st = meta.streams?.find((x) => x.codec_type === 'video');
      probes = st ? `probes OK: ${st.codec_name} ${st.width}×${st.height} ${Number(meta.format.duration).toFixed(1)}s` : 'probes OK but NO VIDEO STREAM';
    } catch {
      probes = 'ffprobe refuses it';
    }
    manifest.clips.push({
      id: c.id,
      file: `validation/${file}`,
      title: c.title,
      category: 'corrupt',
      kind: 'damaged',
      bytes,
      expect: c.expect,
      stage: c.stage,
      ffprobe: probes,
    });
    check(true, c.id.padEnd(24), `${bytes} B — ${probes}`);
  }
}

/**
 * ⭐ The background must produce ZERO detections.
 *
 * Without this, a "person" asserted anywhere else in the library might be the wallpaper, and every
 * count in the manifest would be built on an unexamined assumption.
 */
if (VERIFY) {
  console.log('\nthe negative control');
  ffmpeg(
    ['-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${W}x${H}`, '-frames:v', '1', '-pix_fmt', 'yuvj420p', '/out/frames/background.jpg'],
    [`${OUT_DIR}:/out`],
  );
  const bg = detect(join(OUT_DIR, 'frames/background.jpg')).filter((d) => d.label === 'person');
  check(bg.length === 0, 'the empty background produces zero person detections', bg.length === 0 ? '' : `found ${bg.length} — the library is unusable`);
  manifest.negativeControl = { people: bg.length };
}

writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nmanifest → infra/docker/fixtures/media/validation/manifest.json (${manifest.clips.length} clips)`);
console.log(`procurement required → ${procurement.length} real-venue recordings, see docs/project/TEST_DATASET.md\n`);

if (failures > 0) {
  console.log(`⛔ ${failures} problem(s). The library is NOT trustworthy until these are resolved.\n`);
  process.exit(1);
}
console.log('✓ dataset built\n');
