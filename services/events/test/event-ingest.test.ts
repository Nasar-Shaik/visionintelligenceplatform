import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryEventBus,
  capabilityOutputSubject,
  ALL_EVENTS,
  type BusMessage,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import { EventIngestService } from '../src/application/event-ingest-service.js';
import { InMemoryEventStore } from '../src/adapters/in-memory-event-store.js';
import { detectionResult } from './helpers.js';

let bus: InMemoryEventBus;
let store: InMemoryEventStore;
let ingest: EventIngestService;
let ids = 0;

beforeEach(async () => {
  bus = new InMemoryEventBus();
  store = new InMemoryEventStore();
  ids = 0;
  ingest = new EventIngestService({
    bus,
    store,
    dedupWindowMs: 10_000,
    now: () => new Date('2026-07-28T00:00:00.200Z'),
    newId: () => `evt_${++ids}`,
  });
  await ingest.start();
});

/** Publish a capability output and let the in-memory bus route it synchronously to the consumer. */
async function emit(result: unknown, tenant = 'tnt_a'): Promise<void> {
  await bus.publish(capabilityOutputSubject(tenant, 'perception.person-detection'), result);
}

describe('EventIngestService — detection → persisted, deduplicated, published event', () => {
  it('normalizes, persists, and publishes on t.{tenant}.event.* (acceptance)', async () => {
    // subscribe to the published events to prove the event.persisted signal
    const publishedEvents: string[] = [];
    await bus.subscribe(
      { stream: 'EVENTS', durable: 'probe', filterSubject: ALL_EVENTS },
      (m: BusMessage) => {
        publishedEvents.push(m.subject);
        m.ack();
      },
    );

    await emit(detectionResult());

    const page = await store.query(TenantScope.fromTenantId('tnt_a'), { limit: 50 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ type: 'perception.person.detected', tenantId: 'tnt_a' });
    expect(publishedEvents).toContain('t.tnt_a.event.perception.person.detected');
    expect(bus.delivered.find((d) => d.subject.startsWith('t.tnt_a.capability'))?.disposition).toBe(
      'ack',
    );
  });

  it('deduplicates a redelivered/identical detection (idempotent, publishes once)', async () => {
    let published = 0;
    await bus.subscribe({ stream: 'EVENTS', durable: 'probe', filterSubject: ALL_EVENTS }, (m) => {
      published++;
      m.ack();
    });
    await emit(detectionResult());
    await emit(detectionResult()); // same subject, same bucket → deduped
    expect(published).toBe(1);
  });

  it('dead-letters (term) a payload with no tenant context — fail-closed', async () => {
    await emit(detectionResult({ tenantId: undefined as never }));
    const cap = bus.delivered.find((d) => d.subject.startsWith('t.tnt_a.capability'));
    expect(cap?.disposition).toBe('term');
  });

  it('dead-letters a non-JSON-shaped / invalid DetectionResult', async () => {
    await emit({ not: 'a detection result' });
    const cap = bus.delivered.find((d) => d.subject.startsWith('t.tnt_a.capability'));
    expect(cap?.disposition).toBe('term');
  });

  it('dead-letters when the subject tenant disagrees with the body tenant (cross-tenant)', async () => {
    // published on tnt_b's subject but the body claims tnt_a
    await bus.publish(
      capabilityOutputSubject('tnt_b', 'perception.person-detection'),
      detectionResult({ tenantId: 'tnt_a' }),
    );
    const cap = bus.delivered.find((d) => d.subject.startsWith('t.tnt_b.capability'));
    expect(cap?.disposition).toBe('term');
  });

  it('acks a zero-detection result without persisting or publishing', async () => {
    await emit(detectionResult({ detections: [] }));
    const cap = bus.delivered.find((d) => d.subject.startsWith('t.tnt_a.capability'));
    expect(cap?.disposition).toBe('ack');
    expect(bus.published.filter((p) => p.subject.startsWith('t.tnt_a.event'))).toHaveLength(0);
  });
});
