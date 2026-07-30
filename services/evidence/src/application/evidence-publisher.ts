/**
 * Application: publishes evidence lifecycle events onto the backbone (`t.{tenant}.evidence.{kind}` —
 * `created|exported|held|purged`, frozen 22 §11). Payload is the full Evidence. A no-op publisher is
 * the default for tests/local wiring without a bus. The msgId collapses a redelivery.
 */
import type { Evidence } from '@vip/contracts';
import { tenantRoot, type EventBus } from '@vip/messaging';

export interface EvidenceEvent {
  type: 'evidence.created' | 'evidence.exported' | 'evidence.held' | 'evidence.purged';
  evidence: Evidence;
}

export interface EvidencePublisher {
  publish(event: EvidenceEvent): Promise<void>;
}

/** The real publisher over the EventBus. */
export class BusEvidencePublisher implements EvidencePublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(event: EvidenceEvent): Promise<void> {
    const kind = event.type.slice('evidence.'.length);
    const subject = `${tenantRoot(event.evidence.tenantId)}.evidence.${kind}`;
    await this.bus.publish(subject, event.evidence, {
      msgId: `${event.evidence.tenantId}:${event.evidence.id}:${event.type}`,
    });
  }
}

export const NoopEvidencePublisher: EvidencePublisher = {
  async publish() {
    /* no-op */
  },
};
