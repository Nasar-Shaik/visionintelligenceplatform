/**
 * A DB-free `IncidentStore` for unit tests and local wiring. Enforces the same tenant scoping,
 * dedup-key uniqueness, and optimistic-version replace as the Mongo adapter, so promotion + lifecycle
 * logic is provable without a database. Listing is newest-first keyset pagination by `(raisedAt,id)`.
 */
import type { Incident, IncidentPage, IncidentQuery } from '@vip/contracts';
import { TenancyError, type TenantScope } from '@vip/tenancy';
import { conflict } from '../application/errors.js';
import type { IncidentStore } from '../application/ports.js';

export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents: Incident[] = [];

  private owned(scope: TenantScope, i: Incident): boolean {
    return i.tenantId === scope.tenantId;
  }

  async insert(scope: TenantScope, incident: Incident): Promise<void> {
    if (incident.tenantId !== scope.tenantId) {
      throw new TenancyError('cross-tenant write refused');
    }
    if (this.incidents.some((i) => this.owned(scope, i) && i.id === incident.id)) {
      throw conflict(`incident ${incident.id} already exists`);
    }
    if (
      this.incidents.some(
        (i) => this.owned(scope, i) && i.source.dedupKey === incident.source.dedupKey,
      )
    ) {
      throw conflict(`incident for dedupKey already exists`);
    }
    this.incidents.push(incident);
  }

  async get(scope: TenantScope, id: string): Promise<Incident | null> {
    return this.incidents.find((i) => this.owned(scope, i) && i.id === id) ?? null;
  }

  async getByDedupKey(scope: TenantScope, dedupKey: string): Promise<Incident | null> {
    return (
      this.incidents.find((i) => this.owned(scope, i) && i.source.dedupKey === dedupKey) ?? null
    );
  }

  async list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage> {
    const rows = this.incidents
      .filter(
        (i) =>
          this.owned(scope, i) &&
          (query.status === undefined || i.status === query.status) &&
          (query.severity === undefined || i.severity === query.severity),
      )
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || b.id.localeCompare(a.id));

    let start = 0;
    if (query.cursor) {
      const idx = rows.findIndex((r) => r.id === query.cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const items = rows.slice(start, start + query.limit);
    const hasMore = start + query.limit < rows.length;
    return hasMore && items.length > 0
      ? { items, nextCursor: items[items.length - 1]!.id }
      : { items };
  }

  async replace(scope: TenantScope, incident: Incident, expectedVersion: number): Promise<boolean> {
    const idx = this.incidents.findIndex(
      (i) => this.owned(scope, i) && i.id === incident.id && i.version === expectedVersion,
    );
    if (idx === -1) return false;
    if (incident.tenantId !== scope.tenantId) {
      throw new TenancyError('cross-tenant write refused');
    }
    this.incidents[idx] = incident;
    return true;
  }
}
