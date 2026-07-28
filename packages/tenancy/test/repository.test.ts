import { beforeEach, describe, expect, it } from 'vitest';
import type { Collection } from 'mongodb';
import { TenancyError } from '../src/errors.js';
import { TenantScope } from '../src/scope.js';
import { TenantRepository, type TenantScoped } from '../src/repository.js';

/**
 * Minimal in-memory collection implementing the subset of the MongoDB driver the repository
 * uses, with equality-only filter matching. Lets us prove the guard's behaviour deterministically
 * without a live database; the Testcontainers integration test exercises the real driver.
 */
interface Doc extends TenantScoped {
  _id: string;
  name: string;
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => doc[k] === v);
}

function fakeCollection(seed: Doc[] = []) {
  let store = [...seed];
  const col = {
    async insertOne(doc: Doc) {
      store.push(doc);
      return { insertedId: doc._id, acknowledged: true };
    },
    async findOne(filter: Record<string, unknown>) {
      return store.find((d) => matches(d, filter)) ?? null;
    },
    find(filter: Record<string, unknown>) {
      return { toArray: async () => store.filter((d) => matches(d, filter)) };
    },
    async updateOne(filter: Record<string, unknown>, update: { $set?: Partial<Doc> }) {
      const doc = store.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0, acknowledged: true };
      Object.assign(doc, update.$set ?? {});
      return { matchedCount: 1, modifiedCount: 1, acknowledged: true };
    },
    async deleteOne(filter: Record<string, unknown>) {
      const i = store.findIndex((d) => matches(d, filter));
      if (i < 0) return { deletedCount: 0, acknowledged: true };
      store.splice(i, 1);
      return { deletedCount: 1, acknowledged: true };
    },
    async countDocuments(filter: Record<string, unknown>) {
      return store.filter((d) => matches(d, filter)).length;
    },
    aggregate(pipeline: Array<{ $match?: Record<string, unknown> }>) {
      const match = pipeline[0]?.$match ?? {};
      return { toArray: async () => store.filter((d) => matches(d, match)) };
    },
    _dump: () => store,
  };
  return col as unknown as Collection<Doc> & { _dump(): Doc[] };
}

const A = TenantScope.fromTenantId('tenant-a');
const B = TenantScope.fromTenantId('tenant-b');

describe('TenantRepository isolation', () => {
  let col: ReturnType<typeof fakeCollection>;
  let repo: TenantRepository<Doc>;

  beforeEach(() => {
    col = fakeCollection([
      { _id: 'a1', tenantId: 'tenant-a', name: 'alpha' },
      { _id: 'b1', tenantId: 'tenant-b', name: 'bravo' },
    ]);
    repo = new TenantRepository<Doc>(col);
  });

  it('findMany returns only the scoped tenant’s records', async () => {
    expect(await repo.findMany(A, {})).toHaveLength(1);
    expect((await repo.findMany(A, {}))[0]?.name).toBe('alpha');
    expect((await repo.findMany(B, {}))[0]?.name).toBe('bravo');
  });

  it('findOne cannot reach another tenant’s record by its id', async () => {
    expect(await repo.findOne(A, { _id: 'b1' } as never)).toBeNull();
    expect((await repo.findOne(A, { _id: 'a1' } as never))?.name).toBe('alpha');
  });

  it('count is scoped', async () => {
    expect(await repo.count(A)).toBe(1);
    expect(await repo.count(B)).toBe(1);
  });

  it('insertOne stamps the scope’s tenantId', async () => {
    await repo.insertOne(A, { _id: 'a2', name: 'gamma' });
    const found = await repo.findOne(A, { _id: 'a2' } as never);
    expect(found?.tenantId).toBe('tenant-a');
    // B cannot see it
    expect(await repo.findOne(B, { _id: 'a2' } as never)).toBeNull();
  });

  it('insertOne refuses a foreign tenantId (fail-closed)', async () => {
    await expect(repo.insertOne(A, { _id: 'x', name: 'n', tenantId: 'tenant-b' })).rejects.toThrow(
      TenancyError,
    );
  });

  it('updateOne cannot modify another tenant’s record', async () => {
    expect(await repo.updateOne(A, { _id: 'b1' } as never, { $set: { name: 'hacked' } })).toBe(0);
    expect(col._dump().find((d) => d._id === 'b1')?.name).toBe('bravo');
  });

  it('updateOne refuses reassigning tenantId (fail-closed)', async () => {
    await expect(
      repo.updateOne(A, { _id: 'a1' } as never, { $set: { tenantId: 'tenant-b' } as never }),
    ).rejects.toThrow(TenancyError);
  });

  it('deleteOne cannot delete another tenant’s record', async () => {
    expect(await repo.deleteOne(A, { _id: 'b1' } as never)).toBe(0);
    expect(await repo.deleteOne(A, { _id: 'a1' } as never)).toBe(1);
  });

  it('a query explicitly targeting another tenant throws (fail-closed)', async () => {
    await expect(repo.findMany(A, { tenantId: 'tenant-b' } as never)).rejects.toThrow(TenancyError);
  });

  it('aggregate is scoped by a leading tenant $match', async () => {
    expect(await repo.aggregate(A, [])).toHaveLength(1);
    expect((await repo.aggregate<Doc>(A, []))[0]?.name).toBe('alpha');
  });
});
