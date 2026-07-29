/**
 * Adapter: `IncidentStore` over MongoDB, routed through the @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally. `insert` maps a duplicate-key violation on the
 * `(tenantId, source.dedupKey)` index to a 409 (the idempotent-promotion signal). `replace` is a
 * version-guarded update (optimistic concurrency). `list` is newest-first keyset pagination.
 */
import type { Collection } from 'mongodb';
import type { Incident, IncidentPage, IncidentQuery } from '@vip/contracts';
import { TenantRepository, type TenantScope } from '@vip/tenancy';
import { conflict } from '../application/errors.js';
import type { IncidentStore } from '../application/ports.js';

export interface MongoIncidentStoreDeps {
  incidents: Collection<Incident>;
}

const STRIP = { projection: { _id: 0 } } as const;
const DUPLICATE_KEY = 11000;

function encodeCursor(incident: Incident): string {
  return Buffer.from(`${incident.raisedAt}|${incident.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { raisedAt: string; id: string } | null {
  try {
    const [raisedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return raisedAt && id ? { raisedAt, id } : null;
  } catch {
    return null;
  }
}

export class MongoIncidentStore implements IncidentStore {
  private readonly incidents: TenantRepository<Incident>;

  constructor(deps: MongoIncidentStoreDeps) {
    this.incidents = new TenantRepository<Incident>(deps.incidents);
  }

  async insert(scope: TenantScope, incident: Incident): Promise<void> {
    try {
      await this.incidents.insertOne(scope, incident as Omit<Incident, 'tenantId'>);
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: number }).code === DUPLICATE_KEY
      ) {
        throw conflict(`incident already exists for this candidate`);
      }
      throw err;
    }
  }

  async get(scope: TenantScope, id: string): Promise<Incident | null> {
    return this.incidents.collection.findOne(
      { tenantId: scope.tenantId, id } as never,
      STRIP,
    ) as Promise<Incident | null>;
  }

  async getByDedupKey(scope: TenantScope, dedupKey: string): Promise<Incident | null> {
    return this.incidents.collection.findOne(
      { tenantId: scope.tenantId, 'source.dedupKey': dedupKey } as never,
      STRIP,
    ) as Promise<Incident | null>;
  }

  async list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage> {
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    if (query.status !== undefined) filter['status'] = query.status;
    if (query.severity !== undefined) filter['severity'] = query.severity;
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        filter['$or'] = [
          { raisedAt: { $lt: c.raisedAt } },
          { raisedAt: c.raisedAt, id: { $lt: c.id } },
        ];
      }
    }
    const rows = (await this.incidents.collection
      .find(filter as never, STRIP)
      .sort({ raisedAt: -1, id: -1 })
      .limit(query.limit + 1)
      .toArray()) as Incident[];

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    return hasMore && items.length > 0
      ? { items, nextCursor: encodeCursor(items[items.length - 1]!) }
      : { items };
  }

  async replace(scope: TenantScope, incident: Incident, expectedVersion: number): Promise<boolean> {
    const matched = await this.incidents.updateOne(
      scope,
      { id: incident.id, version: expectedVersion } as never,
      { $set: incident } as never,
    );
    return matched > 0;
  }
}
