/**
 * Domain-event publisher seam. P1-4 needs to *announce* stream lifecycle + recording events
 * (`media.stream.connected|lost`, `media.recording.segment`) so perception/evidence can react,
 * without yet owning the event backbone — NATS JetStream wiring lands with the event pipeline
 * (P1-5, ADR-0016). Until then the service depends on this narrow interface and ships a logging
 * default, so downstream wiring is a drop-in later with no change to the application logic.
 *
 * Event payloads NEVER carry credentials or secrets (only ids/metadata).
 */
export interface DomainEvent {
  type: string;
  tenantId: string;
  payload?: Record<string, unknown>;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

/** Default publisher: records the event on the service logger. Replaced by NATS in P1-5. */
export class LoggingEventPublisher implements EventPublisher {
  constructor(private readonly log: (event: DomainEvent) => void) {}

  async publish(event: DomainEvent): Promise<void> {
    this.log(event);
  }
}

/** No-op publisher for tests that don't assert on emission. */
export const nullPublisher: EventPublisher = {
  async publish() {
    /* intentionally empty */
  },
};
