/**
 * Application: the read/replay side. `query` returns a tenant-scoped, bounded page of persisted
 * envelopes; `replay` re-publishes envelopes in a time window onto the backbone so a new or repaired
 * consumer can rebuild state (ADR-0005 replay). Replay is bounded twice — by the request `limit` and
 * by the service ceiling — and re-published with each envelope's id as the dedup id, so downstream
 * consumers absorb the replay idempotently.
 */
import type { EventPage, EventQuery, EventReplayRequest, EventReplayResult } from '@vip/contracts';
import { eventSubject, type EventBus } from '@vip/messaging';
import type { TenantScope } from '@vip/tenancy';
import type { EventStore } from './ports.js';

export interface EventQueryDeps {
  store: EventStore;
  bus: EventBus;
  replayCeiling: number;
}

export class EventQueryService {
  constructor(private readonly deps: EventQueryDeps) {}

  async query(scope: TenantScope, q: EventQuery): Promise<EventPage> {
    const { events, nextCursor } = await this.deps.store.query(scope, q);
    return nextCursor ? { events, nextCursor } : { events };
  }

  async replay(scope: TenantScope, req: EventReplayRequest): Promise<EventReplayResult> {
    const limit = Math.min(req.limit, this.deps.replayCeiling);
    const envelopes = await this.deps.store.range(scope, { ...req, limit });
    for (const envelope of envelopes) {
      await this.deps.bus.publish(eventSubject(envelope.tenantId, envelope.type), envelope, {
        msgId: envelope.id,
      });
    }
    return { replayed: envelopes.length, from: req.from, to: req.to };
  }
}
