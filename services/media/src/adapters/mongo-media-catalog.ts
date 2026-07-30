/**
 * Adapter: `MediaCatalogStore` over MongoDB, routed through @vip/tenancy `TenantRepository` so every
 * read/write is tenant-scoped structurally (Law 5). Recording upserts are idempotent on `_id` (the
 * derived recording id). Listings use the guard's `aggregate` (which prepends the tenant `$match`)
 * with keyset pagination — newest-first by `(startedAt|createdAt, _id)`; ISO timestamps order as
 * strings. Mirrors the events store's approach.
 */
import type { Collection } from 'mongodb';
import type { ClipQuery, RecordingQuery } from '@vip/contracts';
import { TenantRepository, type PlainObject, type TenantScope } from '@vip/tenancy';
import type { RecordingDoc } from '../domain/recording.js';
import type { ClipDoc } from '../domain/clip.js';
import type { MediaCatalogStore } from '../application/ports.js';
import { decodeCursor, encodeCursor } from './catalog-cursor.js';

export class MongoMediaCatalog implements MediaCatalogStore {
  readonly #recordings: TenantRepository<RecordingDoc>;
  readonly #clips: TenantRepository<ClipDoc>;
  readonly #recordingsCol: Collection<RecordingDoc>;
  readonly #clipsCol: Collection<ClipDoc>;

  constructor(recordings: Collection<RecordingDoc>, clips: Collection<ClipDoc>) {
    this.#recordings = new TenantRepository<RecordingDoc>(recordings);
    this.#clips = new TenantRepository<ClipDoc>(clips);
    this.#recordingsCol = recordings;
    this.#clipsCol = clips;
  }

  async putRecording(scope: TenantScope, doc: RecordingDoc): Promise<void> {
    // Idempotent on the derived id: re-indexing the same segment replaces (no duplicate).
    const existing = await this.#recordings.findOne(scope, { _id: doc._id } as PlainObject);
    if (existing) return;
    try {
      await this.#recordings.insertOne(scope, doc as Omit<RecordingDoc, 'tenantId'>);
    } catch (err: unknown) {
      if ((err as { code?: number }).code === 11000) return; // raced insert — already indexed
      throw err;
    }
  }

  async listRecordings(
    scope: TenantScope,
    q: RecordingQuery,
  ): Promise<{ items: RecordingDoc[]; nextCursor?: string }> {
    const match: PlainObject = {};
    if (q.cameraId) match['cameraId'] = q.cameraId;
    if (q.from || q.to) {
      const range: PlainObject = {};
      if (q.from) range['$gte'] = q.from;
      if (q.to) range['$lt'] = q.to;
      match['startedAt'] = range;
    }
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cur) {
      match['$or'] = [
        { startedAt: { $lt: cur.sortKey } },
        { startedAt: cur.sortKey, _id: { $lt: cur.id } },
      ];
    }
    const rows = await this.#recordings.aggregate<RecordingDoc>(scope, [
      { $match: match },
      { $sort: { startedAt: -1, _id: -1 } },
      { $limit: q.limit + 1 },
    ]);
    return this.#page(rows, q.limit, (r) => ({ sortKey: r.startedAt, id: r._id }));
  }

  async getRecording(scope: TenantScope, id: string): Promise<RecordingDoc | null> {
    return this.#recordings.findOne(scope, { _id: id } as PlainObject);
  }

  async recordingsCovering(
    scope: TenantScope,
    cameraId: string,
    from: string,
    to: string,
  ): Promise<RecordingDoc[]> {
    // Overlap: startedAt < to AND endedAt > from.
    return this.#recordings.aggregate<RecordingDoc>(scope, [
      { $match: { cameraId, startedAt: { $lt: to }, endedAt: { $gt: from } } },
      { $sort: { startedAt: 1, _id: 1 } },
    ]);
  }

  async putClip(scope: TenantScope, doc: ClipDoc): Promise<void> {
    await this.#clips.insertOne(scope, doc as Omit<ClipDoc, 'tenantId'>);
  }

  async listClips(
    scope: TenantScope,
    q: ClipQuery,
  ): Promise<{ items: ClipDoc[]; nextCursor?: string }> {
    const match: PlainObject = {};
    if (q.cameraId) match['cameraId'] = q.cameraId;
    if (q.incidentId) match['incidentId'] = q.incidentId;
    if (q.status) match['status'] = q.status;
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cur) {
      match['$or'] = [
        { createdAt: { $lt: cur.sortKey } },
        { createdAt: cur.sortKey, _id: { $lt: cur.id } },
      ];
    }
    const rows = await this.#clips.aggregate<ClipDoc>(scope, [
      { $match: match },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: q.limit + 1 },
    ]);
    return this.#page(rows, q.limit, (c) => ({ sortKey: c.createdAt, id: c._id }));
  }

  async getClip(scope: TenantScope, id: string): Promise<ClipDoc | null> {
    return this.#clips.findOne(scope, { _id: id } as PlainObject);
  }

  async deleteClip(scope: TenantScope, id: string): Promise<boolean> {
    return (await this.#clips.deleteOne(scope, { _id: id } as PlainObject)) > 0;
  }

  #page<T>(
    rows: T[],
    limit: number,
    keyOf: (row: T) => { sortKey: string; id: string },
  ): { items: T[]; nextCursor?: string } {
    if (rows.length <= limit) return { items: rows };
    const items = rows.slice(0, limit);
    const last = keyOf(items[items.length - 1]!);
    return { items, nextCursor: encodeCursor(last) };
  }

  /** Ensure the catalog indexes exist (tenant-leading; keyset sort support). */
  async ensureIndexes(): Promise<void> {
    await this.#recordingsCol.createIndex(
      { tenantId: 1, cameraId: 1, startedAt: -1, _id: -1 },
      { name: 'tenant_camera_started' },
    );
    await this.#recordingsCol.createIndex(
      { tenantId: 1, startedAt: -1, _id: -1 },
      { name: 'tenant_started' },
    );
    await this.#clipsCol.createIndex(
      { tenantId: 1, createdAt: -1, _id: -1 },
      { name: 'tenant_created' },
    );
    await this.#clipsCol.createIndex({ tenantId: 1, incidentId: 1 }, { name: 'tenant_incident' });
  }
}
