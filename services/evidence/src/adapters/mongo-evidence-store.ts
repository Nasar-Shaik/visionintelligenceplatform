/**
 * Adapter: `EvidenceStore` over MongoDB, routed through @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally (Law 5). Insert is idempotent on `_id` (the stable evidence
 * id). Listings use keyset pagination — newest-first by `(capturedAt, _id)` (ISO timestamps order as
 * strings). Mirrors the media/events stores.
 */
import type { Collection, IndexSpecification } from 'mongodb';
import type { EvidenceQuery } from '@vip/contracts';
import { TenantRepository, type PlainObject, type TenantScope } from '@vip/tenancy';
import type { EvidenceDoc } from '../domain/evidence.js';
import type { EvidenceStore } from '../application/ports.js';
import { decodeCursor, encodeCursor } from './evidence-cursor.js';
import { EVIDENCE_INDEXES } from './indexes.js';

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

  /**
   * Create every index declared in `indexes.ts`, reconciling names whose key set changed (TD-25).
   *
   * ⚠️ **Three pre-existing indexes gained the `_id` cursor key**, and `tenant_captured` already
   * had it. Re-declaring an existing name with different keys is an `IndexOptionsConflict` —
   * MongoDB refuses and the service fails to start — so a changed key set is dropped and rebuilt.
   * Each old index is a strict prefix of its replacement, so nothing loses coverage during the
   * rebuild; the rebuild itself is real work on a large collection, which is why this is deliberate
   * rather than incidental.
   */
  async ensureIndexes(): Promise<void> {
    const existing = await this.#col.indexes().catch(() => []);
    for (const spec of EVIDENCE_INDEXES) {
      if (spec.implicit) continue;
      const keys: Record<string, 1 | -1> = {};
      for (const key of spec.keys) keys[key] = spec.descending?.includes(key) ? -1 : 1;

      const current = existing.find((index) => index.name === spec.name);
      if (current && JSON.stringify(current.key) !== JSON.stringify(keys)) {
        await this.#col.dropIndex(spec.name);
      }
      await this.#col.createIndex(keys as IndexSpecification, {
        name: spec.name,
        ...(spec.unique ? { unique: true } : {}),
      });
    }
  }
}
