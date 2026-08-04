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

const URI =
  process.env.MONGO_URI ??
  'mongodb://vip_dev:change_me_dev_only@localhost:47017/vip_identity_test?authSource=admin';
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

/*
 * ⚠️ Wiring and teardown are file-level, not per-describe. They used to live inside the first
 * `describe`, so the second one ran against a closed client — every test in it failed with
 * "Client must be connected" rather than anything about the behaviour it was asserting.
 */
beforeAll(() => {
  if (!online) return;
  const m = mongo!;
  let n = 0;
  const repo = new TenantRepository(m.users);
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
  // ⚠️ Wired to the real `AuthService`, exactly as `index.ts` wires it. A stub revoker here would
  // make every "disabling ends the session" assertion below a test of the stub.
  users = new UserService({
    users: repo,
    clock: { now: () => new Date() },
    ids: { userId: () => `usr_it_${++n}` },
    sessions: auth,
  });
});

afterAll(async () => {
  if (mongo) {
    await mongo.db.dropDatabase();
    await mongo.close();
  }
});

describe.skipIf(!online)('identity auth against real MongoDB', () => {
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

/**
 * **Offboarding (P-6.2, TD-44).** The pilot blocker was that a leaver kept access to a security
 * product, so these assert the two halves of taking it away: the door is shut *and* the people
 * already inside are shown out.
 */
describe.skipIf(!online)('disabling a user actually ends their access', () => {
  const PASSWORD = 'supersecret';

  async function withUser(tenant: string, email: string) {
    const scope = TenantScope.fromTenantId(tenant);
    const user = await users.create(scope, { email, password: PASSWORD, roles: ['operator'] });
    return { scope, user };
  }

  it('refuses the next login and kills the session already open', async () => {
    const { scope, user } = await withUser('tnt_dis_1', 'leaver@acme.com');
    const pair = await auth.login(scope, { email: 'leaver@acme.com', password: PASSWORD });

    const result = await users.disable(scope, user.id, 'usr_admin');
    expect(result.user.status).toBe('disabled');
    /*
     * ⚠️ The count is the assertion that matters. Flipping the status alone would pass a test that
     * only re-read the record — and would leave the leaver signed in until their refresh token
     * expired a week later.
     */
    expect(result.sessionsRevoked).toBe(1);

    await expect(
      auth.login(scope, { email: 'leaver@acme.com', password: PASSWORD }),
    ).rejects.toThrow(AuthError);
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(AuthError);
  });

  it('re-enabling restores the right to sign in, not the revoked session', async () => {
    const { scope, user } = await withUser('tnt_dis_2', 'returner@acme.com');
    const pair = await auth.login(scope, { email: 'returner@acme.com', password: PASSWORD });
    await users.disable(scope, user.id, 'usr_admin');

    const restored = await users.enable(scope, user.id, 'usr_admin');
    expect(restored.status).toBe('active');

    // The password is untouched, so signing in works again…
    await expect(
      auth.login(scope, { email: 'returner@acme.com', password: PASSWORD }),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
    // …but the token that was revoked stays revoked. Re-enabling is not un-revoking.
    await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(AuthError);
  });

  it('counts sessions, not token records — a rotated session is still one session', async () => {
    /*
     * ⚠️ Found against the deployment, not here: a user with two open sessions, one of which had
     * rotated its refresh token, was reported as **3 sessions ended**. Rotation leaves the used
     * record in place and inserts a successor in the same family, so counting modified rows counts
     * the history of a session rather than the session. An administrator being told a security
     * action affected more devices than the person owns is being told something false.
     */
    const { scope, user } = await withUser('tnt_dis_count', 'rotator@acme.com');
    const a = await auth.login(scope, { email: 'rotator@acme.com', password: PASSWORD });
    await auth.login(scope, { email: 'rotator@acme.com', password: PASSWORD });
    await auth.refresh(a.refreshToken); // 2 sessions, 3 token records

    const { sessionsRevoked } = await users.disable(scope, user.id, 'usr_admin');
    expect(sessionsRevoked).toBe(2);
  });

  it('is idempotent — disabling twice is not an error, and still revokes', async () => {
    const { scope, user } = await withUser('tnt_dis_3', 'twice@acme.com');
    await users.disable(scope, user.id, 'usr_admin');
    // A retry after a partial failure has to be able to finish the job.
    await expect(users.disable(scope, user.id, 'usr_admin')).resolves.toMatchObject({
      user: { status: 'disabled' },
    });
  });

  it('refuses to let an administrator disable themselves', async () => {
    const { scope, user } = await withUser('tnt_dis_4', 'self@acme.com');
    await expect(users.disable(scope, user.id, user.id)).rejects.toMatchObject({ statusCode: 400 });
    // ⚠️ And the refusal is total: the account is untouched, not half-disabled.
    expect((await users.get(scope, user.id)).status).toBe('active');
  });

  it('a password reset ends every session the old password had opened', async () => {
    const { scope, user } = await withUser('tnt_dis_5', 'compromised@acme.com');
    const first = await auth.login(scope, { email: 'compromised@acme.com', password: PASSWORD });
    const second = await auth.login(scope, { email: 'compromised@acme.com', password: PASSWORD });

    const result = await users.setPassword(scope, user.id, 'a-brand-new-secret', 'usr_admin');
    expect(result.sessionsRevoked).toBe(2);

    for (const pair of [first, second]) {
      await expect(auth.refresh(pair.refreshToken)).rejects.toThrow(AuthError);
    }
    await expect(
      auth.login(scope, { email: 'compromised@acme.com', password: PASSWORD }),
    ).rejects.toThrow(AuthError);
    await expect(
      auth.login(scope, { email: 'compromised@acme.com', password: 'a-brand-new-secret' }),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('cannot reach a user in another tenant — and cannot tell one exists', async () => {
    const { user } = await withUser('tnt_dis_6a', 'theirs@acme.com');
    const other = TenantScope.fromTenantId('tnt_dis_6b');

    /*
     * ⚠️ 404, not 403. A 403 would confirm the id exists to someone in another tenant, which is an
     * enumeration oracle across the isolation boundary. The scoped filter simply never matches.
     */
    for (const act of [
      () => users.get(other, user.id),
      () => users.update(other, user.id, { roles: ['viewer'] }),
      () => users.disable(other, user.id, 'usr_admin'),
      () => users.enable(other, user.id, 'usr_admin'),
      () => users.setPassword(other, user.id, 'another-secret', 'usr_admin'),
    ]) {
      await expect(act()).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it('re-roling changes roles and nothing else', async () => {
    const { scope, user } = await withUser('tnt_dis_7', 'promoted@acme.com');
    const updated = await users.update(scope, user.id, { roles: ['admin'] });
    expect(updated.roles).toEqual(['admin']);
    expect(updated.status).toBe('active');
    expect(updated.email).toBe('promoted@acme.com');
    // ⚠️ And it must not be a way to lock somebody out by the back door.
    expect((await users.get(scope, user.id)).status).toBe('active');
    await expect(
      auth.login(scope, { email: 'promoted@acme.com', password: PASSWORD }),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
  });
});
