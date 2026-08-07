/**
 * Evidence snapshots (P-8 Phase 8, slice 6 — TD-15 for offline analysis).
 *
 * ⚠️ The extractor spawns ffmpeg, which is a system dependency present in the container and not on
 * every machine, so it is exercised by the deployed verification exactly as the decoders are. What is
 * tested here is everything that decides *what a customer gets*: the command line, the refusals, and
 * the arithmetic that says which moment the still is a picture of.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { buildSnapshotArgs, jpegSize } from '../src/adapters/ffmpeg-snapshot.js';
import { AnalysisService } from '../src/application/analysis-service.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import { newSession, type AnalysisDoc } from '../src/domain/analysis.js';

const FOOTAGE_START = '2026-02-14T18:30:00.000Z';
const T0 = new Date('2026-03-01T09:00:00.000Z');
const scope = TenantScope.fromTenantId('tnt_a');

describe('buildSnapshotArgs', () => {
  const req = { url: 'https://store/obj', offsetSeconds: 12.5 };

  /**
   * ⭐ **`-ss` AFTER `-i`, the opposite of the chunked decoder — and the difference is what the
   * customer sees.**
   *
   * Before the input it is a fast index seek that lands on the preceding key-frame, which is right
   * for a decoder about to consume two minutes and wrong for a still: the evidence would show a
   * moment up to a GOP *before* the thing that caused the incident.
   */
  it('seeks accurately, on the output side', () => {
    const args = buildSnapshotArgs(req);
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('12.500000');
  });

  it('produces exactly one frame', () => {
    const args = buildSnapshotArgs(req);
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  /** ⚠️ `min(w,iw)` never upscales, and `-2` keeps the aspect ratio — a stretched still is evidence of nothing. */
  it('bounds the width without upscaling or distorting', () => {
    expect(buildSnapshotArgs({ ...req, maxWidth: 640 })).toContain("scale='min(640,iw)':-2");
  });

  /** ⚠️ One argument, so a signed URL full of `&` and `=` survives intact. */
  it('passes the url as a single argument', () => {
    const url = 'https://s3/k?X-Amz-Signature=a&X-Amz-Expires=60';
    expect(buildSnapshotArgs({ ...req, url })).toContain(url);
  });
});

