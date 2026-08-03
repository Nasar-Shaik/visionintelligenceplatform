/**
 * A broker/DB-free `EventStore` for unit tests and local wiring. Enforces the same tenant scoping
 * (reads/writes require a matching `TenantScope`) and the same dedup-key idempotency as the Mongo
 * adapter, so the ingest/query logic is provable without a running database.
 */
import type { EventEnvelope, EventQuery, EventReplayRequest } from '@vip/contracts';
import { TenancyError } from '@vip/tenancy';
import type { TenantScope } from '@vip/tenancy';
import type { EventStore } from '../application/ports.js';

interface Stored {
  envelope: EventEnvelope;
  key: string;
}

export class InMemoryEventStore implements EventStore {
  private readonly rows: Stored[] = [];
  private readonly seen = new Set<string>();

  async persist(scope: TenantScope, envelope: EventEnvelope, key: string): Promise<boolean> {
    // Mirror the Mongo guard: the record must belong to the scope's tenant (fail-closed).
    if (envelope.tenantId !== scope.tenantId) {
      throw new TenancyError('cross-tenant write refused (fail-closed)');
    }
    const dedup = `${scope.tenantId}::${key}`;
    if (this.seen.has(dedup)) return false;
    this.seen.add(dedup);
    this.rows.push({ envelope, key });
    return true;
  }

  /** One envelope by id within the scope — another tenant's event is `null`, not a 403 (G-5). */
  async getById(scope: TenantScope, id: string): Promise<EventEnvelope | null> {
    return (
      this.rows.map((r) => r.envelope).find((e) => e.tenantId === scope.tenantId && e.id === id) ??
      null
    );
  }

  async query(
    scope: TenantScope,
    q: EventQuery,
  ): Promise<{ events: EventEnvelope[]; nextCursor?: string }> {
    let events = this.rows
      .map((r) => r.envelope)
      .filter((e) => e.tenantId === scope.tenantId)
      .filter((e) => (q.type ? e.type === q.type : true))
      .filter((e) => (q.cameraId ? e.cameraId === q.cameraId : true))
      .filter((e) => (q.zoneId ? e.zoneId === q.zoneId : true))
      .filter((e) => (q.correlationId ? e.correlationId === q.correlationId : true))
      .filter((e) => (q.from ? e.occurredAt >= q.from : true))
      .filter((e) => (q.to ? e.occurredAt < q.to : true))
      .sort((a, b) =>
        a.occurredAt === b.occurredAt ? cmp(b.id, a.id) : cmp(b.occurredAt, a.occurredAt),
      );
    events = events.slice(0, q.limit);
    return { events };
  }

  async range(scope: TenantScope, req: EventReplayRequest): Promise<EventEnvelope[]> {
    return this.rows
      .map((r) => r.envelope)
      .filter((e) => e.tenantId === scope.tenantId)
      .filter((e) => e.occurredAt >= req.from && e.occurredAt < req.to)
      .filter((e) => (req.type ? e.type === req.type : true))
      .filter((e) => (req.cameraId ? e.cameraId === req.cameraId : true))
      .sort((a, b) =>
        a.occurredAt === b.occurredAt ? cmp(a.id, b.id) : cmp(a.occurredAt, b.occurredAt),
      )
      .slice(0, req.limit);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
