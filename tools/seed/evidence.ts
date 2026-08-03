/**
 * Demo evidence bootstrap (P-5.7).
 *
 * `pnpm seed` writes a tenant, users, a camera, a rule, an event and an incident straight into
 * MongoDB, so the console has something to show before any service is running. It deliberately
 * seeds **no evidence** — and without evidence the Investigation Workspace, the player, the
 * timeline, bookmarks, the evidence chain and the export entry point all render their empty states.
 * Every one of them is built, and a customer demonstration reaches none of them.
 *
 * This closes that gap. It is a separate step from `pnpm seed` on purpose:
 *
 * ### ⚠️ It goes through the real API, not straight into the database
 *
 * Registering evidence opens a **chain of custody**, verifies the object exists in storage, and
 * records an integrity hash computed from the stored bytes. A row hand-written into Mongo would
 * skip all three, and the Evidence Chain panel would then display a custody log the platform never
 * actually produced — a demo of a tamper-evidence feature that had been bypassed. So this needs the
 * services up, and says so if they are not.
 *
 * ### ⚠️ The media is generated, and the script says so
 *
 * The clips are ffmpeg test patterns, not CCTV. They are genuine H.264 and H.265 in real MP4
 * containers, which is what exercises the player; they are not a claim about what any camera
 * produces. See `docs/review/p56/NVR_VALIDATION.md`.
 *
 *   pnpm dev:stack     # Mongo + MinIO
 *   pnpm seed          # tenant, users, camera, rule, incident
 *   pnpm dev:services  # services must be running for this step
 *   pnpm seed:evidence
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3ObjectStore } from '@vip/storage';
import { loadDotEnv } from '@vip/config';

loadDotEnv(resolve(dirname(fileURLToPath(import.meta.url)), '../../.env'));

const TENANT = process.env.SEED_TENANT_ID ?? 'tnt_dev';
const CAMERA = process.env.SEED_CAMERA_ID ?? 'cam_dev_1';
const INCIDENT = process.env.SEED_INCIDENT_ID ?? '00000000-0000-4000-8000-0000000000c1';
const IDENTITY = process.env.SEED_IDENTITY_URL ?? 'http://localhost:8089';
const EVIDENCE = process.env.SEED_EVIDENCE_URL ?? 'http://localhost:8090';
const EMAIL = process.env.SEED_EMAIL ?? 'owner@vip.dev';
const PASSWORD = process.env.SEED_PASSWORD ?? '123456';

/** ffmpeg runs in a container so no local install is required — the dev stack already uses it. */
const FFMPEG_IMAGE = 'jrottenberg/ffmpeg:6-alpine';

interface Clip {
  file: string;
  args: string[];
  label: string;
  codec: 'h264' | 'h265';
  durationSeconds: number;
  /** Minutes before the incident this clip covers. */
  minutesBefore: number;
}

/**
 * ⚠️ Three clips, chosen to exercise three different behaviours rather than to look impressive:
 * an ordinary H.264 clip that plays everywhere, an hour-long one so the timeline has a real span to
 * zoom into, and an H.265 one — which a Chromium build with no HEVC decoder correctly refuses, so
 * the "this browser cannot decode this file" state is demonstrable rather than theoretical.
 */
const CLIPS: Clip[] = [
  {
    file: 'clip-001.mp4',
    label: 'Loading bay — east door',
    codec: 'h264',
    durationSeconds: 10,
    minutesBefore: 0,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=25',
      '-t',
      '10',
      '-c:v',
      'libx264',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
    ],
  },
  {
    file: 'clip-002-hour.mp4',
    label: 'Loading bay — full hour before the incident',
    codec: 'h264',
    durationSeconds: 3600,
    minutesBefore: 60,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=1',
      '-t',
      '3600',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
    ],
  },
  {
    file: 'clip-003-h265.mp4',
    label: 'East gate — H.265 camera',
    codec: 'h265',
    durationSeconds: 10,
    minutesBefore: -6,
    args: [
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=25',
      '-t',
      '10',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-tag:v',
      'hvc1',
      '-movflags',
      '+faststart',
    ],
  },
];

async function main(): Promise<void> {
  const token = await login();
  const store = buildStore();
  const work = mkdtempSync(join(tmpdir(), 'vip-seed-'));
  const capturedBase = Date.now();

  try {
    for (const clip of CLIPS) {
      process.stdout.write(`  • generating ${clip.file} … `);
      generate(work, clip);

      const key = `${CAMERA}/${clip.file}`;
      const bytes = readFileSync(join(work, clip.file));
      await store.put({
        key: `${TENANT}/${key}`,
        body: bytes,
        contentType: 'video/mp4',
      });
      process.stdout.write('uploaded … ');

      const startedAt = new Date(
        capturedBase - clip.minutesBefore * 60_000 - clip.durationSeconds * 1000,
      );
      const endedAt = new Date(startedAt.getTime() + clip.durationSeconds * 1000);
      const registered = await register(token, {
        kind: 'clip',
        storageKey: key,
        contentType: 'video/mp4',
        codec: clip.codec,
        capturedAt: startedAt.toISOString(),
        source: { incidentId: INCIDENT, cameraId: CAMERA },
        interval: {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationSeconds: clip.durationSeconds,
        },
        metadata: { label: clip.label },
      });
      console.log(`registered ${registered}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log('\n✔ Evidence seeded. In the console:');
  console.log('    Incidents → open the incident → Open investigation');
  console.log(
    '    …then play, scrub the timeline, bookmark a moment, read the metadata and chain.',
  );
  console.log(
    '\n  ⚠️ The clips are ffmpeg test patterns — real H.264/H.265 in real MP4 containers,',
  );
  console.log('     but not CCTV. See docs/review/p56/NVR_VALIDATION.md.');
}

function buildStore(): S3ObjectStore {
  return new S3ObjectStore({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:49000',
    accessKeyId: process.env.MINIO_ROOT_USER ?? 'vip_dev',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'change_me_dev_only',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_RECORDINGS_BUCKET ?? 'vip-recordings',
    forcePathStyle: true,
  });
}

function generate(dir: string, clip: Clip): void {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${dir}:/w`,
      '-w',
      '/w',
      FFMPEG_IMAGE,
      '-hide_banner',
      '-loglevel',
      'error',
      ...clip.args,
      clip.file,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

async function login(): Promise<string> {
  const response = await fetch(`${IDENTITY}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tenant-id': TENANT },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).catch(() => undefined);
  if (response === undefined) {
    throw new Error(
      `the identity service is not reachable at ${IDENTITY} — run \`pnpm dev:services\``,
    );
  }
  const body = (await response.json()) as { data?: { accessToken?: string } };
  const token = body.data?.accessToken;
  if (token === undefined)
    throw new Error(`login failed for ${EMAIL} — has \`pnpm seed\` been run?`);
  return token;
}

async function register(token: string, input: unknown): Promise<string> {
  const response = await fetch(`${EVIDENCE}/evidence`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-tenant-id': TENANT,
    },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as {
    success?: boolean;
    data?: { id?: string };
    error?: { message?: string };
  };
  if (body.success !== true || body.data?.id === undefined) {
    throw new Error(
      `register failed (HTTP ${response.status}): ${body.error?.message ?? 'unknown'}`,
    );
  }
  return body.data.id;
}

main().catch((error: unknown) => {
  console.error('\n✖ Evidence seed failed:', error instanceof Error ? error.message : error);
  console.error(
    '  Needs: `pnpm dev:stack`, `pnpm seed`, `pnpm dev:services`, and Docker for ffmpeg.',
  );
  process.exit(1);
});
