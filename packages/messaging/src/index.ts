/**
 * @vip/messaging — the event backbone client (P1-5). A thin, fail-closed wrapper over NATS
 * JetStream (ADR-0016): tenant-partitioned subjects `t.{tenantId}.…` with structural validation, an
 * `EventBus` port (durable publish + pull-consume with ack/nak/term→DLQ), an in-memory bus for
 * tests/local, and a `JetStreamEventPublisher` backing each service's domain-event seam. The heavy
 * `nats` client is confined to `NatsEventBus`; everything else depends only on the port.
 *
 * Grounds: docs/architecture/09-EVENT-PLATFORM.md, docs/architecture/phase1/EVENT_PIPELINE.md,
 * ADR-0005 (event-driven backbone), ADR-0016 (NATS JetStream).
 */
export { MessagingError } from './errors.js';
export {
  TENANT_ROOT,
  CAPABILITY_OUTPUT_PREFIX,
  EVENT_PREFIX,
  INCIDENT_PREFIX,
  RULE_PREFIX,
  CAPABILITY_OUTPUT_STREAM,
  EVENTS_STREAM,
  AUTOMATION_STREAM,
  ALL_CAPABILITY_OUTPUTS,
  ALL_EVENTS,
  ALL_INCIDENTS,
  ALL_RULE_MATCHES,
  assertTenantToken,
  tenantRoot,
  capabilityOutputSubject,
  eventSubject,
  incidentCandidateSubject,
  ruleMatchedSubject,
  tenantIdFromSubject,
  subjectMatches,
} from './subjects.js';
export {
  type BusMessage,
  type MessageHandler,
  type SubscribeOptions,
  type Subscription,
  type PublishOptions,
  type EventBus,
  type DeliveredRecord,
  InMemoryEventBus,
  decodeJson,
} from './event-bus.js';
export { NatsEventBus, type NatsEventBusOptions } from './nats-event-bus.js';
export { JetStreamEventPublisher, type DomainEvent, type EventPublisher } from './publisher.js';

/** Package version — bump per Constitution §7. */
export const MESSAGING_VERSION = '0.1.0';
