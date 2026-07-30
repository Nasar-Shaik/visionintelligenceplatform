/**
 * Incident → Evidence consumer: proves the event-driven seam (frozen 22 §11: Evidence consumes
 * incident.raised). A fake extractor registers evidence for a raised incident (preserving Event →
 * Incident → Evidence traceability); a malformed payload is dead-lettered (fail-closed).
 */
import { describe, expect, it } from 'vitest';
import type { Incident } from '@vip/contracts';
import { InMemoryEventBus, incidentRaisedSubject } from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import {
  IncidentEvidenceConsumer,
  type IncidentEvidenceExtractor,
} from '../src/application/incident-consumer.js';
import { buildHarness } from './helpers.js';

const A = 'tnt_a';

function raisedIncident(): Incident {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: A,
    status: 'raised',
    severity: 'critical',
    title: 'High-confidence person',
    category: 'perception',
    source: {
      ruleId: 'rule_1',
      ruleVersion: 1,
      ruleName: 'person',
      candidateId: '22222222-2222-4222-8222-222222222222',
      dedupKey: 'tnt_a|rule_1|-|1',
    },
    triggeredBy: {
      eventId: '33333333-3333-4333-8333-333333333333',
      eventType: 'perception.person.detected',
      cameraId: 'cam_1',
      occurredAt: '2026-07-30T09:00:00.000Z',
    },
    matchedCount: 1,
    version: 1,
    correlationId: 'corr-1',
    causationId: '22222222-2222-4222-8222-222222222222',
    history: [{ from: null, to: 'raised', at: '2026-07-30T09:00:00.500Z', by: 'system' }],
    raisedAt: '2026-07-30T09:00:00.500Z',
    updatedAt: '2026-07-30T09:00:00.500Z',
  };
}

describe('IncidentEvidenceConsumer', () => {
  it('extracts + registers evidence for a raised incident (Event→Incident→Evidence traceability)', async () => {
    const h = buildHarness();
    const bus = new InMemoryEventBus();

    // A fake Media-backed extractor: stores a snapshot then registers it, carrying the incident refs.
    const extractor: IncidentEvidenceExtractor = {
      async extract(scope: TenantScope, incident: Incident): Promise<number> {
        const relKey = `${incident.triggeredBy.cameraId}/evidence/${incident.id}.jpg`;
        await h.objectStore.put({
          key: `${scope.tenantId}/${relKey}`,
          body: 'FRAME',
          contentType: 'image/jpeg',
        });
        await h.service.register(scope, 'system', {
          kind: 'snapshot',
          storageKey: relKey,
          contentType: 'image/jpeg',
          capturedAt: incident.triggeredBy.occurredAt,
          source: {
            incidentId: incident.id,
            eventId: incident.triggeredBy.eventId,
            correlationId: incident.correlationId,
            ...(incident.triggeredBy.cameraId ? { cameraId: incident.triggeredBy.cameraId } : {}),
            ruleId: incident.source.ruleId,
          },
        });
        return 1;
      },
    };

    const consumer = new IncidentEvidenceConsumer({ bus, extractor, service: h.service });
    await consumer.start();
    await bus.publish(incidentRaisedSubject(A), raisedIncident());

    const items = (await h.service.list(h.scope(A), { limit: 50 })).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toMatchObject({
      incidentId: '11111111-1111-4111-8111-111111111111',
      eventId: '33333333-3333-4333-8333-333333333333',
      correlationId: 'corr-1',
    });
    expect(bus.delivered.at(-1)?.disposition).toBe('ack');
    await consumer.stop();
  });

  it('dead-letters a malformed incident payload (fail-closed)', async () => {
    const h = buildHarness();
    const bus = new InMemoryEventBus();
    const consumer = new IncidentEvidenceConsumer({
      bus,
      extractor: {
        async extract() {
          return 0;
        },
      },
      service: h.service,
    });
    await consumer.start();
    await bus.publish(incidentRaisedSubject(A), { not: 'an-incident' });
    expect(bus.delivered.at(-1)?.disposition).toBe('term');
    expect((await h.service.list(h.scope(A), { limit: 50 })).items).toHaveLength(0);
    await consumer.stop();
  });
});
