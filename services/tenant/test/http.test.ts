/**
 * HTTP tests — the full transport → application → domain → @vip/tenancy stack driven in-memory
 * (fake collections), so they run everywhere with no Docker/Mongo. The real-driver isolation
 * proof lives in integration.test.ts. Focus: infra endpoints, tenant/org flows, envelopes, and
 * the cross-tenant isolation gate (P1-1 acceptance).
 */
import type { FastifyInstance } from 'fastify';
import type { Collection } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantRepository } from '@vip/tenancy';
import { loadConfig } from '../src/config/env.js';
import { TenantService } from '../src/application/tenant-service.js';
import type { OrgNodeDoc, TenantDoc } from '../src/domain/tenant.js';
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
    find(filter: Record<string, unknown>) {
      return { toArray: async () => store.filter((d) => matches(d, filter)) };
    },
    async updateOne(filter: Record<string, unknown>, update: { $set?: Partial<T> }) {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      Object.assign(doc, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
  } as unknown as Collection<T>;
}

let app: FastifyInstance;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'tenant-test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_tenant',
  });
  let n = 0;
  const service = new TenantService({
    tenants: new TenantRepository<TenantDoc>(memoryCollection<TenantDoc>()),
    orgNodes: new TenantRepository<OrgNodeDoc>(memoryCollection<OrgNodeDoc>()),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { tenantId: () => `tnt_${++n}`, orgNodeId: () => `on_${++n}` },
  });
  app = (await buildServer({ config, service, startedAt: new Date() })).app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const ctx = (tenantId: string) => ({ 'x-tenant-id': tenantId, 'x-principal-id': 'user-1' });

async function provision(slug: string, name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/tenants', payload: { slug, name } });
  expect(res.statusCode).toBe(201);
  return res.json().data.tenant.id as string;
}

describe('infra endpoints', () => {
  it('GET /health → 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });

  it('GET /ready → 200 pass with no dependencies registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pass');
  });
});

describe('provisioning', () => {
  it('creates an active tenant + org root', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tenants',
      payload: { slug: 'acme', name: 'Acme' },
    });
    expect(res.statusCode).toBe(201);
    const { tenant, orgRoot } = res.json().data;
    expect(tenant).toMatchObject({ slug: 'acme', name: 'Acme', status: 'active' });
    expect(orgRoot).toMatchObject({ type: 'org', parentId: null, tenantId: tenant.id });
  });

  it('rejects an invalid slug with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/tenants',
      payload: { slug: 'A', name: 'Bad' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'bad_request' } });
  });
});

describe('tenant reads + isolation gate', () => {
  it('a tenant can read itself', async () => {
    const a = await provision('acme', 'Acme');
    const res = await app.inject({ method: 'GET', url: `/tenants/${a}`, headers: ctx(a) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(a);
  });

  it('requires a tenant context (401 without headers)', async () => {
    const a = await provision('acme', 'Acme');
    const res = await app.inject({ method: 'GET', url: `/tenants/${a}` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses cross-tenant access (403) — fail-closed', async () => {
    const a = await provision('acme', 'Acme');
    const b = await provision('beta', 'Beta');
    const res = await app.inject({ method: 'GET', url: `/tenants/${a}`, headers: ctx(b) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'forbidden' } });
  });
});

describe('org hierarchy is tenant-isolated', () => {
  it('nodes never cross tenants', async () => {
    const a = await provision('acme', 'Acme');
    const b = await provision('beta', 'Beta');

    // Add a site under A.
    const created = await app.inject({
      method: 'POST',
      url: `/tenants/${a}/org-nodes`,
      headers: ctx(a),
      payload: { type: 'site', name: 'HQ', parentId: null },
    });
    // 'site' requires a parent → 400 (validates hierarchy rules).
    expect(created.statusCode).toBe(400);

    // Correct: find A's org root, then add a site under it.
    const rootList = await app.inject({
      method: 'GET',
      url: `/tenants/${a}/org-nodes`,
      headers: ctx(a),
    });
    const rootId = rootList.json().data[0].id as string;
    const ok = await app.inject({
      method: 'POST',
      url: `/tenants/${a}/org-nodes`,
      headers: ctx(a),
      payload: { type: 'site', name: 'HQ', parentId: rootId },
    });
    expect(ok.statusCode).toBe(201);

    // A sees root + site (2); B sees only its own root (1).
    const aNodes = await app.inject({
      method: 'GET',
      url: `/tenants/${a}/org-nodes`,
      headers: ctx(a),
    });
    const bNodes = await app.inject({
      method: 'GET',
      url: `/tenants/${b}/org-nodes`,
      headers: ctx(b),
    });
    expect(aNodes.json().data).toHaveLength(2);
    expect(bNodes.json().data).toHaveLength(1);

    // B cannot list A's nodes (403).
    const cross = await app.inject({
      method: 'GET',
      url: `/tenants/${a}/org-nodes`,
      headers: ctx(b),
    });
    expect(cross.statusCode).toBe(403);
  });
});
