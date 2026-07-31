/**
 * Behavior contract tests (AI-3). Prove the platform-owned BehaviorResult + TrackSnapshot primitives:
 * the lifecycle states, the coarse category, immutable snapshot shape, and business-neutral metrics.
 * The whole point is analyzer-independence — these shapes never mention a specific behavior algorithm.
 */
import { describe, expect, it } from 'vitest';
import {
  BehaviorResult,
  BehaviorState,
  BehaviorCategory,
  TrackSnapshot,
  CompositeBehavior,
  CompositeMetadata,
  BehaviorProfile,
  BehaviorEvidence,
} from '../src/behavior/behavior.js';

const baseBehavior = {
  behaviorId: 'bhv_1',
  behaviorType: 'loitering',
  category: 'security' as const,
  tenantId: 'tnt_a',
  cameraId: 'cam_1',
  zoneId: 'zone_1',
  subjects: ['trk_1'],
  state: 'started' as const,
  confidence: 0.82,
  metrics: { dwellSeconds: 12 },
  firstObserved: '2026-07-31T09:00:00.000Z',
  lastObserved: '2026-07-31T09:00:12.000Z',
  frameIndex: 12,
};

describe('BehaviorResult', () => {
  it('parses a valid result and defaults subjects/metrics/attributes', () => {
    const b = BehaviorResult.parse({ ...baseBehavior, subjects: undefined, metrics: undefined });
    expect(b.behaviorType).toBe('loitering');
    expect(b.category).toBe('security');
    expect(b.subjects).toEqual([]);
    expect(b.metrics).toEqual({});
    expect(b.attributes).toEqual({});
  });

  it('carries business-neutral metrics and the lifecycle window', () => {
    const b = BehaviorResult.parse({ ...baseBehavior, windowMs: 12000, producer: 'loitering' });
    expect(b.metrics.dwellSeconds).toBe(12);
    expect(b.windowMs).toBe(12000);
    expect(b.producer).toBe('loitering');
  });

  it('enumerates the full behavior lifecycle', () => {
    expect(BehaviorState.options).toEqual([
      'detected',
      'started',
      'ongoing',
      'updated',
      'ended',
      'expired',
    ]);
  });

  it('enumerates the reusable categories', () => {
    expect(BehaviorCategory.options).toEqual([
      'security',
      'safety',
      'operational',
      'retail',
      'crowd',
      'compliance',
    ]);
  });

  it('rejects a malformed result', () => {
    expect(() => BehaviorResult.parse({ ...baseBehavior, state: 'nope' })).toThrow();
    expect(() => BehaviorResult.parse({ ...baseBehavior, behaviorId: '' })).toThrow();
    expect(() => BehaviorResult.parse({ ...baseBehavior, category: 'weather' })).toThrow();
  });
});

describe('TrackSnapshot (immutable analyzer input)', () => {
  it('parses a snapshot carrying identity + camera + frame position', () => {
    const s = TrackSnapshot.parse({
      trackId: 'trk_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      sessionId: 'sess_1',
      label: 'person',
      state: 'confirmed',
      confidence: 0.9,
      bbox: [0.1, 0.1, 0.2, 0.3],
      centroid: [0.2, 0.25],
      age: 12,
      hits: 10,
      frameIndex: 12,
      at: '2026-07-31T09:00:01.000Z',
    });
    expect(s.cameraId).toBe('cam_1');
    expect(s.state).toBe('confirmed');
    expect(s.centroid).toEqual([0.2, 0.25]);
  });

  it('rejects a snapshot with a bad track state', () => {
    expect(() =>
      TrackSnapshot.parse({
        trackId: 'trk_1',
        tenantId: 'tnt_a',
        cameraId: 'cam_1',
        label: 'person',
        state: 'nope',
        confidence: 0.9,
        bbox: [0, 0, 0.1, 0.1],
        age: 1,
        hits: 1,
        frameIndex: 1,
        at: '2026-07-31T09:00:01.000Z',
      }),
    ).toThrow();
  });
});

describe('CompositeBehavior + relationships + evidence (AI-4)', () => {
  it('a composite is a BehaviorResult with required composite metadata + relationships', () => {
    const c = CompositeBehavior.parse({
      ...baseBehavior,
      behaviorType: 'cash_anomaly',
      category: 'retail',
      relatedBehaviorIds: ['bhv_1', 'bhv_2'],
      evidence: { contributingTracks: ['trk_1'], contributingZones: ['zone_1'] },
      composite: {
        contributingBehaviorCount: 2,
        evaluationStrategy: 'all_of',
        compositionVersion: '1.0.0',
      },
    });
    expect(c.composite.contributingBehaviorCount).toBe(2);
    expect(c.relatedBehaviorIds).toEqual(['bhv_1', 'bhv_2']);
    expect(c.evidence?.contributingZones).toEqual(['zone_1']);
  });

  it('rejects a composite missing composite metadata', () => {
    expect(() => CompositeBehavior.parse(baseBehavior)).toThrow();
  });

  it('evidence keeps supportingFrames/Detections reserved (optional)', () => {
    const e = BehaviorEvidence.parse({ contributingTracks: ['trk_1'] });
    expect(e.supportingFrames).toBeUndefined();
    expect(
      CompositeMetadata.parse({ contributingBehaviorCount: 0 }).contributingBehaviorCount,
    ).toBe(0);
  });
});

describe('BehaviorProfile (declarative, portable — AI-4)', () => {
  it('parses a profile with analyzers, composites, and confidence strategy defaults', () => {
    const p = BehaviorProfile.parse({
      profile: 'retail',
      analyzers: { queue: { enabled: true, customParameters: { minQueue: 3 } } },
      composites: [
        {
          name: 'cash_anomaly',
          behaviorType: 'cash_anomaly',
          category: 'retail',
          eventType: 'behavior.theft.suspected',
          requiredTypes: ['loitering'],
          zoneRole: 'cash',
        },
      ],
    });
    expect(p.version).toBe('1.0.0');
    expect(p.composites[0].groupBy).toBe('subject');
    expect(p.composites[0].confidenceStrategy).toBe('min');
    expect(p.composites[0].strategy).toBe('all_of');
  });

  it('rejects a composite rule with no required types', () => {
    expect(() =>
      BehaviorProfile.parse({
        profile: 'bad',
        composites: [
          {
            name: 'x',
            behaviorType: 'x',
            category: 'retail',
            eventType: 'behavior.theft.suspected',
            requiredTypes: [],
          },
        ],
      }),
    ).toThrow();
  });
});
