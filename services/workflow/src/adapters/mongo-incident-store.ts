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

/**
 * Restore the collection fields a stored document may predate.
 *
 * ### ⚠️ A schema default is a promise about *parsing*, not about every document ever written
 *
 * `Incident` declares `history`, `assignments` and `notes` as arrays with `.default([])`, so
 * anything the incident factory produces has them. A document written before a field existed — or
 * by any writer that did not go through the factory — simply has no such key, and MongoDB returns
 * it exactly as stored. Downstream code then reads `incident.notes.flatMap(...)` on `undefined`.
 *
 * Found by opening a real workspace against a real database: `buildTimeline` threw
 * `Cannot read properties of undefined (reading 'map')`, the timeline route answered **500**, and
 * the same missing field crashed the console's attachments panel hard enough to blank the whole
 * page. Every test passed, because every fixture had the fields.
 *
 * ⚠️ Normalising **at the adapter** rather than at each call site is the point: the boundary where
 * stored data becomes domain data is the one place that can make the guarantee once. Sprinkling
 * `?.` through consumers fixes the two that crashed today and none of the ones written tomorrow.
 */
function hydrate<T extends Incident | null>(row: T): T {
  if (row === null) return row;
  return {
    ...row,
    history: row.history ?? [],
    assignments: row.assignments ?? [],
    notes: row.notes ?? [],
  } as T;
}

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
    const row = (await this.incidents.collection.findOne(
      { tenantId: scope.tenantId, id } as never,
      STRIP,
    )) as Incident | null;
    return hydrate(row);
  }

  async getByDedupKey(scope: TenantScope, dedupKey: string): Promise<Incident | null> {
    const row = (await this.incidents.collection.findOne(
      { tenantId: scope.tenantId, 'source.dedupKey': dedupKey } as never,
      STRIP,
    )) as Incident | null;
    return hydrate(row);
  }

  /**
   * The incident search (P-5.0 G-3). Every filter below has a declared covering index in
   * `indexes.ts`, and `test/index-coverage.test.ts` fails if one is added here without one.
   *
   * The time window and the cursor both constrain `raisedAt` and must both survive: the window is a
   * top-level `raisedAt` range and the cursor is an `$or` on `(raisedAt, id)`, so they AND rather
   * than overwrite. Assigning `raisedAt` twice on one object would keep only the last and silently
   * page outside the requested window.
   */
  async list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage> {
    const filter: Record<string, unknown> = { tenantId: scope.tenantId };
    if (query.status !== undefined) filter['status'] = query.status;
    if (query.severity !== undefined) filter['severity'] = query.severity;
    if (query.category !== undefined) filter['category'] = query.category;
    if (query.eventType !== undefined) filter['triggeredBy.eventType'] = query.eventType;
    if (query.cameraId !== undefined) filter['triggeredBy.cameraId'] = query.cameraId;
    if (query.zoneId !== undefined) filter['triggeredBy.zoneId'] = query.zoneId;
    if (query.ruleId !== undefined) filter['source.ruleId'] = query.ruleId;
    if (query.correlationId !== undefined) filter['correlationId'] = query.correlationId;
    if (query.analysisSessionId !== undefined) {
      filter['analysisSessionId'] = query.analysisSessionId;
    } else if (!query.includeAnalyses) {
      /*
       * ⛔ **The live queue is a work list** (ADR-0047). An incident replayed out of old footage is
       * a real finding and not something anybody is dispatched to now.
       *
       * ⚠️ `$exists: false`, never `$eq: null` — the field is absent on a live incident, so matching
       * null would return nothing and empty the queue, which is the failure inverted.
       */
      filter['analysisSessionId'] = { $exists: false };
    }
    if (query.assignee !== undefined) filter['assignee'] = query.assignee;
    if (query.from !== undefined || query.to !== undefined) {
      const range: Record<string, unknown> = {};
      if (query.from !== undefined) range['$gte'] = query.from;
      if (query.to !== undefined) range['$lt'] = query.to;
      filter['raisedAt'] = range;
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      if (c) {
        filter['$or'] = [
          { raisedAt: { $lt: c.raisedAt } },
          { raisedAt: c.raisedAt, id: { $lt: c.id } },
        ];
      }
    }
    const rows = (
      (await this.incidents.collection
        .find(filter as never, STRIP)
        .sort({ raisedAt: -1, id: -1 })
        .limit(query.limit + 1)
        .toArray()) as Incident[]
    ).map((row) => hydrate(row));

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