describe('jpegSize', () => {
  /** A minimal JPEG: SOI, an APP0 segment, then SOF0 declaring 480×640. */
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02,
    0x80,
  ]);

  /**
   * ⚠️ Measured from the bytes, not assumed from the request — `scale` does not apply when the
   * source is already narrower. Evidence that misreports its own size is evidence somebody later
   * crops wrongly.
   */
  it('reads the dimensions out of the SOF marker', () => {
    expect(jpegSize(jpeg)).toEqual({ width: 640, height: 480 });
  });

  it('returns null rather than guessing when there is no SOF', () => {
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe('AnalysisService.snapshot', () => {
  async function build(opts: { wired?: boolean; captured?: Uint8Array } = {}) {
    const store = new InMemoryAnalysisStore();
    const analysis: AnalysisDoc = {
      _id: 'ana_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      sourceKind: 'upload',
      state: 'ready',
      asset: {
        key: 'analyses/ana_1/source.mp4',
        originalName: 'f.mp4',
        bytes: 10,
        contentType: 'video/mp4',
        container: 'mp4',
        codec: 'h264',
        width: 640,
        height: 480,
        sourceFrameRate: 25,
        durationSeconds: 30,
      },
      footageStartedAt: FOOTAGE_START,
      footageStartSource: 'operator',
      sessionCount: 1,
      createdBy: 'usr_1',
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    };
    await store.putAnalysis(scope, analysis);
    await store.putSession(scope, {
      ...newSession({
        id: 'ases_1',
        tenantId: 'tnt_a',
        analysisId: 'ana_1',
        cameraId: 'cam_1',
        sequence: 1,
        analysisFrameRate: 2,
        speed: null,
        capabilityId: 'cap',
        ruleSet: [],
        findings: [],
        requestedBy: 'usr_1',
        now: T0,
        durationSeconds: 30,
      }),
      state: 'succeeded',
    });

    const written: { key: string; bytes: number; contentType?: string }[] = [];
    const signed: string[] = [];
    const service = new AnalysisService({
      store,
      objectStore: {
        /* ⚠️ The port's real shape: `put(PutObjectInput)`. `TenantObjectStore` is what turns three
         * arguments into it, and a double that took three would make the tenant prefixing untested. */
        async put(input: { key: string; body: Uint8Array; contentType?: string }) {
          written.push({
            key: input.key,
            bytes: input.body.byteLength,
            ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
          });
        },
        async presignGet(key: string) {
          return `https://public/${key}`;
        },
        async presignInternalGet(key: string) {
          return `https://internal/${key}`;
        },
      } as never,
      probe: {} as never,
      cameras: { async exists() { return true; } },
      clock: { now: () => T0 },
      ids: { analysisId: () => 'a', sessionId: () => 's' },
      capabilityId: 'cap',
      defaultFrameRate: 2,
      playbackTtlSeconds: 900,
      ...(opts.wired === false
        ? {}
        : {
            snapshots: {
              async capture(input: { url: string }) {
                signed.push(input.url);
                return {
                  jpeg: opts.captured ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
                  width: 640,
                  height: 480,
                };
              },
            },
            signSource: async (tenantId: string, key: string) =>
              `https://internal/${tenantId}/${key}`,
          }),
    });
    return { service, written, signed };
  }

  it('stores a still and hands back a signed url for it', async () => {
    const { service, written } = await build();
    const shot = await service.snapshot(scope, 'ana_1', { offsetSeconds: 12.5 });

    expect(written).toHaveLength(1);
    expect(written[0]?.contentType).toBe('image/jpeg');
    expect(shot.bytes).toBe(4);
    expect(shot.width).toBe(640);
    expect(shot.url).toContain('https://public/');
  });

  /**
   * ⭐ **The still is a picture of a moment in the FOOTAGE**, not of the moment it was taken. Putting
   * the wall clock here is how a report ends up claiming last Tuesday's incident happened today.
   */
  it('dates the still by the footage, not by when it was extracted', async () => {
    const { service } = await build();
    const shot = await service.snapshot(scope, 'ana_1', { offsetSeconds: 12.5 });
    expect(shot.occurredAt).toBe('2026-02-14T18:30:12.500Z');
    expect(shot.offsetSeconds).toBe(12.5);
  });

  /** ⚠️ Keyed by the RUN, so two analyses of one recording cannot overwrite each other's stills. */
  it('keys the object by the run', async () => {
    const { service, written } = await build();
    await service.snapshot(scope, 'ana_1', { offsetSeconds: 12.5 });
    /* ⚠️ …and tenant-prefixed, which is what `TenantObjectStore` adds. */
    expect(written[0]?.key.startsWith('tnt_a/')).toBe(true);
    expect(written[0]?.key).toContain('ases_1');
    expect(written[0]?.key).toContain('12500');
  });

  /** ⛔ ffmpeg reads this INSIDE the container — a browser-facing url is `Connection refused`. */
  it('signs the source with the internal endpoint', async () => {
    const { service, signed } = await build();
    await service.snapshot(scope, 'ana_1', { offsetSeconds: 1 });
    expect(signed[0]).toContain('https://internal/');
  });

  /**
   * ⛔ **Refused before ffmpeg is spawned.** ffmpeg exits 0 having produced nothing when the offset
   * is past the end, and a zero-byte object registered as a customer's evidence is the worst
   * available outcome.
   */
  it('refuses an offset past the end of the recording', async () => {
    const { service, written } = await build();
    await expect(service.snapshot(scope, 'ana_1', { offsetSeconds: 45 })).rejects.toThrow(
      /30\.0s long.*no frame at 45\.0s/,
    );
    expect(written).toHaveLength(0);
  });

  /** ⚠️ No decoder ⇒ refused, never a placeholder image. An empty image is not evidence. */
  it('refuses when no decoder is configured', async () => {
    const { service } = await build({ wired: false });
    await expect(service.snapshot(scope, 'ana_1', { offsetSeconds: 1 })).rejects.toThrow(
      /cannot extract stills/,
    );
  });

  /**
   * ⚠️ **`registeredAsEvidence: false` is the honest half of this slice.** The still exists and is
   * signed, but it is not yet under evidence custody — retention, chain-of-custody and export are
   * the remaining half of TD-15. "There is a picture" and "there is a picture that will survive
   * retention" are different promises.
   */
  it('says plainly that the still is not yet under evidence custody', async () => {
    const { service } = await build();
    const shot = await service.snapshot(scope, 'ana_1', { offsetSeconds: 1 });
    expect(shot.registeredAsEvidence).toBe(false);
  });

  it('carries the incident it was captured for', async () => {
    const { service } = await build();
    const shot = await service.snapshot(scope, 'ana_1', {
      offsetSeconds: 1,
      incidentId: 'inc_9',
    });
    expect(shot.incidentId).toBe('inc_9');
  });
});
