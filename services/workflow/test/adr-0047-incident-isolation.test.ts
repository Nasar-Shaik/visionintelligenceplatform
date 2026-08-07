/**
 * ADR-0047 extended to incidents (P-8 Phase 8, slice 5).
 *
 * ⛔ **The live queue is a work list.** An incident replayed out of six-week-old footage is a real
 * finding and is *not* something anybody is dispatched to now. Keeping those out by default is the
 * difference between a useful investigation feature and one that makes the queue untrustworthy — so
 * the isolation is asserted here rather than left to each caller to remember.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { IncidentQuery, type Incident, type IncidentCandidate } from '@vip/contracts';
import { InMemoryIncidentStore } from '../src/adapters/in-memory-incident-store.js';
import { promoteFromCandidate } from '../src/domain/incident-factory.js';

const scope = TenantScope.fromTenantId('tnt_a');
const NOW = new Date('2026-08-07T12:00:00.000Z');

function candidate(over: { id: string; analysisSessionId?: string }): IncidentCandidate {
  return {
    id: `00000000-0000-4000-8000-${over.id.padStart(12, '0')}`,
    tenantId: 'tnt_a',
    ruleId: 'rul_1',
    ruleName: 'Loitering at the door',
    ruleVersion: 1,
    severity: 'warning',
    category: 'perception',
    triggeredBy: {
      eventId: `00000000-0000-4000-9000-${over.id.padStart(12, '0')}`,
      eventType: 'perception.person.detected',
      cameraId: 'cam_1',
      occurredAt: '2026-02-14T18:30:10.000Z',
    },
    matchedCount: 1,
    dedupKey: `dk_${over.id}`,
    at: NOW.toISOString(),
    status: 'candidate',
    evidence: [],
    dryRun: false,
    ...(over.analysisSessionId === undefined
      ? {}
      : { analysisSessionId: over.analysisSessionId }),
  } as IncidentCandidate;
}

const deps = { now: () => NOW, newId: (() => { let n = 100; return () => `00000000-0000-4000-a000-${String(++n).padStart(12, '0')}`; })() };

const query = (over: Record<string, unknown> = {}) => IncidentQuery.parse(over);

async function seeded(): Promise<InMemoryIncidentStore> {
  const store = new InMemoryIncidentStore();
  const live = promoteFromCandidate(candidate({ id: '1' }), deps);
  const runA = promoteFromCandidate(candidate({ id: '2', analysisSessionId: 'ases_A' }), deps);
  const runB = promoteFromCandidate(candidate({ id: '3', analysisSessionId: 'ases_B' }), deps);
  for (const incident of [live, runA, runB]) await store.insert(scope, incident);
  return store;
}

describe('⭐ the analysis run travels from candidate to incident', () => {
  it('carries it through promotion', () => {
    const incident = promoteFromCandidate(
      candidate({ id: '9', analysisSessionId: 'ases_A' }),
      deps,
    );
    expect(incident.analysisSessionId).toBe('ases_A');
  });

  /**
   * ⛔ **No fallback, unlike `correlationId`.** That anchors to the event id when absent so the
   * chain is never broken; an absent run means the incident is **live**, and inventing one would
   * hide a real incident from the queue an operator works from.
   */
  it('leaves it absent for a live incident rather than inventing one', () => {
    const incident = promoteFromCandidate(candidate({ id: '8' }), deps);
    expect(incident.analysisSessionId).toBeUndefined();
    /* …while the correlation chain IS anchored, as it always was. */
    expect(incident.correlationId).toBe(candidate({ id: '8' }).triggeredBy.eventId);
  });
});

describe('⛔ the live queue excludes offline findings by default', () => {
  /**
   * ⭐ **The assertion that makes the queue trustworthy.** Every caller written before offline
   * analysis existed asks "what needs attention", with no knowledge that a replay can raise
   * incidents. If the default included them, an investigation of last month's footage would land in
   * an operator's work list with no change to any caller.
   */
  it('an unfiltered queue read returns only live incidents', async () => {
    const store = await seeded();
    const page = await store.list(scope, query());

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.analysisSessionId).toBeUndefined();
  });

  it('returns everything only when the caller asks for it', async () => {
    const store = await seeded();
    expect((await store.list(scope, query({ includeAnalyses: true }))).items).toHaveLength(3);
  });

  it('returns one run when that run is named, without needing the flag', async () => {
    const store = await seeded();
    const a = await store.list(scope, query({ analysisSessionId: 'ases_A' }));
    const b = await store.list(scope, query({ analysisSessionId: 'ases_B' }));

    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    expect(a.items[0]?.analysisSessionId).toBe('ases_A');
    expect(b.items[0]?.analysisSessionId).toBe('ases_B');
    expect(a.items[0]?.id).not.toBe(b.items[0]?.id);
  });

  /**
   * ⚠️ **Isolation must not swallow a live incident on the same camera.** An analysis of `cam_1`'s
   * footage and a live `cam_1` incident coexist; filtering by camera still shows the live one.
   */
  it('a camera filter still finds the live incident on an analysed camera', async () => {
    const store = await seeded();
    const page = await store.list(scope, query({ cameraId: 'cam_1' }));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.analysisSessionId).toBeUndefined();
  });

  /** ⚠️ Two runs of one recording never merge — the same guarantee ADR-0047 gives events. */
  it('keeps two runs separate', async () => {
    const store = await seeded();
    const all = await store.list(scope, query({ includeAnalyses: true }));
    const runs = all.items.map((i) => i.analysisSessionId).filter((s) => s !== undefined);
    expect(new Set(runs).size).toBe(2);
  });
});
