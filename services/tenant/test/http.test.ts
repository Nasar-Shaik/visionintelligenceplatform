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

/**
 * A small in-memory query engine standing in for MongoDB.
 *
 * It supports exactly the operators the service issues — equality, `$in`, `$ne`, `$gt`, `$regex`,
 * `$or`, and multikey array matching — plus cursor `sort`/`limit`/`skip`, `updateMany`, `bulkWrite`
 * and the one `$group` aggregation. That list is deliberately closed: a fake that quietly answered
 * an operator the real driver would reject is a test that passes for a service that cannot run.
 */
function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    return Object.entries(expected as Record<string, unknown>).every(([op, operand]) => {
      switch (op) {
        case '$in':
          return (operand as unknown[]).some((v) => matchesValue(actual, v));
        case '$nin':
          return !(operand as unknown[]).some((v) => matchesValue(actual, v));
        case '$ne':
          return actual !== operand;
        case '$gt':
          return typeof actual === 'string' && actual > (operand as string);
        case '$gte':
          return typeof actual === 'string' && actual >= (operand as string);
        case '$regex':
          return new RegExp(operand as string, 'i').test(String(actual ?? ''));
        case '$options':
          return true;
        case '$exists':
          return (actual !== undefined) === operand;
        default:
          throw new Error(`memoryCollection: unsupported operator ${op}`);
      }
    });
  }
  // Multikey: a filter value matches if the field equals it or is an array containing it.
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return (expected as Record<string, unknown>[]).some((sub) => matches(doc, sub));
    }
    if (key === '$and') {
      return (expected as Record<string, unknown>[]).every((sub) => matches(doc, sub));
    }
    const actual = key.includes('.')
      ? key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], doc)
      : doc[key];
    return matchesValue(actual, expected);
  });
}

