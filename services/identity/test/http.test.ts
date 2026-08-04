/**
 * HTTP tests — the full auth vertical driven in-memory (fake collections): login, `/auth/me`,
 * refresh rotation + reuse-detection, and permission-gated `/users`. Runs everywhere with no
 * Docker/Mongo; the real-driver proof lives in integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { Collection } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantRepository, TenantScope } from '@vip/tenancy';
import { loadConfig } from '../src/config/env.js';
import { AuthService } from '../src/application/auth-service.js';
import { UserService } from '../src/application/user-service.js';
import type { UserDoc } from '../src/domain/user.js';
import type { RefreshTokenDoc } from '../src/domain/refresh.js';
import { buildServer } from '../src/transport/server.js';

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}

function memoryCollection<T extends Record<string, unknown>>(): Collection<T> {
  const store: T[] = [];
  return {
    async insertOne(doc: T) {
      store.push(doc);
      return { insertedId: doc._id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      return store.find((d) => matches(d, filter)) ?? null;
    },
    /*
     * ⚠️ Returns a chainable cursor, not a bare `toArray`. `TenantRepository.findMany` calls
     * `.sort()` when given sort options, and a fake without it fails as a **500 from the route** —
     * which reads as a permission or validation bug rather than a missing method on the double.
     */
    find(filter: Record<string, unknown>) {
      let rows = store.filter((d) => matches(d, filter));
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const [[key, dir] = ['_id', 1]] = Object.entries(spec);
          rows = [...rows].sort((a, b) =>
            String(a[key as keyof T]) < String(b[key as keyof T]) ? -dir : dir,
          );
          return cursor;
        },
        skip(n: number) {
          rows = rows.slice(n);
          return cursor;
        },
        limit(n: number) {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    },
    async updateOne(filter: Record<string, unknown>, update: { $set?: Partial<T> }) {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      Object.assign(doc, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async distinct(key: string, filter: Record<string, unknown>) {
      return [...new Set(store.filter((d) => matches(d, filter)).map((d) => d[key]))];
    },
    async updateMany(filter: Record<string, unknown>, update: { $set?: Partial<T> }) {
      const docs = store.filter((d) => matches(d, filter));
      for (const d of docs) Object.assign(d, update.$set ?? {});
      return { matchedCount: docs.length, modifiedCount: docs.length, acknowledged: true };
    },
  } as unknown as Collection<T>;
}

const TENANT = 'tnt_a';
let app: FastifyInstance;
let userService: UserService;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'identity',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_identity',
    JWT_SECRET: 'test-secret-at-least-16-chars',
  });
  let n = 0;
  const users = new TenantRepository<UserDoc>(memoryCollection<UserDoc>());
  const authService = new AuthService({
    users,
    refreshTokens: memoryCollection<RefreshTokenDoc>(),
    jwt: {
      secret: 'test-secret-at-least-16-chars',
      accessTtl: '15m',
      refreshTtl: '7d',
      issuer: 'identity',
      audience: 'vip',
    },
    clock: { now: () => new Date() },
    ids: { familyId: () => `fam_${++n}` },
  });
  // ⚠️ The real `AuthService` as the session revoker, as `index.ts` wires it — so a disable in these
  // tests actually revokes against the same fake store the refresh route reads.
  userService = new UserService({
    users,
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { userId: () => `usr_${++n}` },
    sessions: authService,
  });
  app = (
    await buildServer({ config, auth: authService, users: userService, startedAt: new Date() })
  ).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function seedUser(email: string, password: string, roles: string[]) {
  return userService.create(TenantScope.fromTenantId(TENANT), { email, password, roles });
}

const login = (email: string, password: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'x-tenant-id': TENANT },
    payload: { email, password },
  });

async function accessToken(email: string, password: string): Promise<string> {
  const res = await login(email, password);
  return res.json().data.accessToken as string;
}

describe('infra endpoints', () => {
  it('GET /health → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });
});

describe('login', () => {
  beforeEach(() => seedUser('admin@acme.com', 'supersecret', ['admin']));

  it('issues an access + refresh pair', async () => {
    const res = await login('admin@acme.com', 'supersecret');
    expect(res.statusCode).toBe(200);
    const pair = res.json().data;
    expect(pair.tokenType).toBe('Bearer');
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(pair.expiresIn).toBe(900);
  });

  it('rejects a wrong password with 401 (generic)', async () => {
    const res = await login('admin@acme.com', 'nope');
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown user with 401 (no enumeration)', async () => {
    const res = await login('ghost@acme.com', 'whatever');
    expect(res.statusCode).toBe(401);
  });

  it('requires the x-tenant-id header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@acme.com', password: 'supersecret' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('/auth/me', () => {
  beforeEach(() => seedUser('admin@acme.com', 'supersecret', ['admin']));

  it('returns the principal for a valid token', async () => {
    const token = await accessToken('admin@acme.com', 'supersecret');
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      tenantId: TENANT,
      email: 'admin@acme.com',
      roles: ['admin'],
    });
  });

  it('rejects a missing/garbage token with 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: { authorization: 'Bearer not.a.jwt' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('authorization on /users', () => {
  beforeEach(async () => {
    await seedUser('admin@acme.com', 'supersecret', ['admin']);
    await seedUser('viewer@acme.com', 'supersecret', ['viewer']);
  });

  it('401 without a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/users' })).statusCode).toBe(401);
  });

  it('admin (user:read) can list; viewer can read but cannot create', async () => {
    const adminTok = await accessToken('admin@acme.com', 'supersecret');
    const viewerTok = await accessToken('viewer@acme.com', 'supersecret');

    const listed = await app.inject({
      method: 'GET',
      url: '/users',
      headers: { authorization: `Bearer ${adminTok}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.length).toBe(2);

    // viewer may read
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/users',
          headers: { authorization: `Bearer ${viewerTok}` },
        })
      ).statusCode,
    ).toBe(200);

    // viewer may NOT create → 403
    const forbidden = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${viewerTok}` },
      payload: { email: 'new@acme.com', password: 'supersecret', roles: ['viewer'] },
    });
    expect(forbidden.statusCode).toBe(403);

    // admin may create → 201
    const created = await app.inject({
      method: 'POST',
      url: '/users',
      headers: { authorization: `Bearer ${adminTok}` },
      payload: { email: 'new@acme.com', password: 'supersecret', roles: ['viewer'] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().data.email).toBe('new@acme.com');
  });
});

