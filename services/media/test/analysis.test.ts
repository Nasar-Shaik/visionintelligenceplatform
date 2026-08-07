/**
 * Offline video investigation — the asset lifecycle and the arithmetic underneath it (P-8 Phase 8).
 *
 * ⭐ **`frameFootageTime` is the one function this milestone's correctness rests on.** Every rule
 * stage downstream is keyed on the event's `occurredAt`; get this wrong and a recording analysed at
 * 8× produces different incidents from the same recording analysed at 1×, silently, with no error
 * anywhere. It is tested first and hardest, and deliberately as pure arithmetic — no ffmpeg, no
 * runtime, no store, no clock.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { ANALYSIS_LIMITS } from '@vip/contracts';
import {
  assetFindings,
  frameFootageTime,
  frameOffsetSeconds,
  rejectAsset,
  resolveContainer,
  type AnalysisDoc,
} from '../src/domain/analysis.js';
import {
  parseProbe,
  parseRational,
  type MediaProbe,
  type ProbeResult,
} from '../src/adapters/ffprobe.js';
import { AnalysisService, resolveFootageStart } from '../src/application/analysis-service.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import type { AppError } from '../src/application/errors.js';
import { memoryObjectStore } from './helpers.js';

// ---------------------------------------------------------------------------------------------

describe('footage time — the clock every rule stage reads', () => {
  /*
   * ⚠️ The decoder emits `seq` 1-based, so frame 1 is the START of the footage, not one interval
   * into it. Off by one here shifts every incident in the file by a frame interval — invisible at
   * 2 fps, wrong at every rate, and impossible to notice from the incident itself.
   */
  it('places the first frame at offset zero', () => {
    expect(frameOffsetSeconds(1, 2)).toBe(0);
    expect(frameOffsetSeconds(1, 30)).toBe(0);
  });

  it('advances by exactly one frame interval', () => {
    expect(frameOffsetSeconds(2, 2)).toBe(0.5);
    expect(frameOffsetSeconds(3, 2)).toBe(1);
    expect(frameOffsetSeconds(121, 2)).toBe(60);
  });

  it('maps a frame to a wall-clock instant inside the footage', () => {
    const at = frameFootageTime('2026-08-01T09:00:00.000Z', 121, 2);
    expect(at.toISOString()).toBe('2026-08-01T09:01:00.000Z');
  });

  /*
   * ⭐ THE property of this milestone, stated as a test. The analysis speed is not an input to this
   * function at all — which is exactly why replaying at 8× cannot move an incident. If this ever
   * takes a wall clock, that guarantee is gone.
   */
  it('gives the same answer no matter how fast the analysis runs', () => {
    const slow = frameFootageTime('2026-08-01T09:00:00.000Z', 601, 2);
    const fast = frameFootageTime('2026-08-01T09:00:00.000Z', 601, 2);
    expect(slow.toISOString()).toBe(fast.toISOString());
    expect(slow.toISOString()).toBe('2026-08-01T09:05:00.000Z');
  });

  it('refuses a frame rate that cannot produce a timeline', () => {
    expect(() => frameOffsetSeconds(10, 0)).toThrow(/positive/);
    expect(() => frameOffsetSeconds(10, -1)).toThrow(/positive/);
    expect(() => frameFootageTime('not-a-date', 1, 2)).toThrow(/not a date/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('containers — accepted is not decodable', () => {
  it('accepts mp4', () => {
    expect(resolveContainer('video/mp4')).toEqual({ ok: true, container: 'mp4' });
    expect(resolveContainer('video/mp4; codecs="avc1"')).toEqual({ ok: true, container: 'mp4' });
  });

  /*
   * ⚠️ Two different refusals, and the difference matters to the person reading it: "we do not
   * support .mkv yet" and "that is not a video" lead to different next actions.
   */
  it('refuses a declared container it cannot yet decode, and says which', () => {
    const r = resolveContainer('video/x-matroska');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/has not proven it can decode/);
  });

  it('refuses something that is not a video at all, and lists what it takes', () => {
    const r = resolveContainer('application/zip');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsupported content type.*accepted: video\/mp4/s);
  });
});

// ---------------------------------------------------------------------------------------------

describe('ffprobe parsing — every shape a real file can produce', () => {
  const stream = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      streams: [
        {
          codec_name: 'h264',
          codec_tag_string: 'avc1',
          width: 1280,
          height: 720,
          avg_frame_rate: '30000/1001',
          duration: '12.5',
          ...over,
        },
      ],
      format: { duration: '12.5' },
    });

  it('reads codec, tag, dimensions, rate and duration', () => {
    const r = parseProbe(stream());
    expect(r.codec).toBe('h264');
    expect(r.codecTag).toBe('avc1');
    expect(r.width).toBe(1280);
    expect(r.frameRate).toBeCloseTo(29.97, 2);
    expect(r.durationSeconds).toBe(12.5);
  });

  /*
   * ⛔ The most important refusal here. An audio file, a text file with a .mp4 extension and a
   * truncated container all land in this branch, and the alternative is an analysis that succeeds
   * having looked at nothing.
   */
  it('refuses a file with no video stream', () => {
    expect(() => parseProbe(JSON.stringify({ streams: [], format: {} }))).toThrow(
      /no video stream/,
    );
  });

  it('refuses output that is not JSON, and a stream with no usable dimensions', () => {
    expect(() => parseProbe('not json')).toThrow(/not JSON/);
    expect(() => parseProbe(stream({ width: 0 }))).toThrow(/no usable dimensions/);
  });

  /* ⚠️ A fragmented mp4 carries duration in neither place. 0 is refused by name downstream. */
  it('falls back to the format duration, then to zero — never to a guess', () => {
    const noStreamDuration = JSON.stringify({
      streams: [{ codec_name: 'h264', width: 640, height: 480, avg_frame_rate: '25/1' }],
      format: { duration: '9.0' },
    });
    expect(parseProbe(noStreamDuration).durationSeconds).toBe(9);

    const neither = JSON.stringify({
      streams: [{ codec_name: 'h264', width: 640, height: 480, avg_frame_rate: '25/1' }],
      format: {},
    });
    expect(parseProbe(neither).durationSeconds).toBe(0);
  });

  /* ⚠️ `0/0` is what ffprobe says for a stream with no rate. NaN here fails validation far away. */
  it('turns an unknown frame rate into 0 rather than NaN', () => {
    expect(parseRational('0/0')).toBe(0);
    expect(parseRational(undefined)).toBe(0);
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
    expect(Number.isNaN(parseProbe(stream({ avg_frame_rate: '0/0' })).frameRate)).toBe(false);
  });

  it('drops ffprobe’s placeholder codec tag rather than storing it', () => {
    expect(parseProbe(stream({ codec_tag_string: '[0][0][0][0]' })).codecTag).toBeUndefined();
  });

  it('reads the container’s creation time when it carries one', () => {
    const withTags = JSON.stringify({
      streams: [{ codec_name: 'h264', width: 640, height: 480, avg_frame_rate: '25/1' }],
      format: { duration: '5', tags: { creation_time: '2026-07-14T18:30:00.000000Z' } },
    });
    expect(parseProbe(withTags).createdAt?.toISOString()).toBe('2026-07-14T18:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------------------------

describe('asset refusals and findings', () => {
  const asset = (over: Record<string, unknown> = {}) => ({
    key: 'analyses/a/source.mp4',
    originalName: 'clip.mp4',
    bytes: 1000,
    contentType: 'video/mp4',
    container: 'mp4' as const,
    codec: 'h264',
    width: 1280,
    height: 720,
    sourceFrameRate: 25,
    durationSeconds: 60,
    ...over,
  });

  it('refuses a file with no playable video, naming the reason', () => {
    expect(rejectAsset(asset({ durationSeconds: 0 }))).toMatch(/no playable video/);
  });

  it('refuses an over-long recording and an over-large file, naming the limit', () => {
    expect(rejectAsset(asset({ durationSeconds: ANALYSIS_LIMITS.maxDurationSeconds + 1 }))).toMatch(
      /the limit is/,
    );
    expect(rejectAsset(asset({ bytes: ANALYSIS_LIMITS.maxBytes + 1 }))).toMatch(/the limit is/);
  });

  it('accepts an ordinary recording', () => {
    expect(rejectAsset(asset())).toBeNull();
  });

  /* ⛔ TD-29's finding applied to an upload: hvc1 plays in Safari, hev1 genuinely does not. */
  it('warns that an hev1 recording analyses fine and plays back nowhere on iOS', () => {
    const findings = assetFindings(asset({ codec: 'hevc', codecTag: 'hev1' }), 'operator');
    expect(findings.map((f) => f.kind)).toContain('codec-playback-limited');
    expect(findings[0]?.detail).toMatch(/Safari/);
  });

  it('does not warn about hvc1, which every engine can play', () => {
    expect(assetFindings(asset({ codec: 'hevc', codecTag: 'hvc1' }), 'operator')).toEqual([]);
  });

  /*
   * ⭐ An assumed footage start is a finding, not a silent default. Every incident time in the
   * analysis is derived from it, so an operator has to be told it was not confirmed.
   */
  it('records an assumed footage start as a finding, and says what it means', () => {
    const fromFile = assetFindings(asset(), 'container-metadata');
    expect(fromFile[0]?.kind).toBe('footage-start-assumed');
    expect(fromFile[0]?.detail).toMatch(/has not been confirmed/);

    const fromUpload = assetFindings(asset(), 'upload-time');
    expect(fromUpload[0]?.detail).toMatch(/offsets from the upload, not real clock times/);

    expect(assetFindings(asset(), 'operator')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('footage start resolution — a person beats a file beats a guess', () => {
  const doc = (over: Partial<AnalysisDoc> = {}) =>
    ({
      footageStartedAt: '2026-08-01T10:00:00.000Z',
      footageStartSource: 'upload-time',
      ...over,
    }) as AnalysisDoc;

  it('prefers what the operator says now', () => {
    const r = resolveFootageStart(doc(), '2026-07-01T00:00:00.000Z', new Date('2026-06-01'));
    expect(r).toEqual({ at: '2026-07-01T00:00:00.000Z', source: 'operator' });
  });

  it('keeps what the operator said at creation over the file’s metadata', () => {
    const r = resolveFootageStart(
      doc({ footageStartSource: 'operator', footageStartedAt: '2026-07-02T00:00:00.000Z' }),
      undefined,
      new Date('2026-06-01'),
    );
    expect(r.source).toBe('operator');
    expect(r.at).toBe('2026-07-02T00:00:00.000Z');
  });

  it('uses the container’s creation time when nobody has said otherwise', () => {
    const r = resolveFootageStart(doc(), undefined, new Date('2026-06-01T12:00:00.000Z'));
    expect(r).toEqual({ at: '2026-06-01T12:00:00.000Z', source: 'container-metadata' });
  });

  it('falls back to the upload time and labels it as such', () => {
    expect(resolveFootageStart(doc(), undefined, undefined).source).toBe('upload-time');
  });

  /* ⚠️ An unparseable container time must not become an Invalid Date on the record. */
  it('ignores an unparseable container time rather than storing it', () => {
    expect(resolveFootageStart(doc(), undefined, new Date('nonsense')).source).toBe('upload-time');
  });
});

// ---------------------------------------------------------------------------------------------

class FakeProbe implements MediaProbe {
  result: ProbeResult = {
    codec: 'h264',
    codecTag: 'avc1',
    width: 1280,
    height: 720,
    frameRate: 25,
    durationSeconds: 60,
  };
  error: Error | null = null;
  async probe(): Promise<ProbeResult> {
    if (this.error !== null) throw this.error;
    return this.result;
  }
}

function build(opts: { cameraExists?: boolean } = {}) {
  const store = new InMemoryAnalysisStore();
  const objectStore = memoryObjectStore();
  const probe = new FakeProbe();
  let seq = 0;
  let sessionSeq = 0;
  const service = new AnalysisService({
    store,
    objectStore,
    probe,
    cameras: {
      async exists() {
        return opts.cameraExists ?? true;
      },
    },
    clock: { now: () => new Date('2026-08-07T12:00:00.000Z') },
    ids: {
      analysisId: () => `ana_${++seq}`,
      /* ⚠️ Monotonic, not clock-derived — two sessions created in one millisecond must differ. */
      sessionId: () => `ases_${++sessionSeq}`,
    },
    capabilityId: 'perception.person-detection',
    defaultFrameRate: 2,
    playbackTtlSeconds: 900,
  });
  return { service, store, objectStore, probe, scope: TenantScope.fromTenantId('tnt_a') };
}

const create = {
  cameraId: 'cam_1',
  originalName: 'yesterday.mp4',
  contentType: 'video/mp4',
  bytes: 1024,
};

describe('AnalysisService — the upload lifecycle', () => {
  it('creates a draft and a presigned URL scoped to a generated key', async () => {
    const { service, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    expect(out.analysis.state).toBe('draft');
    expect(out.method).toBe('PUT');
    /* ⭐ The key is generated from the analysis id — never from the customer's filename. */
    expect(out.uploadUrl).toContain('analyses/ana_1/source.mp4');
    expect(out.uploadUrl).not.toContain('yesterday');
  });

  /*
   * ⛔ The camera carries the zones and the rules. An analysis bound to one that does not exist
   * would run happily and find nothing, which is the answer this platform must never give.
   */
  it('refuses an analysis for a camera it cannot confirm', async () => {
    const { service, scope } = build({ cameraExists: false });
    await expect(service.createUpload(scope, 'usr_1', create)).rejects.toThrow(
      /must be bound to a real camera/,
    );
  });

  /* ⚠️ Before a byte moves — refusing after a 2 GB upload is the same rule and a different product. */
  it('refuses an oversized file before the upload rather than after', async () => {
    const { service, scope } = build();
    await expect(
      service.createUpload(scope, 'usr_1', { ...create, bytes: ANALYSIS_LIMITS.maxBytes + 1 }),
    ).rejects.toThrow(/refused before upload/);
  });

  it('refuses a content type it cannot decode', async () => {
    const { service, scope } = build();
    await expect(
      service.createUpload(scope, 'usr_1', { ...create, contentType: 'application/zip' }),
    ).rejects.toThrow(/unsupported content type/);
  });

  it('confirms an uploaded file and stores what was MEASURED, not what was declared', async () => {
    const { service, objectStore, probe, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    await objectStore.put({ key: `tnt_a/analyses/ana_1/source.mp4`, body: new Uint8Array(1024) });
    probe.result = { ...probe.result, codec: 'hevc', codecTag: 'hvc1', width: 1920, height: 1080 };

    const confirmed = await service.confirmUpload(scope, out.analysis.id, {});
    expect(confirmed.state).toBe('ready');
    /* The uploader said `video/mp4`; ffprobe said hevc. The record carries the measurement. */
    expect(confirmed.asset?.codec).toBe('hevc');
    expect(confirmed.asset?.width).toBe(1920);
    expect(confirmed.asset?.bytes).toBe(1024);
  });

  it('refuses to confirm before any bytes have arrived', async () => {
    const { service, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    await expect(service.confirmUpload(scope, out.analysis.id, {})).rejects.toThrow(
      /no file has been uploaded/,
    );
  });

  /*
   * ⚠️ A truncated upload probes as a SHORTER VIDEO, not as an error — so without this check a
   * ten-minute recording is silently analysed for four and nothing anywhere says why.
   */
  it('refuses an upload whose size does not match what was declared', async () => {
    const { service, objectStore, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    await objectStore.put({ key: 'tnt_a/analyses/ana_1/source.mp4', body: new Uint8Array(999) });
    await expect(service.confirmUpload(scope, out.analysis.id, {})).rejects.toThrow(
      /upload was probably interrupted/,
    );
  });

  it('turns an unreadable file into a refusal that names what happened', async () => {
    const { service, objectStore, probe, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    await objectStore.put({ key: 'tnt_a/analyses/ana_1/source.mp4', body: new Uint8Array(1024) });
    probe.error = new Error('the file contains no video stream');
    await expect(service.confirmUpload(scope, out.analysis.id, {})).rejects.toThrow(
      /could not be read as a video.*no video stream/,
    );
  });
});

describe('AnalysisService — sessions', () => {
  async function ready() {
    const ctx = build();
    const out = await ctx.service.createUpload(ctx.scope, 'usr_1', create);
    await ctx.objectStore.put({
      key: 'tnt_a/analyses/ana_1/source.mp4',
      body: new Uint8Array(1024),
    });
    await ctx.service.confirmUpload(ctx.scope, out.analysis.id, {
      footageStartedAt: '2026-08-01T09:00:00.000Z',
    });
    return { ...ctx, analysisId: out.analysis.id };
  }

  it('records a queued session carrying its provenance', async () => {
    const { service, scope, analysisId } = await ready();
    const session = await service.startSession(scope, analysisId, 'usr_1', {});
    expect(session.state).toBe('queued');
    expect(session.sequence).toBe(1);
    expect(session.provenance.capabilityId).toBe('perception.person-detection');
    expect(session.provenance.pipelineVersion).toBe('1.0.0');
    expect(session.analysisFrameRate).toBe(2);
    expect(session.progress.durationSeconds).toBe(60);
  });

  /* ⭐ A rerun is a new session, not a replacement — the first answer is never overwritten. */
  it('numbers reruns and keeps every earlier session', async () => {
    const { service, scope, analysisId } = await ready();
    const first = await service.startSession(scope, analysisId, 'usr_1', {});
    await service.cancelSession(scope, first.id);
    const second = await service.startSession(scope, analysisId, 'usr_1', {});

    expect(second.sequence).toBe(2);
    const detail = await service.detail(scope, analysisId);
    expect(detail.sessions).toHaveLength(2);
    expect(detail.analysis.sessionCount).toBe(2);
  });

  it('refuses a second concurrent session, naming the one already running', async () => {
    const { service, scope, analysisId } = await ready();
    const first = await service.startSession(scope, analysisId, 'usr_1', {});
    await expect(service.startSession(scope, analysisId, 'usr_1', {})).rejects.toThrow(
      new RegExp(`${first.id} is already queued`),
    );
  });

  it('refuses to run an analysis whose file was never confirmed', async () => {
    const { service, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    await expect(service.startSession(scope, out.analysis.id, 'usr_1', {})).rejects.toThrow(
      /no file yet/,
    );
  });

  /* ⚠️ Cancelling something already finished is a conflict — the caller believes something false. */
  it('refuses to cancel a session that has already finished', async () => {
    const { service, scope, analysisId } = await ready();
    const s = await service.startSession(scope, analysisId, 'usr_1', {});
    await service.cancelSession(scope, s.id);
    await expect(service.cancelSession(scope, s.id)).rejects.toThrow(/already cancelled/);
  });

  /* ⛔ Deleting the object a worker is decoding turns a running analysis into a decode error. */
  it('refuses to delete an analysis while a session is live', async () => {
    const { service, scope, analysisId } = await ready();
    await service.startSession(scope, analysisId, 'usr_1', {});
    await expect(service.remove(scope, analysisId)).rejects.toThrow(/cancel it before deleting/);
  });

  it('deletes the analysis, its sessions and its bytes once nothing is running', async () => {
    const { service, objectStore, scope, analysisId } = await ready();
    const s = await service.startSession(scope, analysisId, 'usr_1', {});
    await service.cancelSession(scope, s.id);

    await service.remove(scope, analysisId);
    expect(objectStore.keys()).not.toContain('tnt_a/analyses/ana_1/source.mp4');
    await expect(service.detail(scope, analysisId)).rejects.toThrow(/not found/);
  });

  it('carries the asset’s findings onto the session that will run it', async () => {
    const ctx = build();
    const out = await ctx.service.createUpload(ctx.scope, 'usr_1', create);
    await ctx.objectStore.put({
      key: 'tnt_a/analyses/ana_1/source.mp4',
      body: new Uint8Array(1024),
    });
    ctx.probe.result = { ...ctx.probe.result, codec: 'hevc', codecTag: 'hev1' };
    /* No operator-supplied start and no container time → two findings, both honest. */
    await ctx.service.confirmUpload(ctx.scope, out.analysis.id, {});

    const session = await ctx.service.startSession(ctx.scope, out.analysis.id, 'usr_1', {});
    expect(session.findings.map((f) => f.kind).sort()).toEqual([
      'codec-playback-limited',
      'footage-start-assumed',
    ]);
  });
});

describe('AnalysisService — tenant isolation', () => {
  /* ⚠️ Another tenant's analysis is a 404, never a 403 — a 403 confirms it exists. */
  it('hides another tenant’s analysis rather than refusing access to it', async () => {
    const { service, scope } = build();
    const out = await service.createUpload(scope, 'usr_1', create);
    const other = TenantScope.fromTenantId('tnt_b');

    await expect(service.detail(other, out.analysis.id)).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<AppError>);
    expect((await service.list(other, { limit: 50 })).items).toHaveLength(0);
  });
});

describe('AnalysisService — the race the check cannot win', () => {
  /*
   * ⭐ Two operators press "run" in the same tick. Both read zero existing sessions, both decide
   * they are number 1. The service's `find(active)` check cannot prevent this — it is a
   * read-then-write — so the store's uniqueness decides, and the loser must be told rather than
   * quietly given a second session sharing a run number with the first.
   *
   * ⚠️ This test is only meaningful because the in-memory store enforces the same constraint the
   * Mongo index does. A permissive fake here would make it pass while production raced.
   */
  it('lets exactly one of two simultaneous runs win, and tells the other', async () => {
    const ctx = build();
    const out = await ctx.service.createUpload(ctx.scope, 'usr_1', create);
    await ctx.objectStore.put({
      key: 'tnt_a/analyses/ana_1/source.mp4',
      body: new Uint8Array(1024),
    });
    await ctx.service.confirmUpload(ctx.scope, out.analysis.id, {});

    const results = await Promise.allSettled([
      ctx.service.startSession(ctx.scope, out.analysis.id, 'usr_1', {}),
      ctx.service.startSession(ctx.scope, out.analysis.id, 'usr_2', {}),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });

    const detail = await ctx.service.detail(ctx.scope, out.analysis.id);
    expect(detail.sessions).toHaveLength(1);
  });
});
