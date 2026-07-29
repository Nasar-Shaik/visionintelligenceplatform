import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryEventBus,
  incidentCandidateSubject,
  ALL_INCIDENTS_RAISED,
  type BusMessage,
} from '@vip/messaging';
import type { Incident } from '@vip/contracts';
import { IncidentPromoter } from '../src/application/incident-promoter.js';
import { IncidentService } from '../src/application/incident-service.js';
import { BusIncidentPublisher } from '../src/application/incident-publisher.js';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { personCandidate } from './helpers.js';

let bus: InMemoryEventBus;
let store: InMemoryIncidentStore;
let service: IncidentService;
let promoter: IncidentPromoter;

async function start(): Promise<void> {
  service = new IncidentService({
    store,
    publisher: new BusIncidentPublisher(bus),
    now: () => new Date('2026-07-29T23:00:00.000Z'),
    newId: () => 'inc_1',
  });
  promoter = new IncidentPromoter({ bus, service });
  await promoter.start();
}

/** Collect raised incidents published on the automation subject. */
function collectRaised(): Incident[] {
  const out: Incident[] = [];
  void bus.subscribe(
    { stream: 'AUTOMATION', durable: 'probe-raised', filterSubject: ALL_INCIDENTS_RAISED },
    (m: BusMessage) => {
      out.push(m.json());
      m.ack();
    },
  );
  return out;
}

async function emit(candidate = personCandidate()): Promise<void> {
  await bus.publish(incidentCandidateSubject(candidate.tenantId), candidate);
}

beforeEach(() => {
  bus = new InMemoryEventBus();
  store = new InMemoryIncidentStore();
});

describe('IncidentPromoter — candidate → raised incident', () => {
  it('promotes a candidate to a raised incident and publishes incident.raised (acceptance)', async () => {
    const raised = collectRaised();
    await start();
    await emit();

    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      status: 'raised',
      severity: 'critical',
      correlationId: 'corr-abc',
      matchedCount: 1,
      triggeredBy: { eventType: 'perception.person.detected', cameraId: 'cam_1' },
    });
    // persisted, tenant-scoped
    expect(await store.get({ tenantId: 'tnt_a' } as never, 'inc_1')).not.toBeNull();
  });

  it('is idempotent — a repeat candidate (same dedupKey) collapses into one incident', async () => {
    const raised = collectRaised();
    await start();
    await emit();
    await emit(); // same dedupKey → no second incident, no second publish

    expect(raised).toHaveLength(1);
  });

  it('dead-letters a message that is not a valid IncidentCandidate (fail-closed)', async () => {
    const raised = collectRaised();
    await start();
    await bus.publish(incidentCandidateSubject('tnt_a'), { not: 'a candidate' });

    expect(raised).toHaveLength(0);
    expect(bus.delivered.some((d) => d.disposition === 'term')).toBe(true);
  });

  it('keeps tenants separate — each tenant gets its own incident on its own subject', async () => {
    const raised = collectRaised();
    await start();
    await emit(personCandidate({ tenantId: 'tnt_a', dedupKey: 'a|1' }));
    await emit(personCandidate({ tenantId: 'tnt_b', dedupKey: 'b|1' }));

    expect(raised).toHaveLength(2);
    expect(raised.map((r) => r.tenantId).sort()).toEqual(['tnt_a', 'tnt_b']);
    const subjects = bus.published.map((p) => p.subject);
    expect(subjects).toContain('t.tnt_a.incident.raised');
    expect(subjects).toContain('t.tnt_b.incident.raised');
  });
});