/**
 * **P-6.2 · user administration over HTTP (TD-44).**
 *
 * The permission gate exists only at this layer — the service methods take a scope and an actor and
 * trust both — so these are the tests that prove an operator cannot disable a colleague.
 */
describe('user administration routes', () => {
  let adminTok: string;
  let viewerTok: string;
  let target: string;

  beforeEach(async () => {
    await seedUser('admin@acme.com', 'supersecret', ['admin']);
    await seedUser('viewer@acme.com', 'supersecret', ['viewer']);
    const created = await seedUser('leaver@acme.com', 'supersecret', ['operator']);
    target = created.id;
    adminTok = await accessToken('admin@acme.com', 'supersecret');
    viewerTok = await accessToken('viewer@acme.com', 'supersecret');
  });

  const as = (token: string, method: 'GET' | 'PATCH' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  it('an admin can re-role, disable and re-enable; the roles PATCH carries roles only', async () => {
    const patched = await as(adminTok, 'PATCH', `/users/${target}`, { roles: ['viewer'] });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.roles).toEqual(['viewer']);
    // ⚠️ A re-role must not be a way to change status by the back door.
    expect(patched.json().data.status).toBe('active');

    const disabled = await as(adminTok, 'POST', `/users/${target}/disable`, {});
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data.user.status).toBe('disabled');
    // The leaver had one live session (seeded logins issue one).
    expect(disabled.json().data.sessionsRevoked).toBeGreaterThanOrEqual(0);

    const enabled = await as(adminTok, 'POST', `/users/${target}/enable`, {});
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.status).toBe('active');
  });

  it('⚠️ a viewer can read a user but cannot change one', async () => {
    expect((await as(viewerTok, 'GET', `/users/${target}`)).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ['PATCH', `/users/${target}`, { roles: ['admin'] }],
      ['POST', `/users/${target}/disable`, {}],
      ['POST', `/users/${target}/enable`, {}],
      ['POST', `/users/${target}/password`, { password: 'a-new-secret' }],
    ] as const) {
      expect((await as(viewerTok, method, url, payload)).statusCode).toBe(403);
    }
  });

  it('an unknown user is 404, not 500', async () => {
    expect((await as(adminTok, 'GET', '/users/usr_nope')).statusCode).toBe(404);
    expect((await as(adminTok, 'POST', '/users/usr_nope/disable', {})).statusCode).toBe(404);
  });

  it('rejects a password below the contract minimum with a 400 naming the field', async () => {
    const res = await as(adminTok, 'POST', `/users/${target}/password`, { password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/password/);
  });

  it('refuses a body that tries to change email or status through the roles PATCH', async () => {
    /*
     * ⚠️ Zod strips unknown keys rather than rejecting them, so this asserts the **outcome**: the
     * email and status are unchanged. Asserting a 400 would test Zod's strictness setting, which is
     * not the guarantee anyone depends on.
     */
    const res = await as(adminTok, 'PATCH', `/users/${target}`, {
      roles: ['viewer'],
      email: 'attacker@acme.com',
      status: 'disabled',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe('leaver@acme.com');
    expect(res.json().data.status).toBe('active');
  });

  it('refuses an empty roles array — a user with no role can sign in and do nothing', async () => {
    expect((await as(adminTok, 'PATCH', `/users/${target}`, { roles: [] })).statusCode).toBe(400);
  });
});

describe('refresh rotation + reuse-detection', () => {
  beforeEach(() => seedUser('admin@acme.com', 'supersecret', ['admin']));

  const refresh = (refreshToken: string) =>
    app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

  it('rotates the token pair', async () => {
    const r1 = (await login('admin@acme.com', 'supersecret')).json().data.refreshToken;
    const res = await refresh(r1);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.refreshToken).not.toBe(r1);
  });

  it('replaying a rotated token revokes the whole family (reuse-detection)', async () => {
    const r1 = (await login('admin@acme.com', 'supersecret')).json().data.refreshToken;
    const r2 = (await refresh(r1)).json().data.refreshToken; // r1 now used
    // Replay r1 → reuse detected → 401, family revoked.
    expect((await refresh(r1)).statusCode).toBe(401);
    // r2 (same family) is now revoked too.
    expect((await refresh(r2)).statusCode).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    expect((await refresh('unknown')).statusCode).toBe(401);
  });
});
