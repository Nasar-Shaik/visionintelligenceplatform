/**
 * Build the Y4M corpus Chrome's fake video device plays back (P-9).
 *
 * ### ⚠️ ffmpeg runs in a container, because this machine has none
 *
 * The host has no ffmpeg; the media service's image does, and it is the *same* ffmpeg the platform
 * decodes with. Running it through `docker run --rm` against `vip/media:local` therefore costs
 * nothing and removes a "works on the machine that happens to have Homebrew" dependency from a
 * validation that has to be reproducible by someone else.
 *
 * ### ⛔ Y4M is raw, and that is the whole reason it is used
 *
 * `--use-file-for-fake-video-capture` accepts Y4M (uncompressed I420) or MJPEG. Y4M is chosen so the
 * frames reaching `getUserMedia` carry **no second generation of compression**: the clip is decoded
 * once, and what the page captures is what the fixture author put there. Feeding MJPEG would mean
 * the detector saw JPEG artefacts from a re-encode this validation introduced, and every accuracy
 * number would silently include them.
 *
 * The cost is size — 640×360 I420 is 345 600 bytes per frame, so a 20-second clip at 10 fps is
 * ~69 MB. They are written to a scratch directory and never committed; `--fps` and `--seconds` bound
 * the corpus. ⚠️ Chrome loops the file, so a clip shorter than the run is not a truncated run.
 *
 *   node make-y4m.mjs --out <dir> [--fps 10] [--seconds 20]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DERIVED, SCENARIOS } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const FIXTURES = join(REPO, 'infra/docker/fixtures/media');
const IMAGE = process.env.VIP_FFMPEG_IMAGE ?? 'vip/media:local';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = resolve(flag('out', '/tmp/vip-livecam-y4m'));
const FPS = Number(flag('fps', 10));
const SECONDS = Number(flag('seconds', 20));

mkdirSync(OUT, { recursive: true });
const DERIVED_MP4 = join(OUT, 'derived');
mkdirSync(DERIVED_MP4, { recursive: true });

/**
 * Run ffmpeg inside the media image.
 *
 * ⚠️ `-y` overwrites, `-nostdin` stops it swallowing this script's stdin, and stderr is captured
 * rather than inherited — a failure must surface as a thrown error with ffmpeg's own words, not as a
 * wall of progress output with the reason buried in it.
 */
function ffmpeg(mounts, argv) {
  const mountArgs = mounts.flatMap(([host, container]) => ['-v', `${host}:${container}`]);
  try {
    execFileSync(
      'docker',
      ['run', '--rm', ...mountArgs, '--entrypoint', 'ffmpeg', IMAGE, '-nostdin', '-y', ...argv],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    const stderr = err.stderr?.toString() ?? '';
    throw new Error(`ffmpeg failed: ${argv.join(' ')}\n${stderr.split('\n').slice(-12).join('\n')}`);
  }
}

/* ── 1. derive the clips the fixture library does not ship ─────────────────────────────────────── */

console.log(`deriving ${String(DERIVED.length)} clips…`);
for (const d of DERIVED) {
  const target = join(DERIVED_MP4, `${d.id}.mp4`);
  if (existsSync(target)) {
    console.log(`  ${d.id} — already built`);
    continue;
  }
  ffmpeg(
    [
      [join(FIXTURES, 'validation'), '/in'],
      [DERIVED_MP4, '/out'],
    ],
    ['-i', `/in/${d.from}`, '-vf', d.filter, '-c:v', 'libx264', '-preset', 'veryfast', '-an', `/out/${d.id}.mp4`],
  );
  console.log(`  ${d.id} — ${d.note}`);
}

/* ── 2. every clip the matrix needs, as Y4M ────────────────────────────────────────────────────── */

/** Where a scenario's source lives: the tracking set, the derived set, or validation. */
function sourceOf(scenario) {
  const derived = DERIVED.some((d) => `${d.id}.mp4` === scenario.clip);
  if (derived) return { dir: DERIVED_MP4, name: scenario.clip };
  if (scenario.from === 'tracking') return { dir: join(FIXTURES, 'tracking'), name: scenario.clip };
  return { dir: join(FIXTURES, 'validation'), name: scenario.clip };
}

const built = new Map();
for (const scenario of SCENARIOS) {
  if (scenario.clip === null) continue;
  const target = join(OUT, `${scenario.id}.y4m`);
  if (existsSync(target)) {
    built.set(scenario.id, statSync(target).size);
    console.log(`  ${scenario.id}.y4m — already built (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
    continue;
  }
  const src = sourceOf(scenario);
  if (!existsSync(join(src.dir, src.name))) {
    console.log(`  ⛔ ${scenario.id} — source missing: ${join(src.dir, src.name)}`);
    continue;
  }
  /*
   * ⚠️ `-pix_fmt yuv420p` is not optional: Chrome's fake device reads I420 only, and a Y4M in any
   * other pixel format is accepted by ffmpeg and then produces a black stream in the browser — which
   * looks exactly like an empty scene, and would be recorded as one.
   *
   * ⚠️ Orientation is preserved, deliberately. Forcing every clip to 640×360 would make the portrait
   * scenario a lie: it would test a letterboxed landscape frame and report it as portrait.
   */
  ffmpeg(
    [
      [src.dir, '/in'],
      [OUT, '/out'],
    ],
    [
      '-i', `/in/${src.name}`,
      '-t', String(SECONDS),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-an',
      `/out/${scenario.id}.y4m`,
    ],
  );
  const size = statSync(target).size;
  built.set(scenario.id, size);
  console.log(`  ${scenario.id}.y4m — ${(size / 1e6).toFixed(1)} MB`);
}

const total = [...built.values()].reduce((a, b) => a + b, 0);
console.log(
  `\n${String(built.size)} Y4M files in ${OUT}, ${(total / 1e9).toFixed(2)} GB total ` +
    `(${String(FPS)} fps × ${String(SECONDS)} s each).`,
);
const manual = SCENARIOS.filter((s) => s.manual);
if (manual.length > 0) {
  console.log(
    `⚠️ ${String(manual.length)} scenario(s) have no file and are NOT executed by the matrix: ` +
      manual.map((m) => m.id).join(', '),
  );
}
