/**
 * Adapter: `EventStore` over MongoDB, routed through the @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally (a missing tenant is refused, not silently global).
 * `persist` is idempotent: a duplicate dedup key surfaces as a Mongo 11000 and is reported as "not
 * newly stored" rather than an error. Reads use the guard's `aggregate` (which prepends the tenant
 * `$match`) with keyset pagination by `(occurredAt, id)` — envelopes carry UTC ISO timestamps, which
 * order correctly as strings.
 */
import type { Collection } from 'mongodb';
import type { EventEnvelope, EventQuery, EventReplayRequest } from '@vip/contracts';
import { TenantRepository, type TenantScope, type PlainObject } from '@vip/tenancy';
import type { EventDoc } from './mongo.js';
import type { EventStore } from '../application/ports.js';

interface Cursor {
  occurredAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.occurredAt}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | undefined {
  try {
    const [occurredAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    return occurredAt && id ? { occurredAt, id } : undefined;
  } catch {
    return undefined;
  }
}

const PROJECT_ENVELOPE: PlainObject = { $project: { _id: 0, dedupKey: 0 } };

export class MongoEventStore implements EventStore {
  private readonly repo: TenantRepository<EventDoc>;

  constructor(collection: Collection<EventDoc>) {
    this.repo = new TenantRepository<EventDoc>(collection);
  }

  async persist(scope: TenantScope, envelope: EventEnvelope, key: string): Promise<boolean> {
    try {
      await this.repo.insertOne(scope, { ...envelope, dedupKey: key } as Omit<
        EventDoc,
        'tenantId'
      >);
      return true;
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
        return false; // duplicate dedup key — already persisted (idempotent)
      }
      throw err;
    }
  }

  /**
   * One envelope by id, tenant-scoped (P-5.0 G-5). Served by `tenant_event_id` — before that index
   * existed this would have been a collection scan, which is why the index landed in the same slice
   * as the route rather than after someone noticed.
   */
  async getById(scope: TenantScope, id: string): Promise<EventEnvelope | null> {
    const rows = await this.repo.aggregate<EventEnvelope>(scope, [
      { $match: { id } },
      { $limit: 1 },
      PROJECT_ENVELOPE,
    ]);
    return rows[0] ?? null;
  }

  async query(
    scope: TenantScope,
    q: EventQuery,
  ): Promise<{ events: EventEnvelope[]; nextCursor?: string }> {
    const match: PlainObject = {};
    if (q.type) match['type'] = q.type;
    if (q.cameraId) match['cameraId'] = q.cameraId;
    if (q.zoneId) match['zoneId'] = q.zoneId;
    if (q.correlationId) match['correlationId'] = q.correlationId;
    if (q.from || q.to) {
      const range: PlainObject = {};
      if (q.from) range['$gte'] = q.from;
      if (q.to) range['$lt'] = q.to;
      match['occurredAt'] = range;
    }
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cursor) {
      match['$or'] = [
        { occurredAt: { $lt: cursor.occurredAt } },
        { occurredAt: cursor.occurredAt, id: { $lt: cursor.id } },
      ];
    }

    const rows = await this.repo.aggregate<EventEnvelope>(scope, [
      { $match: match },
      { $sort: { occurredAt: -1, id: -1 } },
      { $limit: q.limit + 1 },
      PROJECT_ENVELOPE,
    ]);

    if (rows.length > q.limit) {
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1]!;
      return {
        events: page,
        nextCursor: encodeCursor({ occurredAt: last.occurredAt, id: last.id }),
      };
    }
    return { events: rows };
  }

  async range(scope: TenantScope, req: EventReplayRequest): Promise<EventEnvelope[]> {
    const match: PlainObject = { occurredAt: { $gte: req.from, $lt: req.to } };
    if (req.type) match['type'] = req.type;
    if (req.cameraId) match['cameraId'] = req.cameraId;
    return this.repo.aggregate<EventEnvelope>(scope, [
      { $match: match },
      { $sort: { occurredAt: 1, id: 1 } },
      { $limit: req.limit },
      PROJECT_ENVELOPE,
    ]);
  }
}
