/**
 * Media catalog unit tests (P2-2 G-2) — the recording/clip use-cases over the in-memory store:
 * idempotent indexing, newest-first keyset pagination, tenant isolation, clip coverage snapshotting,
 * pre-materialization playback, and the pure stream-health derivation. Deterministic; no Mongo/S3.
 */
import { describe, expect, it } from 'vitest';
import type { RecordingSegment } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { MediaCatalogService } from '../src/application/media-catalog-service.js';
import { InMemoryMediaCatalog } from '../src/adapters/in-memory-media-catalog.js';
import { streamHealthState } from '../src/domain/stream.js';
import { recordingId } from '../src/domain/recording.js';
import { memoryObjectStore } from './helpers.js';

const TENANT = 'tnt_a';
const scope = TenantScope.fromTenantId(TENANT);

function build() {
  let n = 0;
  const store = new InMemoryMediaCatalog();
  const catalog = new MediaCatalogService({
    store,
    objectStore: memoryObjectStore(),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { clipId: () => `clip_${++n}` },
    playbackTtlSeconds: 300,
  });
  return { catalog, store };
}

const seg = (cameraId: string, startedAt: string): RecordingSegment => ({
  tenantId: TENANT,
  cameraId,
  key: `${cameraId}/recordings/seg-${startedAt}.mp4`,
  startedAt,
  durationSeconds: 6,
  sizeBytes: 2048,
  contentType: 'video/mp4',
});

describe('recording indexing', () => {
  it('is idempotent on the derived id (same segment → one recording)', async () => {
    const { catalog } = build();
    await catalog.record(seg('cam_1', '2026-07-28T00:00:00.000Z'));
    await catalog.record(seg('cam_1', '2026-07-28T00:00:00.000Z'));
    const { items } = await catalog.listRecordings(scope, { limit: 50 });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(
      recordingId(TENANT, 'cam_1/recordings/seg-2026-07-28T00:00:00.000Z.mp4'),
    );
    expect(items[0]!.endedAt).toBe('2026-07-28T00:00:06.000Z');
  });
});

describe('recording listing', () => {
  it('paginates newest-first with an opaque cursor', async () => {
    const { catalog } = build();
    for (let i = 0; i < 3; i++) {
      await catalog.record(seg('cam_1', `2026-07-28T00:0${i}:00.000Z`));
    }
    const p1 = await catalog.listRecordings(scope, { limit: 2 });
    expect(p1.items.map((r) => r.startedAt)).toEqual([
      '2026-07-28T00:02:00.000Z',
      '2026-07-28T00:01:00.000Z',
    ]);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await catalog.listRecordings(scope, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.startedAt)).toEqual(['2026-07-28T00:00:00.000Z']);
    expect(p2.nextCursor).toBeUndefined();
  });

  it('filters by camera; playback resolves a signed URL', async () => {
    const { catalog } = build();
    await catalog.record(seg('cam_1', '2026-07-28T00:00:00.000Z'));
    await catalog.record(seg('cam_2', '2026-07-28T00:00:00.000Z'));
    const { items } = await catalog.listRecordings(scope, { limit: 50, cameraId: 'cam_2' });
    expect(items).toHaveLength(1);
    const target = await catalog.recordingPlayback(scope, items[0]!.id);
    expect(target).toMatchObject({ expiresInSeconds: 300, contentType: 'video/mp4' });
    expect(target.url).toContain('https://signed/');
  });

  it('404s an unknown / cross-tenant recording', async () => {
    const { catalog } = build();
    await expect(catalog.getRecording(scope, 'rec_missing')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('clips', () => {
  it('snapshots covering recordings and plays them back until materialized', async () => {
    const { catalog } = build();
    // Two recordings spanning 00:00–00:12; clip window 00:03–00:09 overlaps both.
    await catalog.record(seg('cam_1', '2026-07-28T00:00:00.000Z'));
    await catalog.record(seg('cam_1', '2026-07-28T00:00:06.000Z'));

    const clip = await catalog.createClip(scope, 'usr_1', {
      cameraId: 'cam_1',
      startedAt: '2026-07-28T00:00:03.000Z',
      endedAt: '2026-07-28T00:00:09.000Z',
      label: 'Loiter',
    });
    expect(clip).toMatchObject({ status: 'pending', durationSeconds: 6, createdBy: 'usr_1' });
    expect(clip.segmentKeys).toHaveLength(2);

    const playback = await catalog.clipPlayback(scope, clip.id);
    expect(playback.segments).toHaveLength(2);
    expect(playback.segments.every((s) => s.url.includes('https://signed/'))).toBe(true);
  });

  it('lists by incident and deletes (404 after)', async () => {
    const { catalog } = build();
    await catalog.createClip(scope, 'usr_1', {
      cameraId: 'cam_1',
      startedAt: '2026-07-28T00:00:00.000Z',
      endedAt: '2026-07-28T00:00:10.000Z',
      incidentId: 'inc_1',
    });
    const byIncident = await catalog.listClips(scope, { limit: 50, incidentId: 'inc_1' });
    expect(byIncident.items).toHaveLength(1);
    const id = byIncident.items[0]!.id;

    await catalog.deleteClip(scope, id);
    await expect(catalog.getClip(scope, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(catalog.deleteClip(scope, id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not leak clips across tenants', async () => {
    const { catalog } = build();
    const clip = await catalog.createClip(scope, 'usr_1', {
      cameraId: 'cam_1',
      startedAt: '2026-07-28T00:00:00.000Z',
      endedAt: '2026-07-28T00:00:10.000Z',
    });
    const other = TenantScope.fromTenantId('tnt_b');
    await expect(catalog.getClip(other, clip.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await catalog.listClips(other, { limit: 50 })).items).toHaveLength(0);
  });
});

describe('stream-health derivation', () => {
  it('maps worker state to operational health', () => {
    expect(streamHealthState('connected')).toBe('healthy');
    expect(streamHealthState('connecting')).toBe('degraded');
    expect(streamHealthState('lost')).toBe('degraded');
    expect(streamHealthState('stopped')).toBe('down');
    expect(streamHealthState('idle')).toBe('unknown');
  });
});
