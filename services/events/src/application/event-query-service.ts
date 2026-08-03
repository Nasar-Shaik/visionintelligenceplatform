/**
 * Application: the read/replay side. `query` returns a tenant-scoped, bounded page of persisted
 * envelopes; `replay` re-publishes envelopes in a time window onto the backbone so a new or repaired
 * consumer can rebuild state (ADR-0005 replay). Replay is bounded twice — by the request `limit` and
 * by the service ceiling — and re-published with each envelope's id as the dedup id, so downstream
 * consumers absorb the replay idempotently.
 */
import type {
  EventEnvelope,
  EventPage,
  EventQuery,
  EventReplayRequest,
  EventReplayResult,
} from '@vip/contracts';
import { eventSubject, type EventBus } from '@vip/messaging';
import type { TenantScope } from '@vip/tenancy';
import type { EventStore } from './ports.js';
import type { EventMetrics } from './metrics.js';

export interface EventQueryDeps {
  store: EventStore;
  bus: EventBus;
  replayCeiling: number;
}

export class EventQueryService {
  private metrics: EventMetrics | undefined;

  constructor(private readonly deps: EventQueryDeps) {}

  /**
   * Attach the metrics collaborator after construction — the Prometheus registry only exists once
   * the server is built, while this service is created by the composition root before it.
   */
  useMetrics(metrics: EventMetrics): void {
    this.metrics = metrics;
  }

  /**
   * One event by id (P-5.0 G-5) — what the investigation workspace calls to answer "why did this
   * rule fire", having got `triggeredBy.eventId` from the incident. `null` is a legitimate answer:
   * an event outside the retention window is gone, and that is not an error.
   */
  async getById(scope: TenantScope, id: string): Promise<EventEnvelope | null> {
    const endTimer = this.metrics?.lookupDuration.startTimer();
    try {
      const envelope = await this.deps.store.getById(scope, id);
      this.metrics?.lookups.inc({ outcome: envelope ? 'found' : 'not_found' });
      return envelope;
    } finally {
      endTimer?.();
    }
  }

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
