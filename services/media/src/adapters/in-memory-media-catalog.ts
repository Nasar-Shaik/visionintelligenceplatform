/**
 * Adapter: an in-memory `MediaCatalogStore` — the deterministic backing for unit tests (and any
 * non-persistent mode). It mirrors the Mongo adapter's semantics: tenant isolation, idempotent
 * recording upsert on id, newest-first keyset pagination, and overlap-based coverage for clips.
 */
import type { ClipQuery, RecordingQuery } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { RecordingDoc } from '../domain/recording.js';
import type { ClipDoc } from '../domain/clip.js';
import type { MediaCatalogStore } from '../application/ports.js';
import { decodeCursor, encodeCursor } from './catalog-cursor.js';

export class InMemoryMediaCatalog implements MediaCatalogStore {
  readonly #recordings = new Map<string, RecordingDoc>();
  readonly #clips = new Map<string, ClipDoc>();

  async putRecording(scope: TenantScope, doc: RecordingDoc): Promise<void> {
    this.#recordings.set(doc._id, { ...doc, tenantId: scope.tenantId });
  }

  async listRecordings(
    scope: TenantScope,
    q: RecordingQuery,
  ): Promise<{ items: RecordingDoc[]; nextCursor?: string }> {
    let rows = [...this.#recordings.values()].filter((r) => r.tenantId === scope.tenantId);
    if (q.cameraId) rows = rows.filter((r) => r.cameraId === q.cameraId);
    if (q.from) rows = rows.filter((r) => r.startedAt >= q.from!);
    if (q.to) rows = rows.filter((r) => r.startedAt < q.to!);
    rows.sort((a, b) => cmpNewestFirst(a.startedAt, a._id, b.startedAt, b._id));
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cur) rows = rows.filter((r) => cmpNewestFirst(r.startedAt, r._id, cur.sortKey, cur.id) > 0);
    return page(rows, q.limit, (r) => ({ sortKey: r.startedAt, id: r._id }));
  }

  async getRecording(scope: TenantScope, id: string): Promise<RecordingDoc | null> {
    const doc = this.#recordings.get(id);
    return doc && doc.tenantId === scope.tenantId ? doc : null;
  }

  async recordingsCovering(
    scope: TenantScope,
    cameraId: string,
    from: string,
    to: string,
  ): Promise<RecordingDoc[]> {
    return [...this.#recordings.values()]
      .filter(
        (r) =>
          r.tenantId === scope.tenantId &&
          r.cameraId === cameraId &&
          r.startedAt < to &&
          r.endedAt > from,
      )
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  }

  async putClip(scope: TenantScope, doc: ClipDoc): Promise<void> {
    this.#clips.set(doc._id, { ...doc, tenantId: scope.tenantId });
  }

  async listClips(
    scope: TenantScope,
    q: ClipQuery,
  ): Promise<{ items: ClipDoc[]; nextCursor?: string }> {
    let rows = [...this.#clips.values()].filter((c) => c.tenantId === scope.tenantId);
    if (q.cameraId) rows = rows.filter((c) => c.cameraId === q.cameraId);
    if (q.incidentId) rows = rows.filter((c) => c.incidentId === q.incidentId);
    if (q.status) rows = rows.filter((c) => c.status === q.status);
    rows.sort((a, b) => cmpNewestFirst(a.createdAt, a._id, b.createdAt, b._id));
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    if (cur) rows = rows.filter((c) => cmpNewestFirst(c.createdAt, c._id, cur.sortKey, cur.id) > 0);
    return page(rows, q.limit, (c) => ({ sortKey: c.createdAt, id: c._id }));
  }

  async getClip(scope: TenantScope, id: string): Promise<ClipDoc | null> {
    const doc = this.#clips.get(id);
    return doc && doc.tenantId === scope.tenantId ? doc : null;
  }

  async deleteClip(scope: TenantScope, id: string): Promise<boolean> {
    const doc = this.#clips.get(id);
    if (!doc || doc.tenantId !== scope.tenantId) return false;
    this.#clips.delete(id);
    return true;
  }
}

/**
 * `Array.sort` comparator for newest-first order on the keyset `(sortKey, id)`: returns a negative
 * number when `a` is newer (larger key, then larger id) so it sorts before `b`. A positive result
 * therefore also means "a is strictly older than b" — used to keep rows after a forward cursor.
 */
function cmpNewestFirst(aKey: string, aId: string, bKey: string, bId: string): number {
  if (aKey !== bKey) return aKey > bKey ? -1 : 1;
  return aId > bId ? -1 : aId < bId ? 1 : 0;
}

function page<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => { sortKey: string; id: string },
): { items: T[]; nextCursor?: string } {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = keyOf(items[items.length - 1]!);
  return { items, nextCursor: encodeCursor(last) };
}
