import { describe, expect, it } from 'vitest';
import { Incident, IncidentStatus, IncidentQuery } from '../src/incidents/incident.js';
import { EVENT_CATALOG } from '../src/events/catalog.js';

const baseIncident = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tnt_a',
  status: 'raised' as const,
  severity: 'critical' as const,
  title: 'High-confidence person',
  category: 'perception' as const,
  source: {
    ruleId: 'rule_1',
    ruleVersion: 1,
    ruleName: 'person after hours',
    candidateId: '22222222-2222-4222-8222-222222222222',
    dedupKey: 'tnt_a|rule_1|-|123',
  },
  triggeredBy: {
    eventId: '33333333-3333-4333-8333-333333333333',
    eventType: 'perception.person.detected',
    occurredAt: '2026-07-29T00:00:00.000Z',
  },
  matchedCount: 1,
  version: 1,
  correlationId: '33333333-3333-4333-8333-333333333333',
  causationId: '22222222-2222-4222-8222-222222222222',
  raisedAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
};

describe('Incident', () => {
  it('parses a raised incident and defaults history to []', () => {
    const parsed = Incident.parse(baseIncident);
    expect(parsed.status).toBe('raised');
    expect(parsed.history).toEqual([]);
  });

  it('requires a correlationId (end-to-end chain, rec 1)', () => {
    const { correlationId: _omit, ...withoutCorrelation } = baseIncident;
    expect(() => Incident.parse(withoutCorrelation)).toThrow();
  });

  it('enumerates the full lifecycle', () => {
    expect(IncidentStatus.options).toEqual(['raised', 'acknowledged', 'resolved', 'closed']);
  });
});

describe('IncidentQuery', () => {
  it('defaults limit to 50', () => {
    expect(IncidentQuery.parse({}).limit).toBe(50);
  });
});

describe('incident lifecycle catalog entries', () => {
  it('registers every lifecycle event as a system event', () => {
    for (const type of [
      'incident.raised',
      'incident.acknowledged',
      'incident.resolved',
      'incident.closed',
    ]) {
      const entry = EVENT_CATALOG.find((e) => e.type === type);
      expect(entry, type).toBeDefined();
      expect(entry?.category).toBe('system');
    }
  });
});
