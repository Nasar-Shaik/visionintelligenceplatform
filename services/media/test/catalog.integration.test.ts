/**
 * Integration test — the media catalog against a REAL MongoDB (not the in-memory fake): idempotent
 * recording indexing, keyset pagination (newest-first), overlap-based clip coverage, and cross-tenant
 * isolation via @vip/tenancy. Uses the dev-stack Mongo via MONGO_URI and SKIPS gracefully when none
 * is reachable (so default `pnpm test` stays green everywhere). Part of the cross-tenant isolation
 * suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingSegment } from '@vip/contracts';
import { TenantScope } from '@vip/tenancy';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { newRecording } from '../src/domain/recording.js';
import { newClip } from '../src/domain/clip.js';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_media_test?authSource=admin';
const DB = `vip_media_it_${Date.now()}`;

let mongo: MongoAdapter | undefined;

async function reachable(): Promise<boolean> {
  try {
    mongo = await connectMongo({ uri: URI, dbName: DB, serverSelectionTimeoutMS: 1200 });
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();
const now = new Date('2026-07-28T00:00:00.000Z');
const A = TenantScope.fromTenantId('tnt_a');
const B = TenantScope.fromTenantId('tnt_b');

const seg = (tenantId: string, cameraId: string, startedAt: string): RecordingSegment => ({
  tenantId,
  cameraId,
  key: `${cameraId}/recordings/seg-${startedAt}.mp4`,
  startedAt,
  durationSeconds: 6,
  sizeBytes: 1024,
  contentType: 'video/mp4',
});

describe.skipIf(!online)('media catalog against real MongoDB', () => {
  beforeAll(async () => {
    const cat = mongo!.catalog;
    await cat.putRecording(A, newRecording(seg('tnt_a', 'cam_1', '2026-07-28T00:00:00.000Z'), now));
    await cat.putRecording(A, newRecording(seg('tnt_a', 'cam_1', '2026-07-28T00:00:06.000Z'), now));
    // Idempotent: re-indexing the same segment is a no-op.
    await cat.putRecording(A, newRecording(seg('tnt_a', 'cam_1', '2026-07-28T00:00:00.000Z'), now));
    await cat.putRecording(B, newRecording(seg('tnt_b', 'cam_9', '2026-07-28T00:00:00.000Z'), now));
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.close();
    }
  });

  it('indexes idempotently and paginates newest-first, tenant-scoped', async () => {
    const cat = mongo!.catalog;
    const p1 = await cat.listRecordings(A, { limit: 1 });
    expect(p1.items).toHaveLength(1);
    expect(p1.items[0]!.startedAt).toBe('2026-07-28T00:00:06.000Z'); // newest first
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await cat.listRecordings(A, { limit: 1, cursor: p1.nextCursor! });
    expect(p2.items[0]!.startedAt).toBe('2026-07-28T00:00:00.000Z');
    expect(p2.nextCursor).toBeUndefined();

    // Tenant A sees exactly its two recordings (idempotent third insert did not duplicate).
    expect((await cat.listRecordings(A, { limit: 50 })).items).toHaveLength(2);
    // Tenant B never sees tenant A's recordings.
    expect((await cat.listRecordings(B, { limit: 50 })).items).toHaveLength(1);
  });

  it('resolves clip coverage by time-range overlap within a tenant', async () => {
    const cat = mongo!.catalog;
    const covering = await cat.recordingsCovering(
      A,
      'cam_1',
      '2026-07-28T00:00:03.000Z',
      '2026-07-28T00:00:09.000Z',
    );
    expect(covering).toHaveLength(2); // both 6s segments overlap the window
    expect(covering[0]!.startedAt < covering[1]!.startedAt).toBe(true); // oldest-first
  });

  it('stores, fetches, and deletes a clip; another tenant cannot see it', async () => {
    const cat = mongo!.catalog;
    const clip = newClip(
      'tnt_a',
      'clip_it_1',
      'usr_1',
      {
        cameraId: 'cam_1',
        startedAt: '2026-07-28T00:00:00.000Z',
        endedAt: '2026-07-28T00:00:10.000Z',
        incidentId: 'inc_1',
      },
      [],
      now,
    );
    await cat.putClip(A, clip);
    expect(await cat.getClip(A, 'clip_it_1')).not.toBeNull();
    expect(await cat.getClip(B, 'clip_it_1')).toBeNull(); // cross-tenant
    expect((await cat.listClips(A, { limit: 50, incidentId: 'inc_1' })).items).toHaveLength(1);

    expect(await cat.deleteClip(B, 'clip_it_1')).toBe(false); // wrong tenant cannot delete
    expect(await cat.deleteClip(A, 'clip_it_1')).toBe(true);
    expect(await cat.getClip(A, 'clip_it_1')).toBeNull();
  });
});
