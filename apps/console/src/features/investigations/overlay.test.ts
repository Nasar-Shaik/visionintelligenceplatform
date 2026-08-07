/**
 * Which stored box belongs on screen, and when (P-8.6).
 *
 * ⛔ **Every failure this file guards against renders perfectly.** A box drawn from the wrong frame,
 * attached to the wrong track, or held across an instant nothing was measured in all look exactly
 * like a working overlay — and all three would let a customer draw a conclusion about a person from
 * a rectangle the platform never put there.
 */
import { describe, expect, it } from 'vitest';
import type { AnalysisTimeline } from '@vip/contracts';
import {
  OVERLAY_SAMPLE_MS,
  analysedInstants,
  boxesAt,
  nearestFrame,
  overlayStatus,
  shortTrack,
  toleranceFor,
} from './overlay';

type Entry = AnalysisTimeline['entries'][number];

function entry(over: Partial<Entry> & { offsetSeconds: number }): Entry {
  return {
    eventId: `ev_${String(over.offsetSeconds)}_${over.trackId ?? 'x'}`,
    type: 'perception.person.detected',
    occurredAt: new Date(Date.parse('2021-12-22T20:18:44.000Z') + over.offsetSeconds * 1000).toISOString(),
    label: 'person',
    confidence: 0.8,
    ...over,
  } as Entry;
}

describe('toleranceFor', () => {
  /** ⚠️ Half a sample interval: at 2 fps a frame "owns" ±0.25 s and no more. */
  it('is half a sample interval', () => {
    expect(toleranceFor(2)).toBe(0.25);
    expect(toleranceFor(1)).toBe(0.5);
  });

  /**
   * ⚠️ Floored at 0.25 s. A fast run would otherwise make the window narrower than the interval
   * between `timeupdate` events (~4/s in most browsers), and the boxes would be unreachable.
   */
  it('never narrows below a quarter second', () => {
    expect(toleranceFor(30)).toBe(0.25);
  });

  /** ⚠️ Total. A frame rate of 0 or NaN must not produce an infinite or negative window. */
  it('is total for a nonsense frame rate', () => {
    expect(toleranceFor(0)).toBe(0.25);
    expect(toleranceFor(Number.NaN)).toBe(0.25);
    expect(toleranceFor(-5)).toBe(0.25);
  });
});

describe('nearestFrame', () => {
  const entries = [
    entry({ offsetSeconds: 0, trackId: 'trk_1' }),
    entry({ offsetSeconds: 0, trackId: 'trk_2' }),
    entry({ offsetSeconds: 6, trackId: 'trk_1' }),
    entry({ offsetSeconds: 16, trackId: 'trk_3' }),
  ];

  /**
   * ⛔ **Two subjects in one frame come back together.** Returning only the single closest entry
   * would draw one person and silently omit the other standing beside them — which reads as "the
   * platform saw one person" and is a different, wrong answer.
   */
  it('returns every entry recorded at the nearest instant', () => {
    const sample = nearestFrame(entries, 0.1);
    expect(sample?.offsetSeconds).toBe(0);
    expect(sample?.entries).toHaveLength(2);
    expect(sample?.deltaSeconds).toBeCloseTo(0.1);
  });

  it('picks the closer of two instants either side', () => {
    expect(nearestFrame(entries, 5)?.offsetSeconds).toBe(6);
    expect(nearestFrame(entries, 2)?.offsetSeconds).toBe(0);
  });

  it('is undefined when nothing was stored', () => {
    expect(nearestFrame([], 3)).toBeUndefined();
  });
});

