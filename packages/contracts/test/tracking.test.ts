/**
 * Tracking + zone contract tests (AI-2). Prove the platform-owned Track/Zone primitives: lifecycle
 * states, bounded history, additive quality, generic zone geometry, and that a Track is distinct from
 * a Detection (continuous identity vs single observation). The whole point is tracker-independence —
 * these shapes never mention a specific engine.
 */
import { describe, expect, it } from 'vitest';
import {
  Track,
  TrackState,
  TrackQuality,
  Zone,
  ZoneKind,
  ZoneTransition,
  CountingSnapshot,
  TRACK_SCHEMA_VERSION,
  TrackDetail,
  TrackingStats,
} from '../src/tracking/tracking.js';

const baseTrack = {
  trackId: 'trk_1',
  tenantId: 'tnt_a',
  cameraId: 'cam_1',
  label: 'person',
  state: 'confirmed' as const,
  confidence: 0.9,
  bbox: [0.1, 0.1, 0.2, 0.3] as [number, number, number, number],
  firstSeen: { frameIndex: 0, at: '2026-07-31T09:00:00.000Z' },
  lastSeen: { frameIndex: 12, at: '2026-07-31T09:00:01.000Z' },
  age: 12,
  hits: 10,
};

describe('Track', () => {
  it('parses a valid track and defaults quality/history/attributes', () => {
    const t = Track.parse(baseTrack);
    expect(t.state).toBe('confirmed');
    expect(t.history).toEqual([]);
    expect(t.quality).toEqual({});
    expect(t.attributes).toEqual({});
  });

  it('carries cameraId (multi-camera identity) and a bounded history', () => {
    const t = Track.parse({
      ...baseTrack,
      history: [{ frameIndex: 11, at: '2026-07-31T09:00:00.900Z', bbox: [0.1, 0.1, 0.2, 0.3] }],
      quality: { trackingConfidence: 0.8, predictionFrames: 1, lostFrames: 0 },
    });
    expect(t.cameraId).toBe('cam_1');
    expect(t.history).toHaveLength(1);
    expect(t.quality.trackingConfidence).toBe(0.8);
  });

  it('enumerates the full lifecycle', () => {
    expect(TrackState.options).toEqual(['created', 'tentative', 'confirmed', 'lost', 'removed']);
  });

  it('rejects a malformed track', () => {
    expect(() => Track.parse({ ...baseTrack, state: 'nope' })).toThrow();
    expect(() => Track.parse({ ...baseTrack, trackId: '' })).toThrow();
  });
});

