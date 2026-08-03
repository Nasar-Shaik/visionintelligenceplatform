/**
 * P-5.2.0 — playback freeze (Architect rec 2).
 *
 * The tests that matter are about **gaps** and **capabilities**: a scrubber that closes up missing
 * footage, and a control that is offered on a source which cannot perform it, are both ways of
 * telling an operator something untrue about the recording in front of them.
 */
import { describe, expect, it } from 'vitest';
import {
  CapturePlaybackSnapshotInput,
  PlaybackAnnotation,
  PlaybackBookmark,
  PlaybackCapabilities,
  PlaybackGapReason,
  PlaybackSession,
  PlaybackSessionQuery,
} from '../src/playback/playback.js';

const session = {
  tenantId: 'tnt_a',
  source: { kind: 'recording' as const, id: 'rec_1', cameraId: 'cam_1' },
  startedAt: '2026-08-03T14:00:00.000Z',
  endedAt: '2026-08-03T14:30:00.000Z',
  durationSeconds: 1800,
  playableSeconds: 1800,
  capabilities: { seek: true, frameStep: true, rates: [1], snapshot: true, export: true },
  derivedAt: '2026-08-03T15:00:00.000Z',
};

describe('PlaybackSession — derived, and honest about what is missing', () => {
  it('parses and defaults its collections', () => {
    const parsed = PlaybackSession.parse(session);
    expect(parsed.segments).toEqual([]);
    expect(parsed.gaps).toEqual([]);
    expect(parsed.markers).toEqual([]);
  });

  /*
   * ⚠️ The reason `playableSeconds` is a separate field from `durationSeconds`. A player that
   * concatenates segments shows 14:00 running into 14:20 and reads as twenty uneventful minutes —
   * when it is in fact twenty minutes with no footage, which is usually what the investigation is
   * about.
   */
  it('⚠️ separates wall-clock span from playable time, so a hole is measurable', () => {
    const parsed = PlaybackSession.parse({
      ...session,
      playableSeconds: 600,
      gaps: [
        {
          startedAt: '2026-08-03T14:10:00.000Z',
          endedAt: '2026-08-03T14:30:00.000Z',
          durationSeconds: 1200,
          offsetSeconds: 600,
          reason: 'no-recording',
          detail: 'camera offline',
        },
      ],
    });
    expect(parsed.durationSeconds - parsed.playableSeconds).toBe(1200);
    expect(parsed.gaps).toHaveLength(1);
  });

  it('names why footage is missing rather than just that it is', () => {
    expect(PlaybackGapReason.options).toEqual([
      'no-recording',
      'purged',
      'forbidden',
      'unavailable',
    ]);
  });

  it('carries no view state — zoom, speed and position are the browser, not the platform', () => {
    const parsed = PlaybackSession.parse(session);
    expect(parsed).not.toHaveProperty('zoom');
    expect(parsed).not.toHaveProperty('rate');
    expect(parsed).not.toHaveProperty('positionSeconds');
  });
});

describe('PlaybackCapabilities — declared per source, never assumed', () => {
  it('requires an explicit rate list, so "normal speed only" is expressible', () => {
    const parsed = PlaybackCapabilities.parse({
      seek: false,
      frameStep: false,
      rates: [1],
      snapshot: false,
      export: false,
    });
    expect(parsed.rates).toEqual([1]);
    expect(parsed.frameStep).toBe(false);
  });

  it('refuses an empty rate list — a player that can play at no speed is not a state', () => {
    expect(
      PlaybackCapabilities.safeParse({
        seek: true,
        frameStep: true,
        rates: [],
        snapshot: true,
        export: true,
      }).success,
    ).toBe(false);
  });

  /* ⚠️ Absent means unknown. Assuming 30fps makes every frame-step calculation quietly wrong. */
  it('leaves frameRate absent rather than defaulting to 30', () => {
    const parsed = PlaybackCapabilities.parse({
      seek: true,
      frameStep: false,
      rates: [1],
      snapshot: true,
      export: false,
    });
    expect(parsed.frameRate).toBeUndefined();
  });
});

describe('Bookmarks and annotations belong to the Incident context', () => {
  it('a bookmark references an incident and a source — it is not part of the footage', () => {
    const parsed = PlaybackBookmark.parse({
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tnt_a',
      incidentId: 'inc_1',
      source: { kind: 'evidence', id: 'ev_1' },
      at: '2026-08-03T14:12:00.000Z',
      label: 'suspect enters frame',
      createdBy: 'usr_1',
      createdAt: '2026-08-03T15:00:00.000Z',
    });
    expect(parsed.incidentId).toBe('inc_1');
  });

  /*
   * ⚠️ Normalised coordinates. Pixel coordinates drift silently the first time an operator reviews
   * a downscaled copy of a 4K stream — the box lands somewhere else and nobody notices.
   */
  it('⚠️ requires normalised [0,1] annotation coordinates', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tnt_a',
      incidentId: 'inc_1',
      source: { kind: 'evidence' as const, id: 'ev_1' },
      at: '2026-08-03T14:12:00.000Z',
      shape: 'box' as const,
      label: 'left bag',
      createdBy: 'usr_1',
      createdAt: '2026-08-03T15:00:00.000Z',
    };
    expect(PlaybackAnnotation.safeParse({ ...base, points: [[0.1, 0.2]] }).success).toBe(true);
    expect(PlaybackAnnotation.safeParse({ ...base, points: [[640, 360]] }).success).toBe(false);
  });
});

describe('Overlays are opt-in, and a snapshot creates evidence', () => {
  it('resolves no overlay unless asked — each one costs an upstream call', () => {
    const parsed = PlaybackSessionQuery.parse({ kind: 'recording', id: 'rec_1' });
    expect(parsed.include).toEqual([]);
  });

  /*
   * ⚠️ "Snapshot export" must not mean "write a frame into the clip it came from". A snapshot is a
   * new evidence record with its own integrity hash and custody log.
   */
  it('⚠️ a snapshot is bound to an incident and defaults to being attached', () => {
    const parsed = CapturePlaybackSnapshotInput.parse({
      source: { kind: 'evidence', id: 'ev_1' },
      at: '2026-08-03T14:12:00.000Z',
      incidentId: 'inc_1',
    });
    expect(parsed.attachToIncident).toBe(true);
    expect(parsed).not.toHaveProperty('evidenceId');
  });
});
