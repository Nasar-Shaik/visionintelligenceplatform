/**
 * Application ports — the seams the event service depends on, so the application logic is testable
 * without a broker or a database. `EventStore` persists tenant-scoped envelopes idempotently (the
 * unique dedup key collapses duplicates); `query`/`range` read within a scope for `GET /events` and
 * replay. The concrete Mongo/JetStream adapters are wired by the composition root.
 */
import type { EventEnvelope, EventQuery, EventReplayRequest } from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';

export interface EventStore {
  /**
   * Persist an envelope under its dedup key. Returns `true` if newly stored, `false` if a duplicate
   * (same key) already existed — the caller skips re-publishing on `false` (idempotent).
   */
  persist(scope: TenantScope, envelope: EventEnvelope, key: string): Promise<boolean>;
  /** Tenant-scoped, bounded query, newest-first, with an opaque forward cursor. */
  query(
    scope: TenantScope,
    q: EventQuery,
  ): Promise<{ events: EventEnvelope[]; nextCursor?: string }>;
  /** Tenant-scoped time-window read for replay (oldest-first, bounded by `limit`). */
  range(scope: TenantScope, req: EventReplayRequest): Promise<EventEnvelope[]>;
}
