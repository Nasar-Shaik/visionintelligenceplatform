/**
 * The **duration and size ladder** (P-8.5 Product Validation).
 *
 *   node tools/dataset/large.mjs                 # 1, 5, 10, 30, 60 minutes
 *   node tools/dataset/large.mjs --minutes=1,10
 *
 * ### ⚠️ Duration and size are two different axes and are built separately
 *
 * They are routinely conflated, and conflating them makes a failure uninterpretable. **Duration**
 * decides how long the *analysis* takes — frames × model time — and is what a customer waits for.
 * **Size** decides how long the *upload* takes and whether the storage path holds up; it is a
 * property of bitrate, not of length. A one-hour 640×360 clip is about 30 MB and a two-minute 4K one
 * is larger, so a single "big file" test answers neither question.
 *
 * ### ⚠️ Built by looping a measured clip with `-c copy`
 *
 * `long-recording.mp4` is already in the manifest with known content, so a ten-minute file made from
 * it contains exactly what a customer would see repeated — and stream-copying is near-instant, which
 * matters because re-encoding an hour of video to build a test fixture costs more than the test.
 *
 * ⛔ These files are **not committed** (.gitignore) and are not part of the standard suite. A
 * performance run generates them, measures, and they are deleted.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_DIR = join(ROOT, 'infra/docker/fixtures/media/validation');
const OUT_DIR = join(BASE_DIR, 'large');
const FFMPEG_IMAGE = 'bluenviron/mediamtx:latest-ffmpeg';
/** The source is 300 s and already measured in the manifest. */
const SOURCE = 'long-recording.mp4';
const SOURCE_SECONDS = 300;

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=')[1];
const MINUTES = arg('minutes', '1,5,10,30,60').split(',').map(Number);

const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function ffmpeg(args) {
  return sh('docker', [
    'run', '--rm',
    '-v', `${BASE_DIR}:/base`,
    '-v', `${OUT_DIR}:/out`,
    '--entrypoint', 'ffmpeg',
    FFMPEG_IMAGE,
    '-hide_banner', '-loglevel', 'error', '-y', ...args,
  ]);
}

if (!existsSync(join(BASE_DIR, SOURCE))) {
  console.error(`\n⛔ ${SOURCE} is missing — run \`node tools/dataset/generate.mjs --verify\` first.\n`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

console.log('\nVIP duration ladder\n');
const built = [];
for (const minutes of MINUTES) {
  const seconds = minutes * 60;
  const id = `duration-${minutes}min`;
  const file = `${id}.mp4`;
  /*
   * ⚠️ `-stream_loop` then `-t`, with `-c copy`. Looping without a hard `-t` produces a file whose
   * length is a multiple of 300 s rather than the length asked for — a "30 minute" fixture that is
   * actually 35, which quietly corrupts every throughput figure derived from it.
   */
  const loops = Math.max(0, Math.ceil(seconds / SOURCE_SECONDS) - 1);
  ffmpeg([
    '-stream_loop', String(loops),
    '-i', `/base/${SOURCE}`,
    '-t', String(seconds),
    '-c', 'copy',
    '-movflags', '+faststart',
    `/out/${file}`,
  ]);
  const bytes = statSync(join(OUT_DIR, file)).size;
  built.push({ id, file: `validation/large/${file}`, minutes, seconds, bytes });
  console.log(
    `  ✓ ${id.padEnd(20)} ${(bytes / 1024 / 1024).toFixed(1)} MB — ` +
      `${(seconds * 2).toLocaleString()} frames at the 2 fps analysis rate`,
  );
}

/*
 * ⛔ **2 GB and 5 GB are NOT generated here, and the reason is recorded rather than worked around.**
 *
 * The product declares a 2 GB ceiling, and the ceiling is checked against the *declared* size before
 * a single byte is uploaded — so the boundary itself is testable in milliseconds by declaring
 * 2 GB + 1 and asserting the refusal, which `tools/e2e-browser/test/performance.spec.ts` does.
 *
 * What that does NOT test is a real multi-gigabyte transfer: multipart behaviour, the proxy's body
 * limits, and whether a fifteen-minute upload survives a token expiry. Those need the real bytes, and
 * at this deployment's measured ~6 MB/s loopback throughput a 2 GB upload is roughly six minutes of
 * wall clock and 2 GB of disk per run. That is a deliberate, stated gap in
 * `docs/project/KNOWN_LIMITATIONS.md` — not a claim quietly made on a 30 MB file's behalf.
 */
console.log(`\n⚠️ 2 GB / 5 GB not generated — see KNOWN_LIMITATIONS.md [L-66].`);
console.log(`ladder → ${OUT_DIR}\n`);
console.log(JSON.stringify(built, null, 2));
