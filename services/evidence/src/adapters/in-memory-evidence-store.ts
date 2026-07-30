/**
 * A DB-free `EvidenceStore` for unit tests + local wiring. Enforces the same tenant scoping, stable-id
 * idempotency, and keyset pagination (newest-first by `capturedAt`,`_id`) as the Mongo adapter.
 */
import type { EvidenceQuery } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import type { EvidenceDoc } from '../domain/evidence.js';
import type { EvidenceStore } from '../application/ports.js';
import { decodeCursor, encodeCursor } from './evidence-cursor.js';

export class InMemoryEvidenceStore implements EvidenceStore {
  readonly #rows: EvidenceDoc[] = [];

  async insert(scope: TenantScope, doc: EvidenceDoc): Promise<boolean> {
    if (this.#rows.some((r) => r._id === doc._id && r.tenantId === scope.tenantId)) return false;
    this.#rows.push(structuredClone(doc));
    return true;
  }

  async get(scope: TenantScope, id: string): Promise<EvidenceDoc | null> {
    const row = this.#rows.find((r) => r._id === id && r.tenantId === scope.tenantId);
    return row ? structuredClone(row) : null;
  }

  async list(
    scope: TenantScope,
    q: EvidenceQuery,
  ): Promise<{ items: EvidenceDoc[]; nextCursor?: string }> {
    const cur = q.cursor ? decodeCursor(q.cursor) : undefined;
    let rows = this.#rows
      .filter((r) => r.tenantId === scope.tenantId)
      .filter((r) => (q.kind ? r.kind === q.kind : true))
      .filter((r) => (q.status ? r.status === q.status : true))
      .filter((r) => (q.cameraId ? r.source.cameraId === q.cameraId : true))
      .filter((r) => (q.incidentId ? r.source.incidentId === q.incidentId : true))
      .filter((r) => (q.eventId ? r.source.eventId === q.eventId : true))
      .filter((r) => (q.correlationId ? r.source.correlationId === q.correlationId : true))
      .filter((r) => (q.from ? r.capturedAt >= q.from : true))
      .filter((r) => (q.to ? r.capturedAt < q.to : true))
      .sort((a, b) =>
        a.capturedAt === b.capturedAt ? cmpDesc(a._id, b._id) : cmpDesc(a.capturedAt, b.capturedAt),
      );
    if (cur) {
      rows = rows.filter(
        (r) => r.capturedAt < cur.sortKey || (r.capturedAt === cur.sortKey && r._id < cur.id),
      );
    }
    const items = rows.slice(0, q.limit).map((r) => structuredClone(r));
    if (rows.length <= q.limit) return { items };
    const last = items[items.length - 1]!;
    return { items, nextCursor: encodeCursor({ sortKey: last.capturedAt, id: last._id }) };
  }

  async patch(scope: TenantScope, id: string, fields: Partial<EvidenceDoc>): Promise<boolean> {
    const row = this.#rows.find((r) => r._id === id && r.tenantId === scope.tenantId);
    if (!row) return false;
    Object.assign(row, structuredClone(fields));
    return true;
  }
}

/** Newest-first: negative when `a` is newer (sorts a before b). */
function cmpDesc(a: string, b: string): number {
  return a > b ? -1 : a < b ? 1 : 0;
}
