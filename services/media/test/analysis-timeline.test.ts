/**
 * The investigation timeline (P-8 Phase 8, slice 4).
 *
 * ⭐ Every number a customer reads off a timeline is decided in `domain/analysis-timeline.ts`, so it
 * is driven from values here rather than observed in a deployment and hoped about.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { TIMELINE_BUCKETS, type EventEnvelope } from '@vip/contracts';
import {
  offsetSeconds,
  toDensity,
  toEntry,
  toTrackSpans,
} from '../src/domain/analysis-timeline.js';
import { AnalysisService } from '../src/application/analysis-service.js';
import { InMemoryAnalysisStore } from '../src/adapters/in-memory-analysis-store.js';
import { newSession, type AnalysisDoc } from '../src/domain/analysis.js';

const FOOTAGE_START = '2026-02-14T18:30:00.000Z';
const T0 = new Date('2026-03-01T09:00:00.000Z');
const scope = TenantScope.fromTenantId('tnt_a');
/** ⛔ The requesting user's own token — never a service key. See `AnalysisEventCaller`. */
const CALLER = { authorization: 'Bearer user-token' };

function event(over: {
  id?: string;
  offset: number;
  trackId?: string;
  confidence?: number | undefined;
  zoneId?: string;
  label?: string;
}): EventEnvelope {
  return {
    id: over.id ?? `ev_${String(over.offset)}`,
    type: 'perception.person.detected',
    envelopeVersion: '1.0.0',
    category: 'perception',
    schemaVersion: '1.0.0',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    occurredAt: new Date(Date.parse(FOOTAGE_START) + over.offset * 1000).toISOString(),
    ingestedAt: T0.toISOString(),
    producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
    subjects: [
      {
        class: over.label ?? 'person',
        ...(over.trackId === undefined ? {} : { trackId: over.trackId }),
      },
    ],
    payload: {},
    evidenceRefs: [],
    priority: 'info',
    ...(over.confidence === undefined ? {} : { confidence: over.confidence }),
    ...(over.zoneId === undefined ? {} : { zoneId: over.zoneId }),
  } as EventEnvelope;
}

describe('offsetSeconds — where an event sits in the recording', () => {
  it('places an event at its distance from the footage start', () => {
    expect(offsetSeconds('2026-02-14T18:30:29.500Z', FOOTAGE_START)).toBe(29.5);
    expect(offsetSeconds(FOOTAGE_START, FOOTAGE_START)).toBe(0);
  });

  /**
   * ⛔ **Clamped, never negative.** An operator can correct `footageStartedAt` *after* a run — the
   * events keep the time they were analysed with, so they can then precede the start. A negative
   * offset renders off the left edge of every scrubber; the start of the footage is where it belongs.
   */
  it('clamps an event that precedes a corrected footage start', () => {
    expect(offsetSeconds('2026-02-14T18:00:00.000Z', FOOTAGE_START)).toBe(0);
  });

  /** ⚠️ Total: an unparseable date is 0, not NaN, which would poison every downstream number. */
  it('never returns NaN', () => {
    expect(offsetSeconds('not-a-date', FOOTAGE_START)).toBe(0);
    expect(offsetSeconds(FOOTAGE_START, 'not-a-date')).toBe(0);
  });
});

describe('toEntry', () => {
  it('carries the identity, the zone and the event id it came from', () => {
    const entry = toEntry(
      event({ offset: 10, trackId: 'trk_1', confidence: 0.87, zoneId: 'zn_door' }),
      FOOTAGE_START,
    );
    expect(entry).toMatchObject({
      eventId: 'ev_10',
      offsetSeconds: 10,
      label: 'person',
      confidence: 0.87,
      trackId: 'trk_1',
      zoneId: 'zn_door',
    });
  });

  /** ⛔ `null`, not 0 — a timeline showing "0 % confident" beside a firm detection is worse than none. */
  it('reports an absent confidence as null', () => {
    expect(toEntry(event({ offset: 1 }), FOOTAGE_START).confidence).toBeNull();
  });

  it('omits the track and zone rather than inventing placeholders', () => {
    const entry = toEntry(event({ offset: 1 }), FOOTAGE_START);
    expect(entry).not.toHaveProperty('trackId');
    expect(entry).not.toHaveProperty('zoneId');
  });
});

