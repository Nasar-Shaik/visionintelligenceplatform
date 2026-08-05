/**
 * Integration test — the camera inventory against a REAL MongoDB (not a fake): the unique
 * stream-URL index, cross-tenant isolation via @vip/tenancy, and that vaulted credentials are
 * stored as ciphertext yet recoverable through the vault. Uses the dev-stack Mongo via MONGO_URI
 * and SKIPS gracefully when none is reachable (so default `pnpm test` stays green everywhere).
 * Part of the standing cross-tenant isolation suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantRepository, TenantScope } from '@vip/tenancy';
import { SecretBox } from '@vip/crypto';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { CameraService } from '../src/application/camera-service.js';
import type { CameraDoc } from '../src/domain/camera.js';
import type { Camera } from '@vip/contracts';

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_camera_test?authSource=admin';
const DB = `vip_camera_it_${Date.now()}`;
const SECRET = 'integration-secret-16chars-min';

let mongo: MongoAdapter | undefined;
let service: CameraService;
const vault = SecretBox.fromSecret(SECRET);

async function reachable(): Promise<boolean> {
  try {
    mongo = await connectMongo({ uri: URI, dbName: DB, serverSelectionTimeoutMS: 1200 });
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();

const camera = (streamUrl: string) => ({
  zoneId: 'on_zone1',
  name: 'Cam',
  protocol: 'rtsp' as const,
  streamUrl,
  credentials: { username: 'admin', password: 's3cr3t' },
});

describe.skipIf(!online)('camera inventory against real MongoDB', () => {
  beforeAll(() => {
    let n = 0;
    service = new CameraService({
      cameras: new TenantRepository(mongo!.cameras),
      probes: new TenantRepository(mongo!.probes),
      vault,
      clock: { now: () => new Date() },
      ids: { cameraId: () => `cam_it_${++n}`, probeId: () => `prb_it_${++n}` },
    });
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.close();
    }
  });

  it('onboards, reads back, and removes a camera (credentials never in the public shape)', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    const created = await service.create(scope, camera('rtsp://cam-a.local/1'));
    expect(created.hasCredentials).toBe(true);
    expect(JSON.stringify(created)).not.toContain('s3cr3t');

    const got = await service.get(scope, created.id);
    expect(got.name).toBe('Cam');

    await service.remove(scope, created.id);
    await expect(service.get(scope, created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  /**
   * ⚠️ **Two administrators, one camera — and the edit that was thrown away.**
   *
   * Measured on the deployment at P-6.6: one wrote a note, the other a tag, **both were told HTTP
   * 200, and only one edit survived.** The write filtered on `_id` alone, so whoever arrived second
   * overwrote a record they had never read. This is the P-6.5 acknowledgement race one layer up, and
   * what it loses is typed operator work rather than a status.
   *
   * ⚠️ Against real MongoDB, because the in-memory store serialises every operation — the same
   * scenario written against a fake passes on the defect. Written red first: with the guard removed
   * from the write's filter, this test reports two winners.
   */
  it('⚠️ refuses the second of two concurrent edits rather than silently discarding the first', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    const created = await service.create(scope, camera('rtsp://cam-race.local/1'));

    /* Both operators are holding the record as they read it — the same `updatedAt`. */
    const loaded = await service.get(scope, created.id);

    const results = await Promise.allSettled([
      service.update(scope, created.id, { name: 'renamed by alice' }, loaded.updatedAt),
      service.update(scope, created.id, { name: 'renamed by bob' }, loaded.updatedAt),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });

    /* And the record holds the winner's value, not a merge of the two. */
    const after = await service.get(scope, created.id);
    expect(after.name).toBe((winners[0] as PromiseFulfilledResult<Camera>).value.name);

    /* ⚠️ A caller that sends no token keeps the old behaviour — the guard is additive. */
    const unguarded = await service.update(scope, created.id, { name: 'no token' });
    expect(unguarded.name).toBe('no token');

    await service.remove(scope, created.id);
  });

  it('persists credentials as ciphertext, decryptable only through the vault', async () => {
    const scope = TenantScope.fromTenantId('tnt_vault');
    const created = await service.create(scope, camera('rtsp://cam-vault.local/1'));
    const raw = (await mongo!.cameras.findOne({ _id: created.id })) as CameraDoc;
    expect(raw.credentialCipher).toBeTruthy();
    expect(raw.credentialCipher!).not.toContain('s3cr3t');
    expect(JSON.parse(vault.open(raw.credentialCipher!)).password).toBe('s3cr3t');
  });

  it('rejects a duplicate stream URL within a tenant (409)', async () => {
    const scope = TenantScope.fromTenantId('tnt_dupe');
    await service.create(scope, camera('rtsp://dupe.local/1'));
    await expect(service.create(scope, camera('rtsp://dupe.local/1'))).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('keeps cameras isolated across tenants (same URL allowed in a different tenant)', async () => {
    const a = TenantScope.fromTenantId('tnt_iso_a');
    const b = TenantScope.fromTenantId('tnt_iso_b');
    const url = 'rtsp://shared.local/1';
    const ca = await service.create(a, camera(url));
    // Same URL is fine under a different tenant (unique index is tenant-leading).
    await expect(service.create(b, camera(url))).resolves.toBeTruthy();

    // A's camera is invisible and unaddressable from B.
    expect((await service.list(b)).some((c) => c.id === ca.id)).toBe(false);
    await expect(service.get(b, ca.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
