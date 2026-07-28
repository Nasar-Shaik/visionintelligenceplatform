/**
 * `JetStreamEventPublisher` — the drop-in that turns each service's domain-event seam into a real
 * publish on the backbone. Services (tenant/camera/media/…) already depend on a narrow
 * `publish({ type, tenantId, payload })` interface with a logging default (P1-1…P1-4); wiring this
 * as the composition-root default puts those lifecycle events onto `t.{tenantId}.event.{type}`
 * durably, with no change to application logic. The `id` (when supplied) becomes the JetStream
 * dedup id so an at-least-once producer retry does not double-publish.
 */
import type { EventBus } from './event-bus.js';
import { eventSubject } from './subjects.js';

/** The minimal domain event shape every service's seam already emits (structural). */
export interface DomainEvent {
  type: string;
  tenantId: string;
  payload?: Record<string, unknown>;
  /** Optional stable id used for publish-side dedup. */
  id?: string;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export class JetStreamEventPublisher implements EventPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(event: DomainEvent): Promise<void> {
    const subject = eventSubject(event.tenantId, event.type);
    await this.bus.publish(subject, event, event.id ? { msgId: event.id } : undefined);
  }
}