describe('toTrackSpans — one bar per subject', () => {
  const entries = [
    toEntry(event({ id: 'a', offset: 4, trackId: 'trk_1', confidence: 0.7 }), FOOTAGE_START),
    toEntry(event({ id: 'b', offset: 12, trackId: 'trk_1', confidence: 0.9 }), FOOTAGE_START),
    toEntry(event({ id: 'c', offset: 8, trackId: 'trk_2', confidence: 0.6 }), FOOTAGE_START),
  ];

  it('spans each track from first sighting to last, with its peak confidence', () => {
    const spans = toTrackSpans(entries);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      trackId: 'trk_1',
      fromOffsetSeconds: 4,
      toOffsetSeconds: 12,
      observations: 2,
      peakConfidence: 0.9,
    });
  });

  /**
   * ⛔ **The store returns events newest-first**, so a span built by trusting an order it was never
   * promised renders backwards — `from` after `to` — which no consumer would think to guard against.
   */
  it('is correct however the input is ordered', () => {
    const forwards = toTrackSpans(entries);
    const backwards = toTrackSpans([...entries].reverse());
    expect(backwards).toEqual(forwards);
    expect(forwards.every((s) => s.toOffsetSeconds >= s.fromOffsetSeconds)).toBe(true);
  });

  it('orders spans by when the subject first appeared', () => {
    expect(toTrackSpans(entries).map((s) => s.trackId)).toEqual(['trk_1', 'trk_2']);
  });

  /** ⚠️ An untracked detection is real, and is simply not a span. */
  it('ignores entries with no track rather than inventing one', () => {
    expect(toTrackSpans([toEntry(event({ offset: 3 }), FOOTAGE_START)])).toEqual([]);
  });

  it('reports a null peak when nothing carried a confidence', () => {
    const span = toTrackSpans([toEntry(event({ offset: 1, trackId: 't' }), FOOTAGE_START)])[0];
    expect(span?.peakConfidence).toBeNull();
  });
});

