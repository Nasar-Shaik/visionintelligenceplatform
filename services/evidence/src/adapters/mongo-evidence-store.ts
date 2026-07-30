/**
 * Adapter: `EvidenceStore` over MongoDB, routed through @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally (Law 5). Insert is idempotent on `_id` (the stable evidence
 * id). Listings use keyset pagination — newest-first by `(capturedAt, _id)` (ISO timestamps order as
 * strings). Mirrors the media/events stores.
 */
import type { Collection } from 'mongodb';
import type { EvidenceQuery } from '@vip/contracts';
import { TenantRepository, type PlainObject, type TenantScope } from '@vip/tenancy';
import type { EvidenceDoc } from '../domain/evidence.js';
import type { EvidenceStore } from '../application/ports.js';
import { decodeCursor, encodeCursor } from './evidence-cursor.js';

export class MongoEvidenceStore implements EvidenceStore {
  readonly #repo: TenantRepository<EvidenceDoc>;
  readonly #col: Collection<EvidenceDoc>;

  constructor(col: Collection<EvidenceDoc>) {
    this.#repo = new TenantRepository<EvidenceDoc>(col);
    this.#col = col;
  }

  async insert(scope: TenantScope, doc: EvidenceDoc): Promise<boolean> {
    const existing = await this.#repo.findOne(scope, { _id: doc._id } as PlainObject);
    if (existing) return false;
    try {
      await this.#repo.insertOne(scope, doc as Omit<EvidenceDoc, 'tenantId'>);
      return true;
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) return false; // raced insert
      throw err;
    }
  }

  async get(scope: TenantScope, id: string): Promise<EvidenceDoc | null> {
    return this.#repo.findOne(scope, { _id: id } as PlainObject);
  }

  async list(
    scope: TenantScope,
    q: EvidenceQuery,
  ): Promise<{ items: EvidenceDoc[]; nextCursor?: string }> {
    const match: PlainObject = {};
    if (q.kind) match['kind'] = q.kind;
    if (q.status) match['status'] = q.status;
    if (q.cameraId) match['source.cameraId'] = q.cameraId;
    if (q.incidentId) match['source.incidentId'] = q.incidentId;
    if (q.eventId) match['source.eventId'] = q.eventId;
    if (q.correlationId) match['source.correlationId'] = q.correlationId;
    if (q.from || q.to) {
      const range: PlainObject = {};
      if (q.from) range['$gte'] = q.from;
      if (q.to) range['$lt'] = q.to;
      match['capturedAt'] = range;
    }
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cur) {
      match['$or'] = [
        { capturedAt: { $lt: cur.sortKey } },
        { capturedAt: cur.sortKey, _id: { $lt: cur.id } },
      ];
    }
    const rows = await this.#repo.aggregate<EvidenceDoc>(scope, [
      { $match: match },
      { $sort: { capturedAt: -1, _id: -1 } },
      { $limit: q.limit + 1 },
    ]);
    if (rows.length <= q.limit) return { items: rows };
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeCursor({ sortKey: last.capturedAt, id: last._id }) };
  }

  async patch(scope: TenantScope, id: string, fields: Partial<EvidenceDoc>): Promise<boolean> {
    const n = await this.#repo.updateOne(scope, { _id: id } as PlainObject, {
      $set: fields as PlainObject,
    });
    return n > 0;
  }

  /** Tenant-leading indexes: unique id + keyset sort support + common filters. */
  async ensureIndexes(): Promise<void> {
    await this.#col.createIndex(
      { tenantId: 1, capturedAt: -1, _id: -1 },
      { name: 'tenant_captured' },
    );
    await this.#col.createIndex(
      { tenantId: 1, 'source.incidentId': 1, capturedAt: -1 },
      { name: 'tenant_incident' },
    );
    await this.#col.createIndex(
      { tenantId: 1, kind: 1, status: 1, capturedAt: -1 },
      { name: 'tenant_kind_status' },
    );
  }
}