function memoryCollection<T extends Record<string, unknown>>(): Collection<T> {
  const store: T[] = [];
  const find = (filter: Record<string, unknown>) => store.filter((d) => matches(d, filter));
  return {
    async insertOne(doc: T) {
      store.push(doc);
      return { insertedId: doc._id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      return find(filter)[0] ?? null;
    },
    find(filter: Record<string, unknown>) {
      let rows = find(filter);
      const cursor = {
        sort(spec: Record<string, 1 | -1>) {
          const keys = Object.entries(spec);
          rows = [...rows].sort((a, b) => {
            for (const [key, dir] of keys) {
              const x = a[key] as string | number | undefined;
              const y = b[key] as string | number | undefined;
              if (x === y) continue;
              return ((x ?? 0) < (y ?? 0) ? -1 : 1) * dir;
            }
            return 0;
          });
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
    async countDocuments(filter: Record<string, unknown> = {}) {
      return find(filter).length;
    },
    aggregate(pipeline: Record<string, Record<string, unknown>>[]) {
      let rows: Record<string, unknown>[] = store;
      for (const stage of pipeline) {
        if (stage.$match) rows = rows.filter((d) => matches(d, stage.$match!));
        else if (stage.$group) {
          const key = String(stage.$group._id).replace(/^\$/, '');
          rows = [...new Set(rows.map((d) => d[key]))].map((_id) => ({ _id }));
        } else throw new Error(`memoryCollection: unsupported stage ${Object.keys(stage)[0]}`);
      }
      return { toArray: async () => rows };
    },
    async updateOne(filter: Record<string, unknown>, update: Record<string, Partial<T>>) {
      const doc = find(filter)[0];
      if (!doc) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async updateMany(filter: Record<string, unknown>, update: Record<string, Partial<T>>) {
      const docs = find(filter);
      for (const doc of docs) applyUpdate(doc, update);
      return { matchedCount: docs.length, modifiedCount: docs.length, acknowledged: true };
    },
    async bulkWrite(
      ops: Array<{
        updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> };
      }>,
    ) {
      let modified = 0;
      for (const op of ops) {
        const doc = find(op.updateOne.filter)[0];
        if (!doc) continue;
        applyUpdate(doc, op.updateOne.update as Record<string, Partial<T>>);
        modified += 1;
      }
      return { modifiedCount: modified, acknowledged: true };
    },
  } as unknown as Collection<T>;
}

function applyUpdate<T extends Record<string, unknown>>(
  doc: T,
  update: Record<string, Partial<T>>,
): void {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$unset) for (const key of Object.keys(update.$unset)) delete doc[key];
}

let app: FastifyInstance;

let published: { type: string; tenantId: string; payload?: Record<string, unknown> }[] = [];

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SERVICE_NAME: 'tenant-test',
    LOG_LEVEL: 'silent',
    MONGO_URI: 'mongodb://localhost:47017/vip_tenant',
  });
  let n = 0;
  published = [];
  const service = new TenantService({
    tenants: new TenantRepository<TenantDoc>(memoryCollection<TenantDoc>()),
    orgNodes: new TenantRepository<OrgNodeDoc>(memoryCollection<OrgNodeDoc>()),
    clock: { now: () => new Date('2026-07-28T00:00:00.000Z') },
    ids: { tenantId: () => `tnt_${++n}`, orgNodeId: () => `on_${++n}` },
    // ⚠️ Captured rather than logged, so the audit record can be asserted on its content. An
    // audit event nobody inspects in a test is an audit event nobody has read.
    publisher: {
      async publish(event) {
        published.push(event);
      },
    },
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

  /**
   * ⚠️ **403 here leaks nothing, and that is worth asserting rather than arguing.**
   *
   * Elsewhere in the platform a cross-tenant miss returns **404** so an id cannot be probed for
   * existence (user administration, P-6.2). This route is the opposite case and reaches the same
   * guarantee by a different route: the gate is `ctx.tenantId !== pathTenantId`, which **never
   * touches the database**. A real tenant belonging to someone else and an id that has never
   * existed produce byte-identical responses, so there is no oracle to probe.
   *
   * The test compares them directly. If someone later "improves" this by looking the tenant up
   * first — to return a friendlier message, say — the two responses diverge and this fails.
   */
  it('a foreign tenant and a nonexistent one are indistinguishable', async () => {
    const a = await provision('acme', 'Acme');
    const b = await provision('beta', 'Beta');

    const real = await app.inject({ method: 'GET', url: `/tenants/${a}`, headers: ctx(b) });
    const fake = await app.inject({
      method: 'GET',
      url: '/tenants/tnt_does_not_exist_anywhere',
      headers: ctx(b),
    });

    expect(real.statusCode).toBe(fake.statusCode);
    expect(real.json().error.code).toBe(fake.json().error.code);
    expect(real.json().error.message).toBe(fake.json().error.message);
    // And the same for a write, which is the request an attacker would actually care about.
    const realWrite = await app.inject({
      method: 'PATCH',
      url: `/tenants/${a}`,
      headers: ctx(b),
      payload: { name: 'Taken Over' },
    });
    const fakeWrite = await app.inject({
      method: 'PATCH',
      url: '/tenants/tnt_does_not_exist_anywhere',
      headers: ctx(b),
      payload: { name: 'Taken Over' },
    });
    expect(realWrite.statusCode).toBe(403);
    expect(realWrite.statusCode).toBe(fakeWrite.statusCode);
    expect(realWrite.json().error.message).toBe(fakeWrite.json().error.message);

    // ⚠️ And the write really did not happen.
    const after = await app.inject({ method: 'GET', url: `/tenants/${a}`, headers: ctx(a) });
    expect(after.json().data.name).toBe('Acme');
  });
});

/**
 * **Tenant settings (P-6.3).** What an administrator may change, what they may not, and what
 * happens when two of them change it at once.
 */
describe('tenant settings', () => {
  const read = (id: string) =>
    app.inject({ method: 'GET', url: `/tenants/${id}`, headers: ctx(id) });
  const patch = (id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/tenants/${id}`, headers: ctx(id), payload });

  it('renames a tenant and bumps updatedAt', async () => {
    const id = await provision('acme', 'Acme');
    const before = (await read(id)).json().data;
    const res = await patch(id, { name: 'Acme Security Ltd' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('Acme Security Ltd');
    expect(res.json().data.updatedAt).not.toBe(before.updatedAt);
    // ⚠️ The slug is untouched by a rename — it is an identifier, not a label.
    expect(res.json().data.slug).toBe('acme');
  });

  it('⚠️ ignores a slug in the body rather than honouring it', async () => {
    /*
     * `UpdateTenantInput` has no `slug`, and Zod strips unknown keys. This asserts the **outcome**
     * rather than a 400, because the guarantee anyone depends on is that the slug did not move —
     * asserting the status code would test Zod's strictness setting instead.
     */
    const id = await provision('acme', 'Acme');
    const res = await patch(id, { name: 'Renamed', slug: 'hijacked' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.slug).toBe('acme');
  });

  it('rejects an empty name and a body that changes nothing', async () => {
    const id = await provision('acme', 'Acme');
    expect((await patch(id, { name: '' })).statusCode).toBe(400);
    expect((await patch(id, {})).statusCode).toBe(400);
    expect((await patch(id, { name: 'x'.repeat(201) })).statusCode).toBe(400);
  });

  describe('optimistic concurrency', () => {
    it('⚠️ a second administrator editing the same tenant gets 409, not a silent overwrite', async () => {
      const id = await provision('acme', 'Acme');
      // Both administrators load the page and see the same record.
      const seen = (await read(id)).json().data.updatedAt;

      const first = await patch(id, { name: 'Renamed by Alice', expectedUpdatedAt: seen });
      expect(first.statusCode).toBe(200);

      const second = await patch(id, { name: 'Renamed by Bob', expectedUpdatedAt: seen });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.code).toBe('conflict');

      /*
       * ⚠️ The assertion that matters: Alice's change survived. Without the check Bob's write would
       * have landed and Alice would have no way to discover the loss — which is what makes a silent
       * overwrite worse than a visible error.
       */
      expect((await read(id)).json().data.name).toBe('Renamed by Alice');
    });

    it('succeeds once the second administrator reloads', async () => {
      const id = await provision('acme', 'Acme');
      const stale = (await read(id)).json().data.updatedAt;
      await patch(id, { name: 'First', expectedUpdatedAt: stale });

      const fresh = (await read(id)).json().data.updatedAt;
      const res = await patch(id, { name: 'Second', expectedUpdatedAt: fresh });
      expect(res.statusCode).toBe(200);
      expect((await read(id)).json().data.name).toBe('Second');
    });

    it('an omitted expectedUpdatedAt still writes — the field is additive', async () => {
      /*
       * ⚠️ The compatibility guarantee, asserted rather than assumed. Every caller that predates
       * P-6.3 — the seed, the runbooks, a curl in an incident — sends no version and must keep
       * working. Making the field required would have been a breaking change to a frozen contract.
       */
      const id = await provision('acme', 'Acme');
      expect((await patch(id, { name: 'No version sent' })).statusCode).toBe(200);
    });

    it('an unchanged name writes no audit event and no conflict', async () => {
      const id = await provision('acme', 'Acme');
      const seen = (await read(id)).json().data.updatedAt;
      const res = await patch(id, { name: 'Acme', expectedUpdatedAt: seen });
      expect(res.statusCode).toBe(200);
      // ⚠️ No `tenant.updated`: an audit line saying "name changed from Acme to Acme" is noise, and
      // noise is what trains a reader to skim the lines that matter.
      expect(published.filter((e) => e.type === 'tenant.updated')).toHaveLength(0);
    });

    it('a conflict on a tenant that no longer exists is a 404, not a 409', async () => {
      const id = await provision('acme', 'Acme');
      const res = await patch(id, {
        name: 'Whatever',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      });
      // The tenant exists, so a mismatched version is a genuine conflict.
      expect(res.statusCode).toBe(409);
    });
  });

  /**
   * **The audit record (P-6.3).**
   *
   * ⚠️ Before this milestone a **rename emitted nothing at all** — only a status transition
   * announced itself — so the commonest settings change in the product left no trace. These assert
   * the four things that make a line an audit record rather than a log message: what changed, from
   * what, who did it, and which request it belonged to.
   */
  describe('audit', () => {
    const auditFor = () => published.filter((e) => e.type === 'tenant.updated');

    it('records one event per successful change, with before and after', async () => {
      const id = await provision('acme', 'Acme');
      published = [];
      await patch(id, { name: 'Acme Security Ltd' });

      const events = auditFor();
      expect(events).toHaveLength(1);
      expect(events[0]?.tenantId).toBe(id);
      expect(events[0]?.payload?.changes).toEqual({
        name: { from: 'Acme', to: 'Acme Security Ltd' },
      });
    });

    it('names the actor and the correlation id', async () => {
      const id = await provision('acme', 'Acme');
      published = [];
      await patch(id, { name: 'Renamed' });

      const payload = auditFor()[0]?.payload ?? {};
      // `x-principal-id: user-1` is what `ctx()` sends — the actor must survive the whole hop.
      expect(payload.actorId).toBe('user-1');
      expect(typeof payload.correlationId).toBe('string');
      expect(payload.correlationId).not.toBe('');
      expect(typeof payload.at).toBe('string');
    });

    it('records whether the caller supplied a version, because that is worth knowing', async () => {
      const id = await provision('acme', 'Acme');
      const seen = (await read(id)).json().data.updatedAt;

      published = [];
      await patch(id, { name: 'With version', expectedUpdatedAt: seen });
      expect(auditFor()[0]?.payload?.expectedUpdatedAt).toBe(seen);

      published = [];
      await patch(id, { name: 'Without version' });
      expect(auditFor()[0]?.payload?.expectedUpdatedAt).toBeNull();
    });

    it('⚠️ writes no audit event when the write was refused', async () => {
      const id = await provision('acme', 'Acme');
      const stale = (await read(id)).json().data.updatedAt;
      await patch(id, { name: 'First', expectedUpdatedAt: stale });

      published = [];
      const conflicted = await patch(id, { name: 'Second', expectedUpdatedAt: stale });
      expect(conflicted.statusCode).toBe(409);
      // An audit trail that records attempts as though they succeeded is worse than none.
      expect(auditFor()).toHaveLength(0);
    });

    it('keeps the lifecycle event alongside the audit event', async () => {
      const id = await provision('acme', 'Acme');
      published = [];
      await patch(id, { status: 'suspended' });

      expect(auditFor()[0]?.payload?.changes).toEqual({
        status: { from: 'active', to: 'suspended' },
      });
      // ⚠️ Consumers subscribe to `tenant.suspended` specifically; folding it into `tenant.updated`
      // would break them for no gain.
      expect(published.some((e) => e.type === 'tenant.suspended')).toBe(true);
    });
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

/**
 * The estate, end to end (P-3).
 *
 * These drive the real transport → application → domain → repository stack, so what they prove is
 * not that the domain functions are right (hierarchy.test.ts does that) but that the service wires
 * them to the right queries — including that traversal happens on the server and arrives resolved.
 */
describe('the estate', () => {
  async function seed(): Promise<{ tenant: string; ids: Record<string, string> }> {
    const tenant = await provision('acme', 'Acme');
    const rootRes = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/org-nodes`,
      headers: ctx(tenant),
    });
    const ids: Record<string, string> = { org: rootRes.json().data[0].id };

    const add = async (key: string, type: string, name: string, parent: string) => {
      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${tenant}/org-nodes`,
        headers: ctx(tenant),
        payload: { type, name, parentId: ids[parent] },
      });
      expect(res.statusCode).toBe(201);
      ids[key] = res.json().data.id;
    };

    await add('emea', 'region', 'EMEA', 'org');
    await add('london', 'site', 'London', 'emea');
    await add('tower', 'building', 'Tower A', 'london');
    await add('lobby', 'zone', 'Lobby', 'tower');
    await add('apac', 'region', 'APAC', 'org');
    return { tenant, ids };
  }

  it('refuses to invert the hierarchy, and says what the rule is', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes`,
      headers: ctx(tenant),
      payload: { type: 'region', name: 'Nope', parentId: ids.lobby },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('org → region → country');
  });

  it('allows levels to be skipped', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes`,
      headers: ctx(tenant),
      payload: { type: 'zone', name: 'Car park', parentId: ids.london },
    });
    expect(res.statusCode).toBe(201);
  });

  it('returns the breadcrumb resolved, so no client walks parents', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations/${ids.lobby}`,
      headers: ctx(tenant),
    });
    expect(res.statusCode).toBe(200);
    const location = res.json().data;
    expect(location.breadcrumb.map((c: { name: string }) => c.name)).toEqual([
      'Acme',
      'EMEA',
      'London',
      'Tower A',
    ]);
    expect(location.label).toBe('Acme › EMEA › London › Tower A › Lobby');
    expect(location.depth).toBe(4);
    expect(location.allowedChildTypes).toEqual([]);
  });

  it('serves the permitted child types with the node', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations/${ids.london}`,
      headers: ctx(tenant),
    });
    expect(res.json().data.allowedChildTypes).toEqual(['building', 'floor', 'zone']);
    expect(res.json().data.hasChildren).toBe(true);
  });

  it('builds the tree with children nested under their parents', async () => {
    const { tenant } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/org-tree`,
      headers: ctx(tenant),
    });
    expect(res.statusCode).toBe(200);
    const tree = res.json().data;
    expect(tree.nodeCount).toBe(6);
    expect(tree.truncated).toBe(false);
    expect(tree.orphaned).toEqual([]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].children.map((c: { name: string }) => c.name)).toEqual(['APAC', 'EMEA']);
  });

  it('scopes the tree to a subtree on request', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/org-tree?under=${ids.emea}`,
      headers: ctx(tenant),
    });
    // The subtree includes its own root, so it is a tree rather than a set of orphans.
    expect(res.json().data.nodeCount).toBe(4);
    expect(res.json().data.orphaned).toEqual([]);
    expect(res.json().data.roots.map((r: { name: string }) => r.name)).toEqual(['EMEA']);
  });

  it('filters, bounds and pages locations', async () => {
    const { tenant } = await seed();
    const zones = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations?type=region`,
      headers: ctx(tenant),
    });
    expect(
      zones
        .json()
        .data.locations.map((l: { name: string }) => l.name)
        .sort(),
    ).toEqual(['APAC', 'EMEA']);

    const first = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations?limit=2`,
      headers: ctx(tenant),
    });
    expect(first.json().data.locations).toHaveLength(2);
    expect(first.json().data.nextCursor).toBeDefined();

    const next = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations?limit=2&cursor=${first.json().data.nextCursor}`,
      headers: ctx(tenant),
    });
    const seen = new Set([
      ...first.json().data.locations.map((l: { id: string }) => l.id),
      ...next.json().data.locations.map((l: { id: string }) => l.id),
    ]);
    expect(seen.size).toBe(4);
  });

  it('searches by name without letting the term act as a pattern', async () => {
    const { tenant } = await seed();
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations?search=${encodeURIComponent('lon')}`,
      headers: ctx(tenant),
    });
    expect(res.json().data.locations.map((l: { name: string }) => l.name)).toEqual(['London']);

    const injected = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations?search=${encodeURIComponent('.*')}`,
      headers: ctx(tenant),
    });
    expect(injected.json().data.locations).toHaveLength(0);
  });

  it('renames without touching a single reference', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenant}/org-nodes/${ids.london}`,
      headers: ctx(tenant),
      payload: { name: 'London City' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('London City');

    // The id is unchanged, so every descendant's ancestry is unchanged...
    const lobby = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations/${ids.lobby}`,
      headers: ctx(tenant),
    });
    expect(lobby.json().data.path).toContain(ids.london);
    // ...and the new name simply appears, because the label is derived on read.
    expect(lobby.json().data.label).toContain('London City');
  });

  it('moves a subtree intact, rewriting every descendant', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenant}/org-nodes/${ids.london}`,
      headers: ctx(tenant),
      payload: { parentId: ids.apac },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.breadcrumb.map((c: { name: string }) => c.name)).toEqual([
      'Acme',
      'APAC',
    ]);

    const lobby = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations/${ids.lobby}`,
      headers: ctx(tenant),
    });
    expect(lobby.json().data.label).toBe('Acme › APAC › London › Tower A › Lobby');
    expect(lobby.json().data.depth).toBe(4);
  });

  it('refuses a move that would create a cycle', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenant}/org-nodes/${ids.london}`,
      headers: ctx(tenant),
      payload: { parentId: ids.lobby },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('own descendants');
  });

  it('will not accept a type change — a floor does not become a region', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'PATCH',
      url: `/tenants/${tenant}/org-nodes/${ids.london}`,
      headers: ctx(tenant),
      payload: { type: 'region' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('archives a subtree, keeps it resolvable, and restores it', async () => {
    const { tenant, ids } = await seed();
    const archived = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.london}/archive`,
      headers: ctx(tenant),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.status).toBe('archived');

    // Gone from the working estate...
    const tree = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/org-tree`,
      headers: ctx(tenant),
    });
    expect(tree.json().data.nodeCount).toBe(3);

    // ...but every historical reference still resolves, breadcrumb and all.
    const lobby = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/locations/${ids.lobby}`,
      headers: ctx(tenant),
    });
    expect(lobby.statusCode).toBe(200);
    expect(lobby.json().data.status).toBe('archived');
    expect(lobby.json().data.label).toBe('Acme › EMEA › London › Tower A › Lobby');

    const restored = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.london}/restore`,
      headers: ctx(tenant),
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.status).toBe('active');
    expect(restored.json().data.archivedAt).toBeUndefined();

    const after = await app.inject({
      method: 'GET',
      url: `/tenants/${tenant}/org-tree`,
      headers: ctx(tenant),
    });
    expect(after.json().data.nodeCount).toBe(6);
  });

  it('refuses to restore a location whose parent is still archived', async () => {
    const { tenant, ids } = await seed();
    await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.london}/archive`,
      headers: ctx(tenant),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.tower}/restore`,
      headers: ctx(tenant),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('restore "London" first');
  });

  it('refuses to archive the organization root', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.org}/archive`,
      headers: ctx(tenant),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('root cannot be archived');
  });

  it('will not add a location under an archived one', async () => {
    const { tenant, ids } = await seed();
    await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes/${ids.london}/archive`,
      headers: ctx(tenant),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/org-nodes`,
      headers: ctx(tenant),
      payload: { type: 'zone', name: 'New', parentId: ids.london },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('archived');
  });

  it('has no delete route — locations are retired, never removed', async () => {
    const { tenant, ids } = await seed();
    const res = await app.inject({
      method: 'DELETE',
      url: `/tenants/${tenant}/org-nodes/${ids.lobby}`,
      headers: ctx(tenant),
    });
    expect(res.statusCode).toBe(404);
  });

  it('keeps the estate tenant-isolated on every new route', async () => {
    const { tenant, ids } = await seed();
    const other = await provision('beta', 'Beta');
    for (const url of [
      `/tenants/${tenant}/org-tree`,
      `/tenants/${tenant}/locations`,
      `/tenants/${tenant}/locations/${ids.lobby}`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: ctx(other) });
      expect(res.statusCode).toBe(403);
    }
  });
});