describe('toDensity — the lane behind the scrubber', () => {
  it('spreads a recording across a fixed number of buckets', () => {
    const entries = [0, 30, 60, 90].map((o) =>
      toEntry(event({ id: `e${String(o)}`, offset: o }), FOOTAGE_START),
    );
    const density = toDensity(entries, 120);
    expect(density).toHaveLength(TIMELINE_BUCKETS);
    expect(density.reduce((n, b) => n + b.count, 0)).toBe(4);
    expect(density[0]?.fromOffsetSeconds).toBe(0);
    expect(density[density.length - 1]?.toOffsetSeconds).toBe(120);
  });

  /**
   * ⛔ **The final moment must land inside the last bucket.** Without the clamp an event at exactly
   * the end indexes one past the array and is silently dropped — and the last seconds of a recording
   * are disproportionately likely to be what somebody is looking for.
   */
  it('counts an event at the very end of the recording', () => {
    const density = toDensity([toEntry(event({ offset: 60 }), FOOTAGE_START)], 60);
    expect(density.reduce((n, b) => n + b.count, 0)).toBe(1);
    expect(density[density.length - 1]?.count).toBe(1);
  });

  /** ⚠️ No declared duration ⇒ span from the events themselves rather than refusing to draw. */
  it('falls back to the last event when the container declared no duration', () => {
    const entries = [0, 50].map((o) =>
      toEntry(event({ id: `e${String(o)}`, offset: o }), FOOTAGE_START),
    );
    const density = toDensity(entries, undefined);
    expect(density).toHaveLength(TIMELINE_BUCKETS);
    expect(density[density.length - 1]?.toOffsetSeconds).toBe(50);
  });

  /** ⚠️ Nothing to draw is an empty lane, not one zero-width bucket implying a zero-length file. */
  it('draws nothing when there is neither a duration nor an event', () => {
    expect(toDensity([], undefined)).toEqual([]);
    expect(toDensity([], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('AnalysisService.timeline', () => {
  async function build(opts: { events?: EventEnvelope[]; truncated?: boolean; wired?: boolean }) {
    const store = new InMemoryAnalysisStore();
    const analysis: AnalysisDoc = {
      _id: 'ana_1',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      sourceKind: 'upload',
      state: 'ready',
      asset: {
        key: 'k',
        originalName: 'f.mp4',
        bytes: 10,
        contentType: 'video/mp4',
        container: 'mp4',
        codec: 'h264',
        width: 640,
        height: 480,
        sourceFrameRate: 25,
        durationSeconds: 60,
      },
      footageStartedAt: FOOTAGE_START,
      footageStartSource: 'operator',
      sessionCount: 2,
      createdBy: 'usr_1',
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    };
    await store.putAnalysis(scope, analysis);
    for (const [i, id] of ['ases_1', 'ases_2'].entries()) {
      await store.putSession(scope, {
        ...newSession({
          id,
          tenantId: 'tnt_a',
          analysisId: 'ana_1',
          cameraId: 'cam_1',
          sequence: i + 1,
          analysisFrameRate: 2,
          speed: null,
          capabilityId: 'cap',
          ruleSet: [],
          findings: [],
          requestedBy: 'usr_1',
          now: T0,
          durationSeconds: 60,
        }),
        state: 'succeeded',
      });
    }
    const asked: string[] = [];
    const seenAuth: string[] = [];
    const service = new AnalysisService({
      store,
      objectStore: {} as never,
      probe: {} as never,
      cameras: { async exists() { return true; } },
      clock: { now: () => T0 },
      ids: { analysisId: () => 'a', sessionId: () => 's' },
      capabilityId: 'cap',
      defaultFrameRate: 2,
      playbackTtlSeconds: 900,
      ...(opts.wired === false
        ? {}
        : {
            events: {
              async forSession(
                _s: TenantScope,
                sessionId: string,
                _limit: number,
                caller: { authorization: string },
              ) {
                asked.push(sessionId);
                seenAuth.push(caller.authorization);
                return { events: opts.events ?? [], truncated: opts.truncated ?? false };
              },
            },
          }),
    });
    return { service, asked, seenAuth };
  }

  /**
   * ⭐ **The latest run, never a merge.** Two runs of one recording are two answers — possibly under
   * different rules or a different model — and overlaying them would produce a picture describing no
   * run that ever happened.
   */
  it('defaults to the latest run', async () => {
    const { service, asked } = await build({ events: [] });
    const timeline = await service.timeline(scope, 'ana_1', {}, CALLER);
    expect(timeline.sessionId).toBe('ases_2');
    expect(asked).toEqual(['ases_2']);
  });

  it('returns the run that was asked for', async () => {
    const { service, asked } = await build({ events: [] });
    const timeline = await service.timeline(scope, 'ana_1', { sessionId: 'ases_1' }, CALLER);
    expect(timeline.sessionId).toBe('ases_1');
    expect(asked).toEqual(['ases_1']);
  });

  /** ⚠️ A run from another analysis is not found here, rather than silently returning the latest. */
  it('refuses a run that does not belong to this analysis', async () => {
    const { service } = await build({ events: [] });
    await expect(service.timeline(scope, 'ana_1', { sessionId: 'ases_other' }, CALLER)).rejects.toThrow(
      /does not belong/,
    );
  });

  it('assembles entries, spans and density in footage order', async () => {
    const { service } = await build({
      events: [
        event({ id: 'c', offset: 30, trackId: 'trk_1', confidence: 0.9 }),
        event({ id: 'a', offset: 5, trackId: 'trk_1', confidence: 0.7 }),
        event({ id: 'b', offset: 20, trackId: 'trk_2', confidence: 0.8 }),
      ],
    });
    const timeline = await service.timeline(scope, 'ana_1', {}, CALLER);

    /* ⭐ Sorted into footage order, whatever order the store returned them in. */
    expect(timeline.entries.map((e) => e.offsetSeconds)).toEqual([5, 20, 30]);
    expect(timeline.tracks.map((t) => t.trackId)).toEqual(['trk_1', 'trk_2']);
    expect(timeline.tracks[0]).toMatchObject({ fromOffsetSeconds: 5, toOffsetSeconds: 30 });
    expect(timeline.density.reduce((n, b) => n + b.count, 0)).toBe(3);
    expect(timeline.durationSeconds).toBe(60);
    expect(timeline.footageStartedAt).toBe(FOOTAGE_START);
  });

  /**
   * ⛔ **Truncation is stated.** "The first two thousand events" and "the events" are different
   * claims about an investigation, and only one of them is true.
   */
  it('says so when it could not read the whole run', async () => {
    const { service } = await build({ events: [event({ offset: 1 })], truncated: true });
    expect((await service.timeline(scope, 'ana_1', {}, CALLER)).truncated).toBe(true);
  });

  /**
   * ⚠️ **"We cannot look" is not "we looked and found none".** Incidents arrive in slice 5; until
   * then the lane reports itself unavailable so the console can say which it is showing.
   */
  it('reports incidents as unavailable rather than as an empty lane', async () => {
    const { service } = await build({ events: [] });
    expect((await service.timeline(scope, 'ana_1', {}, CALLER)).incidentsAvailable).toBe(false);
  });

  /** ⚠️ A deployment with no events service refuses honestly instead of returning an empty timeline. */
  it('refuses when no events service is configured', async () => {
    const { service } = await build({ wired: false });
    await expect(service.timeline(scope, 'ana_1', {}, CALLER)).rejects.toThrow(/no events service/);
  });

  /**
   * ⛔ **The requesting user's identity reaches the events service, not a service key.**
   *
   * A service key would work and would quietly widen what a timeline can show beyond what the person
   * asking for it is entitled to open — `services/workflow` records the same decision for the
   * incident timeline, and this endpoint went out with a service key on its first deployment before
   * the 401 exposed it.
   */
  it('forwards the caller’s own authorization, never a service key', async () => {
    const { service, seenAuth } = await build({ events: [] });
    await service.timeline(scope, 'ana_1', {}, { authorization: 'Bearer alice' });
    expect(seenAuth).toEqual(['Bearer alice']);
  });

  it('tells an operator an analysis has never been run', async () => {
    const store = new InMemoryAnalysisStore();
    await store.putAnalysis(scope, {
      _id: 'ana_2',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      sourceKind: 'upload',
      state: 'ready',
      footageStartedAt: FOOTAGE_START,
      footageStartSource: 'operator',
      sessionCount: 0,
      createdBy: 'u',
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    });
    const service = new AnalysisService({
      store,
      objectStore: {} as never,
      probe: {} as never,
      cameras: { async exists() { return true; } },
      clock: { now: () => T0 },
      ids: { analysisId: () => 'a', sessionId: () => 's' },
      capabilityId: 'cap',
      defaultFrameRate: 2,
      playbackTtlSeconds: 900,
      events: { async forSession() { return { events: [], truncated: false }; } },
    });
    await expect(service.timeline(scope, 'ana_2', {}, CALLER)).rejects.toThrow(/has not been run yet/);
  });
});
