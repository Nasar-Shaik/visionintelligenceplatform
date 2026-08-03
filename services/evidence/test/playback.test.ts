/**
 * Playback session resolution (P-5.5).
 *
 * Every test here pins an **honesty** invariant rather than a happy path: a capability the media
 * cannot perform must not be advertised, a still frame must not pretend to have a duration, an
 * unavailable item must say why rather than 404, and watching evidence must appear in its chain of
 * custody.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RegisterEvidenceInput } from '@vip/contracts';
import { PlaybackSession } from '@vip/contracts';
import { capabilitiesFor } from '../src/domain/playback.js';
import { buildHarness, type Harness } from './helpers.js';

const A = 'tnt_a';
const B = 'tnt_b';

async function registerClip(h: Harness, overrides: Partial<RegisterEvidenceInput> = {}) {
  const key = await h.putObject(A, 'cam_1/evidence/clip.mp4', 'VIDEOBYTES', 'video/mp4');
  const input: RegisterEvidenceInput = {
    kind: 'clip',
    storageKey: key,
    contentType: 'video/mp4',
    codec: 'h264',
    capturedAt: '2026-07-30T09:00:00.000Z',
    interval: {
      startedAt: '2026-07-30T09:00:00.000Z',
      endedAt: '2026-07-30T09:00:30.000Z',
      durationSeconds: 30,
    },
    source: { incidentId: 'inc_1', eventId: 'evt_1', correlationId: 'corr-1', cameraId: 'cam_1' },
    ...overrides,
  };
  return h.service.register(h.scope(A), 'usr_1', input);
}

async function registerSnapshot(h: Harness) {
  const key = await h.putObject(A, 'cam_1/evidence/shot.jpg', 'PIXELS', 'image/jpeg');
  return h.service.register(h.scope(A), 'usr_1', {
    kind: 'snapshot',
    storageKey: key,
    contentType: 'image/jpeg',
    capturedAt: '2026-07-30T09:00:00.000Z',
    source: { incidentId: 'inc_1', eventId: 'evt_1', correlationId: 'corr-1', cameraId: 'cam_1' },
  });
}

describe('playback session', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
  });

  it('resolves a clip into a contract-valid session with one segment and a signed URL', async () => {
    const evidence = await registerClip(h);
    const session = await h.service.playbackSession(h.scope(A), evidence.id, 'usr_1');

    /* ⚠️ Parsed, not merely shaped: the route returns this to a browser. */
    expect(PlaybackSession.safeParse(session).success).toBe(true);
    expect(session.segments).toHaveLength(1);
    expect(session.segments[0]?.url).toContain('signed://');
    expect(session.segments[0]?.expiresInSeconds).toBe(900);
    expect(session.durationSeconds).toBe(30);
    expect(session.source).toEqual({ kind: 'evidence', id: evidence.id });
  });

  it('⚠️ reports no gaps because one stored object is genuinely continuous', () => {
    /* Empty here is a fact about the item, not a shrug — see the domain note. */
    expect.assertions(1);
    return registerClip(h)
      .then((e) => h.service.playbackSession(h.scope(A), e.id, 'usr_1'))
      .then((session) => {
        expect(session.gaps).toEqual([]);
      });
  });

  it('⚠️ gives a snapshot zero duration — a still must not draw a draggable scrubber', async () => {
    const evidence = await registerSnapshot(h);
    const session = await h.service.playbackSession(h.scope(A), evidence.id, 'usr_1');
    expect(session.durationSeconds).toBe(0);
    expect(session.playableSeconds).toBe(0);
    /* It still gets a segment: the viewer needs the signed URL to show the image. */
    expect(session.segments).toHaveLength(1);
    expect(session.segments[0]?.durationSeconds).toBe(0);
  });

  it('⚠️ never advertises a capability the media cannot perform', async () => {
    const clip = await registerClip(h);
    const still = await registerSnapshot(h);

    const clipCaps = capabilitiesFor(clip);
    expect(clipCaps.seek).toBe(true);
    expect(clipCaps.frameStep).toBe(true);
    expect(clipCaps.rates.length).toBeGreaterThan(1);

    const stillCaps = capabilitiesFor(still);
    expect(stillCaps.seek).toBe(false);
    expect(stillCaps.frameStep).toBe(false);
    /* A still has exactly one "rate": itself. */
    expect(stillCaps.rates).toEqual([1]);

    /* ⚠️ Neither exists in this build, so neither is offered on anything. */
    for (const caps of [clipCaps, stillCaps]) {
      expect(caps.snapshot).toBe(false);
      expect(caps.export).toBe(false);
    }
  });

  it('⚠️ refuses frame stepping on a clip whose codec nobody declared', async () => {
    const key = await h.putObject(A, 'cam_2/evidence/unknown.mp4', 'BYTES', 'video/mp4');
    const evidence = await h.service.register(h.scope(A), 'usr_1', {
      kind: 'clip',
      storageKey: key,
      contentType: 'video/mp4',
      capturedAt: '2026-07-30T09:00:00.000Z',
      interval: {
        startedAt: '2026-07-30T09:00:00.000Z',
        endedAt: '2026-07-30T09:00:10.000Z',
        durationSeconds: 10,
      },
      source: { incidentId: 'inc_1', eventId: 'evt_1', correlationId: 'corr-1', cameraId: 'cam_2' },
    });
    const caps = capabilitiesFor(evidence);
    expect(caps.seek).toBe(true);
    /* Seekable is knowable; keyframe-dense is not. */
    expect(caps.frameStep).toBe(false);
  });

  it('⚠️ records playback in the chain of custody, distinguishable from a download', async () => {
    const evidence = await registerClip(h);
    await h.service.playbackSession(h.scope(A), evidence.id, 'usr_7', 'reviewing incident inc_1');

    const custody = await h.service.listCustody(h.scope(A), evidence.id, { limit: 50 });
    const accessed = custody.items.filter((entry) => entry.action === 'accessed');
    expect(accessed).toHaveLength(1);
    expect(accessed[0]?.actor).toBe('usr_7');
    expect(accessed[0]?.reason).toBe('reviewing incident inc_1');
    expect(accessed[0]?.details).toMatchObject({ via: 'playback' });

    /* A download of the same item is a separate, differently-labelled access. */
    await h.service.download(h.scope(A), evidence.id, 'usr_7');
    const after = await h.service.listCustody(h.scope(A), evidence.id, { limit: 50 });
    const vias = after.items
      .filter((entry) => entry.action === 'accessed')
      .map((entry) => (entry.details as { via?: string } | undefined)?.via);
    expect(vias).toEqual(['playback', 'signed-url']);
  });

  it('keeps the custody chain verifiable after a playback access', async () => {
    const evidence = await registerClip(h);
    await h.service.playbackSession(h.scope(A), evidence.id, 'usr_1');
    expect(await h.service.verifyCustody(h.scope(A), evidence.id)).toBe(true);
  });

  it('⚠️ says an unavailable item is unavailable rather than missing', async () => {
    const evidence = await registerClip(h);
    await h.store.patch(h.scope(A), evidence.id, { status: 'purged' });
    await expect(h.service.playbackSession(h.scope(A), evidence.id, 'usr_1')).rejects.toThrow(
      /not available/,
    );
  });

  it('is fail-closed across tenants — another tenant sees a 404, not a session', async () => {
    const evidence = await registerClip(h);
    await expect(h.service.playbackSession(h.scope(B), evidence.id, 'usr_1')).rejects.toThrow(
      /not found/,
    );
  });
});
