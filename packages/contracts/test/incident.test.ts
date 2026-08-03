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

  it('defaults the three append-only streams to empty rather than absent', () => {
    const parsed = Incident.parse(baseIncident);
    expect(parsed.history).toEqual([]);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.notes).toEqual([]);
  });

  /**
   * ⚠️ Pinned deliberately. Extending a published enum is **not purely additive for a strict
   * parser** — a consumer pinned to the P1-8 four-value schema fails to parse an incident in a new
   * state. P-5.0 added two with the Architect's approval (entry criterion G-1, ADR-0029); the next
   * addition should be as deliberate, which is what failing this line forces.
   */
  it('enumerates the full lifecycle', () => {
    expect(IncidentStatus.options).toEqual([
      'raised',
      'acknowledged',
      'investigating',
      'escalated',
      'resolved',
      'closed',
    ]);
  });
});

describe('IncidentNote', () => {
  it('carries attachments as references — an evidence id, never the evidence', () => {
    const parsed = Incident.parse({
      ...baseIncident,
      notes: [
        {
          id: '44444444-4444-4444-8444-444444444444',
          body: 'contractor, badge visible',
          at: '2026-08-03T09:00:00.000Z',
          attachments: [{ kind: 'evidence', ref: 'evd_1' }],
        },
      ],
    });
    expect(parsed.notes[0]!.attachments[0]).toEqual({ kind: 'evidence', ref: 'evd_1' });
  });

  it('rejects an empty note body', () => {
    expect(() =>
      Incident.parse({
        ...baseIncident,
        notes: [
          { id: '44444444-4444-4444-8444-444444444444', body: '', at: '2026-08-03T09:00:00.000Z' },
        ],
      }),
    ).toThrow();
  });
});

describe('IncidentQuery — the frozen P-5 search surface (G-3)', () => {
  it('defaults limit to 50', () => {
    expect(IncidentQuery.parse({}).limit).toBe(50);
  });

  /**
   * Frozen so P-5 can be built against it without an API redesign (Architect rec 9). A tenth filter
   * needs its index and a row in the workflow coverage test before this line changes.
   */
  it('freezes the filter set', () => {
    expect(Object.keys(IncidentQuery.shape).sort()).toEqual([
      'assignee',
      'cameraId',
      'category',
      'correlationId',
      'cursor',
      'eventType',
      'from',
      'limit',
      'ruleId',
      'severity',
      'status',
      'to',
      'zoneId',
    ]);
  });

  it('accepts the whole surface at once and rejects an out-of-contract status', () => {
    const parsed = IncidentQuery.parse({
      status: 'investigating',
      severity: 'critical',
      category: 'security',
      eventType: 'behavior.loitering',
      cameraId: 'cam_1',
      zoneId: 'zone_1',
      ruleId: 'rule_1',
      correlationId: 'corr-1',
      assignee: 'priya',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
    });
    expect(parsed.limit).toBe(50);
    expect(() => IncidentQuery.parse({ status: 'assigned' })).toThrow();
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