describe('Zone (pure geometry)', () => {
  it('parses an area + a line zone with generic attributes', () => {
    const area = Zone.parse({
      id: 'zone_1',
      cameraId: 'cam_1',
      name: 'entrance',
      kind: 'area',
      geometry: {
        points: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
      attributes: { purpose: 'entrance' },
    });
    expect(area.kind).toBe('area');
    expect(area.attributes.purpose).toBe('entrance');
    expect(ZoneKind.options).toEqual(['area', 'line']);
  });

  it('requires at least two geometry points', () => {
    expect(() =>
      Zone.parse({
        id: 'z',
        cameraId: 'c',
        name: 'n',
        kind: 'line',
        geometry: { points: [[0, 0]] },
      }),
    ).toThrow();
  });
});

describe('ZoneTransition + CountingSnapshot', () => {
  it('models a confirmed-track crossing with additive event confidence', () => {
    const tr = ZoneTransition.parse({
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      zoneId: 'zone_1',
      trackId: 'trk_1',
      transition: 'entered',
      frameIndex: 5,
      at: '2026-07-31T09:00:00.500Z',
      confidence: 0.85,
    });
    expect(tr.transition).toBe('entered');
    expect(tr.confidence).toBe(0.85);
  });

  it('models business-neutral counting', () => {
    const c = CountingSnapshot.parse({
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      zoneId: 'zone_1',
      entered: 3,
      exited: 1,
      occupancy: 2,
      at: '2026-07-31T09:00:02.000Z',
    });
    expect(c.occupancy).toBe(2);
  });
});

/**
 * P-8 Phase 4 — the additive evolution of a FROZEN contract.
 *
 * ⚠️ The first test here is the one that matters. `Track` is frozen under ED-0039, so the question
 * is not "do the new fields work" but "does a document written before they existed still parse".
 */
describe('Track — P-8 Phase 4 additions', () => {
  it('⚠️ still parses a v1.0 track that has none of the new fields', () => {
    const t = Track.parse(baseTrack);
    expect(t.motion).toBeUndefined();
    expect(t.identityId).toBeUndefined();
    expect(t.precededBy).toBeUndefined();
    expect(t.recoveries).toBeUndefined();
    expect(t.schemaVersion).toBeUndefined();
  });

  it('carries motion in normalized units with a bounded sample count', () => {
    const t = Track.parse({
      ...baseTrack,
      schemaVersion: TRACK_SCHEMA_VERSION,
      motion: {
        durationSeconds: 4,
        pathLengthNormalized: 0.4,
        displacementNormalized: 0.38,
        averageSpeedNormalized: 0.1,
        currentSpeedNormalized: 0.12,
        headingDegrees: 0,
        headingLabel: 'right',
        dwellSeconds: 0.5,
        straightness: 0.95,
        samples: 20,
      },
    });
    expect(t.motion?.headingLabel).toBe('right');
    /* ⚠️ The sample count is what tells a consumer the path is the RECENT past, not the whole life. */
    expect(t.motion?.samples).toBe(20);
  });

  it('⚠️ rejects a heading of 360 — it is the same direction as 0 and would sort differently', () => {
    const motion = {
      durationSeconds: 1,
      pathLengthNormalized: 0.1,
      displacementNormalized: 0.1,
      averageSpeedNormalized: 0.1,
      currentSpeedNormalized: 0.1,
      dwellSeconds: 0,
      samples: 2,
    };
    expect(() =>
      Track.parse({ ...baseTrack, motion: { ...motion, headingDegrees: 360 } }),
    ).toThrow();
    expect(
      Track.parse({ ...baseTrack, motion: { ...motion, headingDegrees: 359.9 } }).motion,
    ).toBeDefined();
  });

  it('⚠️ links a re-entry rather than reusing the id — both tracks keep their own trackId', () => {
    const first = Track.parse({
      ...baseTrack,
      trackId: 'trk_1',
      identityId: 'trk_1',
      recoveries: 0,
    });
    const returned = Track.parse({
      ...baseTrack,
      trackId: 'trk_7',
      identityId: 'trk_1',
      precededBy: 'trk_1',
      recoveries: 1,
    });
    expect(returned.trackId).not.toBe(first.trackId);
    expect(returned.identityId).toBe(first.identityId);
    expect(returned.precededBy).toBe('trk_1');
  });
});

describe('TrackDetail + TrackTimelineEntry', () => {
  it('records the lifecycle including the states nobody wants to see', () => {
    const detail = TrackDetail.parse({
      track: baseTrack,
      timeline: [
        { frameIndex: 0, at: '2026-07-31T09:00:00.000Z', from: null, to: 'created' },
        { frameIndex: 3, at: '2026-07-31T09:00:00.300Z', from: 'created', to: 'confirmed' },
        { frameIndex: 9, at: '2026-07-31T09:00:00.900Z', from: 'confirmed', to: 'lost' },
        {
          frameIndex: 12,
          at: '2026-07-31T09:00:01.000Z',
          from: 'lost',
          to: 'confirmed',
          reason: 're-entry',
        },
      ],
    });
    expect(detail.timeline).toHaveLength(4);
    /* ⚠️ The `lost` entry survives the recovery. A timeline that smoothed the gap would answer
     * "was this the same person throughout?" wrongly, and with total confidence. */
    expect(detail.timeline.map((e) => e.to)).toContain('lost');
  });

  it('defaults an empty timeline rather than requiring one', () => {
    expect(TrackDetail.parse({ track: baseTrack }).timeline).toEqual([]);
  });
});

describe('TrackingStats', () => {
  it('⚠️ allows null for every derived average — "nothing tracked" is not "0.0"', () => {
    const s = TrackingStats.parse({
      camerasTracked: 0,
      activeTracks: 0,
      confirmedTracks: 0,
      tentativeTracks: 0,
      lostTracks: 0,
      removedTracks: 0,
      createdTracks: 0,
      recoveredTracks: 0,
      framesTracked: 0,
      averageTrackingMs: null,
      averageTrackLifetimeSeconds: null,
      averageTrackHits: null,
      fragmentation: null,
    });
    expect(s.fragmentation).toBeNull();
  });
});
