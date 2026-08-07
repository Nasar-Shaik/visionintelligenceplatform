import { describe, expect, it } from 'vitest';
import {
  Incident,
  IncidentStatus,
  IncidentQuery,
  INCIDENT_LIFECYCLE,
  TERMINAL_INCIDENT_STATUSES,
} from '../src/incidents/incident.js';
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
      'dismissed',
      'archived',
    ]);
  });
});

/**
 * The frozen lifecycle (P-8 Phase 7, ADR-0045). These assertions exist so that **adding a state
 * without deciding where it may be entered from, and by whom, fails the build** — the property the
 * workflow service's transition table claimed and could not enforce while three other copies of it
 * lived in the console.
 */
describe('INCIDENT_LIFECYCLE', () => {
  it('describes every status, and only the declared statuses', () => {
    expect(Object.keys(INCIDENT_LIFECYCLE).sort()).toEqual([...IncidentStatus.options].sort());
  });

  it('every reachableFrom names a real status, and no state reaches itself', () => {
    for (const status of IncidentStatus.options) {
      const state = INCIDENT_LIFECYCLE[status];
      expect(state.reachableFrom).not.toContain(status);
      for (const from of state.reachableFrom) {
        expect(IncidentStatus.options).toContain(from);
      }
    }
  });

  /**
   * ⚠️ The one that matters most. A terminal state is a **sealed record** (CONSTRAINTS §57) — if
   * anything could be entered *from* one, "retained for audit" would stop being true.
   */
  it('nothing may leave a terminal state', () => {
    const terminal = IncidentStatus.options.filter((s) => INCIDENT_LIFECYCLE[s].terminal);
    expect(terminal).toEqual(['closed', 'dismissed', 'archived']);
    expect(TERMINAL_INCIDENT_STATUSES).toEqual(terminal);
    for (const status of IncidentStatus.options) {
      /* `archived` is the sole exception: custody follows a record a person has already finished with. */
      if (status === 'archived') continue;
      for (const from of INCIDENT_LIFECYCLE[status].reachableFrom) {
        expect(INCIDENT_LIFECYCLE[from].terminal, `${from} → ${status}`).toBe(false);
      }
    }
  });

  it('`raised` is entered only by promotion, and only the platform enters it', () => {
    expect(INCIDENT_LIFECYCLE.raised.reachableFrom).toEqual([]);
    expect(INCIDENT_LIFECYCLE.raised.enteredBy).toBe('system');
  });

  /**
   * ⚠️ Declared, and reachable by nothing. If a milestone makes one of these emittable it must flip
   * this flag deliberately — and this assertion is where whoever does it is asked to think about the
   * strict parsers pinned to the schema that predates them (ADR-0029).
   */
  it('dismissed and archived are declared and unreachable', () => {
    expect(IncidentStatus.options.filter((s) => !INCIDENT_LIFECYCLE[s].reachable)).toEqual([
      'dismissed',
      'archived',
    ]);
    /* Archival is custody, never an operator action — see ADR-0045. */
    expect(INCIDENT_LIFECYCLE.archived.enteredBy).toBe('system');
    expect(INCIDENT_LIFECYCLE.dismissed.enteredBy).toBe('operator');
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
   *
   * ⚠️ **Changed once, deliberately, with both preconditions met** (ADR-0047, P-8 Phase 8 slice 5):
   * `analysisSessionId` is served by `tenant_analysis_time` in `services/workflow/src/adapters/
   * indexes.ts`, and the workflow coverage test asserts it. `includeAnalyses` is a **mode** rather
   * than a filter — it selects `{$exists:false}` on the same field that index leads with — so it
   * needs no index of its own and is excluded from the coverage rule for that stated reason.
   */
  it('freezes the filter set', () => {
    expect(Object.keys(IncidentQuery.shape).sort()).toEqual([
      'analysisSessionId',
      'assignee',
      'cameraId',
      'category',
      'correlationId',
      'cursor',
      'eventType',
      'from',
      'includeAnalyses',
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
