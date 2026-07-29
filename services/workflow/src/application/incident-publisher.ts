/**
 * Application: publishes incident lifecycle events onto the automation backbone. Each transition is
 * published on `t.{tenant}.incident.{status}` with the full Incident as the payload (the Alert Engine
 * consumes only `incident.raised`; analytics/connectors may consume the rest). The msgId encodes
 * `{id}:{status}:{version}` so a redelivery/duplicate collapses (idempotent downstream). A no-op
 * publisher (no bus) is used in unit tests that only assert store state.
 */
import type { Incident } from '@vip/contracts';
import { type EventBus, incidentLifecycleSubject } from '@vip/messaging';

export interface IncidentPublisher {
  publish(incident: Incident): Promise<void>;
}

/** The real publisher over the `EventBus`. */
export class BusIncidentPublisher implements IncidentPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(incident: Incident): Promise<void> {
    await this.bus.publish(
      incidentLifecycleSubject(incident.tenantId, incident.status),
      incident,
      // Tenant-scoped msgId: the AUTOMATION stream is shared across tenants, so the dedup id must be
      // too (id is a UUID, but this keeps dedup correct even with deterministic ids).
      { msgId: `${incident.tenantId}:${incident.id}:${incident.status}:${incident.version}` },
    );
  }
}

/** A publisher that drops everything — for tests/local wiring without a bus. */
export const NoopIncidentPublisher: IncidentPublisher = {
  async publish() {
    /* no-op */
  },
};
