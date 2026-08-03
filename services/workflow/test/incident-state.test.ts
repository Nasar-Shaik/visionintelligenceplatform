import { describe, expect, it } from 'vitest';
import { canApply } from '../src/domain/incident-state.js';
import { applyTransition, promoteFromCandidate } from '../src/domain/incident-factory.js';
import { personCandidate } from './helpers.js';

const deps = {
  now: () => new Date('2026-07-29T23:00:00.000Z'),
  newId: () => 'inc_1',
};

describe('incident state machine', () => {
  it('allows the legal path raised → acknowledged → resolved → closed', () => {
    expect(canApply('acknowledge', 'raised')).toBe(true);
    expect(canApply('resolve', 'acknowledged')).toBe(true);
    expect(canApply('resolve', 'raised')).toBe(true); // may resolve straight from raised
    expect(canApply('close', 'resolved')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canApply('acknowledge', 'resolved')).toBe(false);
    expect(canApply('close', 'raised')).toBe(false);
    expect(canApply('close', 'acknowledged')).toBe(false);
    expect(canApply('resolve', 'closed')).toBe(false);
  });
});

describe('promoteFromCandidate', () => {
  it('builds a version-1 raised incident with an end-to-end correlationId (rec 1)', () => {
    const incident = promoteFromCandidate(personCandidate(), deps);
    expect(incident).toMatchObject({
      id: 'inc_1',
      status: 'raised',
      version: 1,
      severity: 'critical',
      correlationId: 'corr-abc',
      causationId: '22222222-2222-4222-8222-222222222222',
      matchedCount: 1,
      triggeredBy: { cameraId: 'cam_1', zoneId: 'zone_1' },
    });
    expect(incident.source.dedupKey).toBe('tnt_a|rule_1|-|123');
    // The promoter records itself as the platform (P-5.1, F-2) — so a reader can tell "the system
    // raised this" from "someone called system did", which a bare `by` string never could.
    expect(incident.history).toEqual([
      {
        from: null,
        to: 'raised',
        at: '2026-07-29T23:00:00.000Z',
        by: 'system',
        actor: { kind: 'system', id: 'system' },
      },
    ]);
  });

  it('anchors correlationId to the triggering event id when the candidate has none', () => {
    const candidate = personCandidate();
    delete (candidate as { correlationId?: string }).correlationId;
    const incident = promoteFromCandidate(candidate, deps);
    expect(incident.correlationId).toBe('33333333-3333-4333-8333-333333333333');
  });
});

describe('applyTransition', () => {
  it('acknowledge bumps version, sets ackedBy/At, appends history', () => {
    const raised = promoteFromCandidate(personCandidate(), deps);
    const acked = applyTransition(raised, 'acknowledge', { by: 'usr_op', note: 'on it' }, deps);
    expect(acked.status).toBe('acknowledged');
    expect(acked.version).toBe(2);
    expect(acked.acknowledgedBy).toBe('usr_op');
    expect(acked.acknowledgedAt).toBe('2026-07-29T23:00:00.000Z');
    expect(acked.history.at(-1)).toMatchObject({
      from: 'raised',
      to: 'acknowledged',
      note: 'on it',
    });
  });

  it('resolve records the resolution note', () => {
    const raised = promoteFromCandidate(personCandidate(), deps);
    const resolved = applyTransition(
      raised,
      'resolve',
      { by: 'usr_op', resolution: 'false alarm' },
      deps,
    );
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('false alarm');
    expect(resolved.resolvedBy).toBe('usr_op');
  });
});