describe('boxesAt', () => {
  const entries = [
    entry({ offsetSeconds: 0, trackId: 'trk_a_1', bbox: [0.1, 0.2, 0.3, 0.4] }),
    entry({ offsetSeconds: 0, trackId: 'trk_a_2', bbox: [0.5, 0.5, 0.1, 0.1] }),
    entry({ offsetSeconds: 16, trackId: 'trk_a_3', bbox: [0.7, 0.1, 0.2, 0.2] }),
  ];

  it('draws every box stored at the current instant', () => {
    const { boxes, inFrame } = boxesAt(entries, 0, 2);
    expect(inFrame).toBe(true);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  /**
   * ⛔ **The whole point of the tolerance.** At 8 s nothing was analysed — the nearest stored frame
   * is 8 s away. Drawing its boxes there would place a person where the platform never saw one.
   */
  it('draws nothing between analysed frames, and says it is not in a frame', () => {
    const { boxes, inFrame, sample } = boxesAt(entries, 8, 2);
    expect(boxes).toHaveLength(0);
    expect(inFrame).toBe(false);
    /* ⚠️ The sample is still returned, so the caller can say how far away the nearest one is. */
    expect(sample?.offsetSeconds).toBe(0);
  });

  /** ⭐ "Which person is Track 7?" — isolating one identity is a filter, not a second query. */
  it('isolates one track when asked', () => {
    const { boxes } = boxesAt(entries, 0, 2, 'trk_a_2');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.label).toBe('person · #2');
  });

  /** ⚠️ An entry with no box contributes no rectangle rather than one at the origin. */
  it('skips an entry that carried no box', () => {
    const withoutBox = [entry({ offsetSeconds: 0, trackId: 'trk_a_9' })];
    expect(boxesAt(withoutBox, 0, 2).boxes).toHaveLength(0);
  });

  /** ⚠️ The label carries the identity, because that is what an operator says out loud. */
  it('labels a box with its subject and short track id', () => {
    expect(boxesAt(entries, 16, 2).boxes[0]?.label).toBe('person · #3');
  });
});

describe('shortTrack', () => {
  it('reduces a runtime track id to its ordinal', () => {
    expect(
      shortTrack('trk_cam_retail_entrance_live-tnt_demo_retail-cam_retail_entrance-ases_07de_7'),
    ).toBe('#7');
  });

  /** ⚠️ Total — an id in an unexpected shape still yields something short and stable. */
  it('falls back to a tail rather than throwing', () => {
    expect(shortTrack('weird-id')).toBe('ird-id');
  });
});

describe('analysedInstants', () => {
  /**
   * ⭐ The number the player puts on screen: how many moments in the recording have anything
   * stored. On the measured run it is **9**, from 67 analysed frames — which is why the player says
   * so rather than letting a customer read the gaps as blindness.
   */
  it('is the sorted set of distinct offsets', () => {
    const entries = [
      entry({ offsetSeconds: 6 }),
      entry({ offsetSeconds: 0, trackId: 'a' }),
      entry({ offsetSeconds: 0, trackId: 'b' }),
      entry({ offsetSeconds: 16 }),
    ];
    expect(analysedInstants(entries)).toEqual([0, 6, 16]);
  });
});

describe('overlayStatus', () => {
  const entries = [entry({ offsetSeconds: 2, trackId: 'a' }), entry({ offsetSeconds: 10, trackId: 'b' })];

  it('counts what it is drawing when the playhead is on an analysed frame', () => {
    const { boxes, inFrame, sample } = boxesAt(entries, 10, 2);
    expect(overlayStatus(boxes.length, inFrame, sample, 10)).toBe('0 stored at 00:10');
  });

  /**
   * ⛔ **V-17 — "no analysed frame at this instant" is true and useless.** The reported recording
   * stores boxes at 5 of its 19 seconds, so that string was on screen for 97 % of playback and read
   * as "the AI found nothing". The nearest stored moment is the thing the operator can act on.
   */
  it('names the nearest stored frame and how far ahead it is', () => {
    const { boxes, inFrame, sample } = boxesAt(entries, 8.2, 2);
    expect(overlayStatus(boxes.length, inFrame, sample, 8.2)).toBe(
      'nearest stored frame 00:10 · 1.8 s ahead',
    );
  });

  it('says back when the nearest stored frame is behind the playhead', () => {
    const { boxes, inFrame, sample } = boxesAt(entries, 14, 2);
    expect(overlayStatus(boxes.length, inFrame, sample, 14)).toBe(
      'nearest stored frame 00:10 · 4.0 s back',
    );
  });

  /** ⚠️ A run that stored nothing is a different statement from a gap between stored frames. */
  it('distinguishes a run with nothing stored from a gap', () => {
    expect(overlayStatus(0, false, undefined, 3)).toBe('nothing stored for this run');
  });
});

describe('OVERLAY_SAMPLE_MS', () => {
  /**
   * ⛔ **The guard on V-17.** Chrome fires `timeupdate` every 266 ms (measured, 74 samples over the
   * reported 19 s recording) against a 500 ms tolerance window, so a box was painted for one tick or
   * none. The sampling interval must divide the *narrowest* window several times over or the overlay
   * goes back to being a strobe.
   */
  it('fits at least eight samples inside the narrowest tolerance window', () => {
    const narrowestWindowMs = toleranceFor(30) * 2 * 1000;
    expect(narrowestWindowMs / OVERLAY_SAMPLE_MS).toBeGreaterThanOrEqual(8);
  });

  /** ⚠️ And is not so fine that it costs 60 renders a second for no extra certainty. */
  it('stays coarser than a display frame', () => {
    expect(OVERLAY_SAMPLE_MS).toBeGreaterThan(1000 / 60);
  });
});
