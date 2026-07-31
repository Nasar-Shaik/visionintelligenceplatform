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
