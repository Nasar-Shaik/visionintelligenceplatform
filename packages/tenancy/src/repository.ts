/**
 * TenantRepository — the ONLY sanctioned way a service touches a tenant-scoped MongoDB
 * collection. Every method requires a TenantScope and routes through the pure guard, so a
 * forgotten `where tenantId` is structurally impossible (docs/architecture/phase1/
 * TENANT_ARCHITECTURE.md §5–6, STORAGE_ARCHITECTURE.md). Services must not call the raw
 * driver for tenant data.
 */
import type {
  Collection,
  Document,
  Filter,
  OptionalUnlessRequiredId,
  Sort,
  UpdateFilter,
  WithId,
} from 'mongodb';
import type { TenantScope } from './scope.js';
import {
  guardUpdate,
  scopedFilter,
  scopedInsert,
  scopedPipeline,
  type PlainObject,
} from './guard.js';

/** Sorting and bounding pushed into the query, so a large collection is never loaded to be sliced. */
export interface FindManyOptions<T> {
  sort?: Partial<Record<keyof T & string, 1 | -1>>;
  limit?: number;
  skip?: number;
}

/** A tenant-scoped record: every persisted document carries its owning tenant. */
export interface TenantScoped {
  tenantId: string;
}

export class TenantRepository<T extends Document & TenantScoped> {
  constructor(readonly collection: Collection<T>) {}

  /** Insert a document, stamping (and enforcing) the scope's tenantId. */
  async insertOne(
    scope: TenantScope,
    doc: Omit<T, 'tenantId'> & Partial<TenantScoped>,
  ): Promise<T> {
    const stamped = scopedInsert(scope, doc as PlainObject);
    await this.collection.insertOne(stamped as OptionalUnlessRequiredId<T>);
    return stamped as unknown as T;
  }

  /** Find one document within the scope. */
  async findOne(scope: TenantScope, filter: Filter<T> = {}): Promise<WithId<T> | null> {
    return this.collection.findOne(scopedFilter(scope, filter as PlainObject) as Filter<T>);
  }

  /**
   * Find matching documents within the scope.
   *
   * `options` exists so callers can push sorting and bounding **into the store** rather than loading
   * a collection and slicing it in memory. An unbounded `findMany` is fine for a hundred rows and is
   * a denial of service at a hundred thousand — and the difference is invisible in a test fixture,
   * which is exactly why the bound belongs in the query rather than in the caller's discipline.
   */
  async findMany(
    scope: TenantScope,
    filter: Filter<T> = {},
    options: FindManyOptions<T> = {},
  ): Promise<WithId<T>[]> {
    let cursor = this.collection.find(scopedFilter(scope, filter as PlainObject) as Filter<T>);
    if (options.sort) cursor = cursor.sort(options.sort as Sort);
    if (options.skip !== undefined) cursor = cursor.skip(options.skip);
    if (options.limit !== undefined) cursor = cursor.limit(options.limit);
    return cursor.toArray();
  }

  /** Update one document within the scope; the update may not touch tenantId. Returns matched count. */
  async updateOne(scope: TenantScope, filter: Filter<T>, update: UpdateFilter<T>): Promise<number> {
    guardUpdate(scope, update as PlainObject);
    const res = await this.collection.updateOne(
      scopedFilter(scope, filter as PlainObject) as Filter<T>,
      update,
    );
    return res.matchedCount;
  }

  /** Delete one document within the scope. Returns deleted count. */
  async deleteOne(scope: TenantScope, filter: Filter<T> = {}): Promise<number> {
    const res = await this.collection.deleteOne(
      scopedFilter(scope, filter as PlainObject) as Filter<T>,
    );
    return res.deletedCount;
  }

  /** Count documents within the scope. */
  async count(scope: TenantScope, filter: Filter<T> = {}): Promise<number> {
    return this.collection.countDocuments(scopedFilter(scope, filter as PlainObject) as Filter<T>);
  }

  /** Run an aggregation within the scope (a leading tenant `$match` is prepended). */
  async aggregate<R extends Document = Document>(
    scope: TenantScope,
    pipeline: PlainObject[] = [],
  ): Promise<R[]> {
    return this.collection.aggregate<R>(scopedPipeline(scope, pipeline)).toArray();
  }
}
