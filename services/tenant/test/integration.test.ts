/**
 * Integration test — the cross-tenant isolation guarantee against a REAL MongoDB (not a fake),
 * exercising the @vip/tenancy repositories end-to-end. Uses the dev-stack Mongo via MONGO_URI
 * (default the compose port 47017). It SKIPS gracefully when no Mongo is reachable, so the
 * default `pnpm test` stays green everywhere; run the dev stack (`pnpm dev:stack`) to execute it.
 * This is the baseline of the standing cross-tenant isolation suite (grows every P1 slice).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenancyError, TenantRepository, TenantScope } from '@vip/tenancy';
import { connectMongo, type MongoAdapter } from '../src/adapters/mongo.js';
import { TenantService } from '../src/application/tenant-service.js';

const URI = process.env.MONGO_URI ?? 'mongodb://localhost:47017/vip_tenant_test';
const DB = `vip_tenant_it_${Date.now()}`;

let mongo: MongoAdapter | undefined;
let service: TenantService;

async function reachable(): Promise<boolean> {
  try {
    mongo = await connectMongo({ uri: URI, dbName: DB, serverSelectionTimeoutMS: 1200 });
    return true;
  } catch {
    return false;
  }
}

const online = await reachable();

describe.skipIf(!online)('tenant isolation against real MongoDB', () => {
  beforeAll(() => {
    const m = mongo!;
    let n = 0;
    service = new TenantService({
      tenants: new TenantRepository(m.tenants),
      orgNodes: new TenantRepository(m.orgNodes),
      clock: { now: () => new Date() },
      ids: { tenantId: () => `tnt_it_${++n}`, orgNodeId: () => `on_it_${++n}` },
    });
  });

  afterAll(async () => {
    if (mongo) {
      await mongo.db.dropDatabase();
      await mongo.close();
    }
  });

  it('provisions two tenants and keeps their org nodes fully isolated', async () => {
    const a = await service.provision({ slug: 'acme-it', name: 'Acme' });
    const b = await service.provision({ slug: 'beta-it', name: 'Beta' });

    const scopeA = TenantScope.fromTenantId(a.tenant.id);
    const scopeB = TenantScope.fromTenantId(b.tenant.id);

    await service.createOrgNode(scopeA, { type: 'site', name: 'HQ-A', parentId: a.orgRoot.id });

    // A sees root + site; B sees only its own root.
    expect(await service.listOrgNodes(scopeA)).toHaveLength(2);
    expect(await service.listOrgNodes(scopeB)).toHaveLength(1);

    // A cannot use B's node id as a parent (it is invisible across the boundary).
    await expect(
      service.createOrgNode(scopeA, { type: 'floor', name: 'x', parentId: b.orgRoot.id }),
    ).rejects.toThrow(/parent node .* not found/);
  });

  it('a raw scoped query cannot reach another tenant', async () => {
    const a = await service.provision({ slug: 'gamma-it', name: 'Gamma' });
    const scopeA = TenantScope.fromTenantId(a.tenant.id);
    const orgNodes = new TenantRepository(mongo!.orgNodes);

    // Every doc carries tenantId; a scoped find only ever returns the scope's rows.
    const all = await orgNodes.findMany(scopeA, {});
    expect(all.every((d) => d.tenantId === a.tenant.id)).toBe(true);

    // A filter that explicitly targets another tenant is refused (fail-closed).
    await expect(orgNodes.findMany(scopeA, { tenantId: 'tnt_other' } as never)).rejects.toThrow(
      TenancyError,
    );
  });

  it('the slug unique index rejects a duplicate tenant', async () => {
    await service.provision({ slug: 'dupe-it', name: 'One' });
    await expect(service.provision({ slug: 'dupe-it', name: 'Two' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
