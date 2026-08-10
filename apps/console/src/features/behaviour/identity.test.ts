import { describe, expect, it } from 'vitest';
import { BehaviourStepKind } from '@vip/contracts';
import type { AnalysisTimeline, BehaviourTimelineEntry, TrackHistoryRecordView } from '@vip/contracts';
import { detectionConfidence, incidentsForIdentity, summariseIdentity, zonesOf } from './identity';
import { STEP_KINDS } from './vocabulary';

const entry = (
  kind: string,
  identityId: string,
  atSeconds: number,
  seconds?: number,
): BehaviourTimelineEntry => ({
  kind,
  identityId,
  atSeconds,
  footageSeconds: 1_000_000 + atSeconds,
  cameraId: 'cam_1',
  summary: `${kind} for ${identityId}`,
  attributes: {},
  evidence: { frameIndex: Math.round(atSeconds), trackId: identityId },
  ...(seconds === undefined ? {} : { seconds, endSeconds: atSeconds + seconds }),
});

describe('attributing incidents to an identity', () => {
  const timeline = {
    entries: [
      { eventId: 'ev_1', trackId: 'trk_a' },
      { eventId: 'ev_2', trackId: 'trk_b' },
      { eventId: 'ev_3' }, // an event with no track
    ],
    incidents: [
      { incidentId: 'inc_1', triggeredByEventId: 'ev_1' },
      { incidentId: 'inc_2', triggeredByEventId: 'ev_2' },
      { incidentId: 'inc_3', triggeredByEventId: 'ev_3' },
      { incidentId: 'inc_4' }, // no trigger recorded at all
    ],
  } as unknown as AnalysisTimeline;

  it('attaches an incident whose stored trigger resolves to one of the identity’s tracks', () => {
    const result = incidentsForIdentity(timeline, ['trk_a']);
    expect(result.attributed.map((i) => i.incidentId)).toEqual(['inc_1']);
  });

  /**
   * ⛔ The join this module refuses to make. On a recording with one person, matching an incident to
   * whoever was in shot at the time is right every time — which is exactly what makes it dangerous.
   */
  it('never attaches an incident on time alone', () => {
    const result = incidentsForIdentity(timeline, ['trk_a']);
    expect(result.attributed.map((i) => i.incidentId)).not.toContain('inc_3');
    expect(result.attributed.map((i) => i.incidentId)).not.toContain('inc_4');
  });

  /** ⚠️ Counted, so "nothing attributed" is never read as "this person caused nothing". */
  it('counts incidents whose link was never recorded', () => {
    expect(incidentsForIdentity(timeline, ['trk_a']).unattributable).toBe(2);
  });

  it('answers for a missing timeline without throwing', () => {
    expect(incidentsForIdentity(undefined, ['trk_a'])).toEqual({ attributed: [], unattributable: 0 });
  });
});

describe('summarising what one identity did', () => {
  const entries = [
    entry('linger', 'i1', 1, 20),
    entry('linger', 'i1', 40, 15),
    entry('zoneEntry', 'i1', 2),
    entry('linger', 'i2', 3, 99),
  ];

  it('counts and sums only the named subject', () => {
    const summary = summariseIdentity(entries, 'i1');
    expect(summary.find((f) => f.kind === 'linger')).toEqual({ kind: 'linger', count: 2, seconds: 35 });
  });

  /** ⛔ `undefined`, not 0: an instant has no length, and "0.0 s" reads as "immediately". */
  it('reports no duration for a kind that carries none', () => {
    expect(summariseIdentity(entries, 'i1').find((f) => f.kind === 'zoneEntry')?.seconds).toBeUndefined();
  });

  it('orders by how often each thing happened', () => {
    expect(summariseIdentity(entries, 'i1')[0]!.kind).toBe('linger');
  });
});

describe('zone membership from stored observations', () => {
  const record = {
    identityId: 'i1',
    tenantId: 't',
    cameraId: 'cam_1',
    label: 'person',
    trackIds: ['trk_a'],
    closed: true,
    /*
     * ⛔ **The wire shape, exactly as the runtime emits it.** `zoneIds` is OMITTED when membership
     * was never decided and `[]` when something decided "inside none". There is no `zonesSettled`
     * field on the wire at all — a fixture that invented one is what let the first version of
     * `zonesOf` report every observation as undecided against a working deployment.
     */
    points: [
      { frameIndex: 1, at: '1.0s', bbox: [0, 0, 0.1, 0.1], trackId: 'trk_a', label: 'person', confidence: 0.9, zoneIds: ['z_a'] },
      { frameIndex: 2, at: '2.0s', bbox: [0, 0, 0.1, 0.1], trackId: 'trk_a', label: 'person', confidence: 0.7, zoneIds: ['z_a'] },
      { frameIndex: 3, at: '3.0s', bbox: [0, 0, 0.1, 0.1], trackId: 'trk_a', label: 'person', confidence: 0.5 },
    ],
  } as unknown as TrackHistoryRecordView;

  it('tallies settled memberships', () => {
    expect(zonesOf(record).zones).toEqual([{ zoneId: 'z_a', observations: 2 }]);
  });

  /**
   * ⛔ Undecided is not "outside". A visit walks consecutive points, and an undecided point read as
   * outside ends a visit that never ended.
   */
  it('separates undecided observations from decided ones', () => {
    expect(zonesOf(record).settledPoints).toBe(2);
    expect(zonesOf(record).unsettledPoints).toBe(1);
  });

  /**
   * ⛔ The regression this test exists for. `zoneIds: []` means "something decided, and the answer
   * was inside none" — a SETTLED observation. Counting it as undecided would understate how much of
   * the run had membership resolved, on exactly the deployments where zones work.
   */
  it('counts an empty zone list as decided, not as undecided', () => {
    const decidedEmpty = {
      points: [{ frameIndex: 1, at: '1.0s', bbox: [0, 0, 0.1, 0.1], trackId: 'trk_a', confidence: 1, zoneIds: [] }],
    } as unknown as TrackHistoryRecordView;
    expect(zonesOf(decidedEmpty)).toEqual({ zones: [], settledPoints: 1, unsettledPoints: 0 });
  });

  it('answers for no record at all', () => {
    expect(zonesOf(undefined)).toEqual({ zones: [], settledPoints: 0, unsettledPoints: 0 });
  });
});

describe('detector confidence', () => {
  it('reports the range across the observations', () => {
    const record = {
      points: [
        { confidence: 0.5 },
        { confidence: 0.9 },
        { confidence: 0.7 },
      ],
    } as unknown as TrackHistoryRecordView;
    const result = detectionConfidence(record)!;
    expect(result.min).toBe(0.5);
    expect(result.max).toBe(0.9);
    expect(result.mean).toBeCloseTo(0.7, 6);
  });

  /** ⛔ `null`, never 0 — an unobserved subject has not been seen badly, it has not been seen. */
  it('returns null when nothing was observed', () => {
    expect(detectionConfidence(undefined)).toBeNull();
    expect(detectionConfidence({ points: [] } as unknown as TrackHistoryRecordView)).toBeNull();
  });
});

describe('the composer offers only steps the service accepts', () => {
  /**
   * ⛔ A step an operator can compose and the service will reject is a dead end reached after the
   * work of composing it. The contract enum is the authority; this list is only an order.
   */
  it('every offered step kind is a member of BehaviourStepKind', () => {
    const legal = new Set(BehaviourStepKind.options);
    for (const kind of STEP_KINDS) expect(legal.has(kind)).toBe(true);
  });
});
