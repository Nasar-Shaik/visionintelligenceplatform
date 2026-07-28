/**
 * Integration test — the auth vertical + refresh reuse-detection + tenant isolation against a REAL
 * MongoDB. Uses the dev-stack Mongo via MONGO_URI (default port 47017) and SKIPS gracefully when
 * none is reachable, so `pnpm test` stays green everywhere. Part of the standing isolation suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantRepository, TenantScope } from '@vip/tenancy';
import { AuthError } from '@vip/auth';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { AuthService } from '../src/application/auth-service.js';
import { UserService } from '../src/application/user-service.js';

const URI = process.env.MONGO_URI ?? 'mongodb://localhost:47017/vip_identity_test';
const DB = `vip_identity_it_${Date.now()}`;

let mongo: MongoAdapter | undefined;
let auth: AuthService;
let users: UserService;

async function reachable(): Promise<boolean> {
  try {
    mongo = await connectMongo({ uri: URI, dbName: DB, serverSelectionTimeoutMS: 1200 });
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();

describe.skipIf(!online)('identity auth against real MongoDB', () => {
  beforeAll(() => {
    const m = mongo!;
    let n = 0;
    const repo = new TenantRepository(m.users);
    users = new UserService({
      users: repo,
      clock: { now: () => new Date() },
      ids: { userId: () => `usr_it_${++n}` },
    });
    auth = new AuthService({
      users: repo,
      refreshTokens: m.refreshTokens,
      jwt: {
        secret: 'integration-secret-16chars',
        accessTtl: '15m',
        refreshTtl: '7d',
        issuer: 'identity',
        audience: 'vip',
      },
      clock: { now: () => new Date() },
      ids: { familyId: () => `fam_it_${++n}` },
    });
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.close();
    }
  });

  it('logs in, rotates, and detects reuse (revokes the family)', async () => {
    const scope = TenantScope.fromTenantId('tnt_a');
    await users.create(scope, {
      email: 'admin@acme.com',
      password: 'supersecret',
      roles: ['admin'],
    });

    const pair = await auth.login(scope, { email: 'admin@acme.com', password: 'supersecret' });
    expect(pair.accessToken).toBeTruthy();

    const rotated = await auth.refresh(pair.refreshToken);
    expect(rotated.refreshToken).not.toBe(pair.refreshToken);

    // Replay the original (now-used) token → reuse → family revoked.
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(AuthError);
    await expect(auth.refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
  });

  it('a duplicate email within a tenant is rejected; the same email in another tenant is fine', async () => {
    const a = TenantScope.fromTenantId('tnt_dup_a');
    const b = TenantScope.fromTenantId('tnt_dup_b');
    await users.create(a, { email: 'dup@acme.com', password: 'supersecret', roles: [] });
    await expect(
      users.create(a, { email: 'dup@acme.com', password: 'supersecret', roles: [] }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Same email, different tenant → allowed (unique is per-tenant).
    await expect(
      users.create(b, { email: 'dup@acme.com', password: 'supersecret', roles: [] }),
    ).resolves.toMatchObject({ email: 'dup@acme.com' });
  });

  it('users never cross tenants; wrong-tenant login fails', async () => {
    const a = TenantScope.fromTenantId('tnt_iso_a');
    const b = TenantScope.fromTenantId('tnt_iso_b');
    await users.create(a, { email: 'iso@acme.com', password: 'supersecret', roles: [] });

    expect(await users.list(a)).toHaveLength(1);
    expect(await users.list(b)).toHaveLength(0); // A's user invisible to B

    // Logging into the wrong tenant with A's credentials fails (user not found in B).
    await expect(auth.login(b, { email: 'iso@acme.com', password: 'supersecret' })).rejects.toThrow(
      AuthError,
    );
  });
});
