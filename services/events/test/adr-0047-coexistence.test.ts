/**
 * ADR-0047 — **live and offline in one deployment**, through the real ingest path.
 *
 * The unit tests next door prove the dedup key is right. These prove the *system* is right: a live
 * camera and an offline analysis of that same camera's footage, ingested through the same
 * `EventIngestService` into the same store, coexisting without touching each other.
 *
 * ⭐ Why this file exists separately: the risk of ADR-0047 is not that the key is wrong, it is that
 * something **else** collides — a store filter, a query, a shared counter. Only running both paths
 * against one store can show that.
 */
import { describe, expect, it } from 'vitest';
import { TenantScope } from '@vip/tenancy';
import { DetectionResult, EventQuery } from '@vip/contracts';
import { EventIngestService } from '../src/application/event-ingest-service.js';
import { InMemoryEventStore } from '../src/adapters/in-memory-event-store.js';

const scope = TenantScope.fromTenantId('tnt_a');
const DEDUP_MS = 10_000;

/** A bus that records rather than brokers. ⚠️ Republishing is part of ingest and must be observed. */
function recordingBus() {
  const published: { subject: string; envelope: { analysisSessionId?: string } }[] = [];
  return {
    published,
    bus: {
      publish: async (subject: string, envelope: unknown) => {
        published.push({ subject, envelope: envelope as { analysisSessionId?: string } });
      },
      subscribe: async () => ({ stop: async () => undefined }),
      ensureStream: async () => undefined,
      close: async () => undefined,
    } as never,
  };
}

function build() {
  const store = new InMemoryEventStore();
  const { bus, published } = recordingBus();
  let n = 0;
  const service = new EventIngestService({
    bus,
    store,
    dedupWindowMs: DEDUP_MS,
    now: () => new Date('2026-08-07T12:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { store, service, published };
}

/**
 * One detection result. `analysisSessionId` absent ⇒ **live**, which is how every existing producer
 * behaves and what the compatibility requirement is about.
 */
function result(over: {
  cameraId?: string;
  seq?: number;
  capturedAt?: string;
  trackingId?: string;
  analysisSessionId?: string;
}): DetectionResult {
  return DetectionResult.parse({
    schemaVersion: '1.1',
    tenantId: 'tnt_a',
    cameraId: over.cameraId ?? 'cam_1',
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'CPUExecutionProvider',
    model: { name: 'yolox-nano', version: '1.0.0', task: 'object-detection' },
    frame: { seq: over.seq ?? 1, capturedAt: over.capturedAt ?? '2026-02-14T18:30:00.000Z' },
    inferenceMs: 30,
    at: '2026-08-07T12:00:00.000Z',
    detections: [
      {
        label: 'person',
        confidence: 0.9,
        bbox: [0.1, 0.1, 0.2, 0.4],
        attributes: {},
        metadata: {},
        trackingId: over.trackingId ?? 'trk_1',
        identityId: over.trackingId ?? 'trk_1',
      },
    ],
    ...(over.analysisSessionId === undefined
      ? {}
      : { analysisSessionId: over.analysisSessionId }),
  });
}

const query = (over: Partial<Record<string, unknown>> = {}) => EventQuery.parse(over);

describe('⭐ mixed live + offline coexistence', () => {
  /**
   * ⛔ **The scenario that would have been catastrophic in the other direction.**
   *
   * An analysis of yesterday's footage from `cam_1` must not silence today's LIVE detections on
   * `cam_1`. Same camera, same track, and — because footage time is arbitrary — potentially the same
   * bucket. Before ADR-0047 the first one written would have won and the other would have vanished.
   */
  it('a live camera and an analysis of its own footage both persist', async () => {
    const { service, store } = build();

    const live = await service.ingest(result({ capturedAt: '2026-02-14T18:30:00.000Z' }));
    const offline = await service.ingest(
      result({ capturedAt: '2026-02-14T18:30:00.000Z', analysisSessionId: 'ases_A' }),
    );

    expect(live.persisted).toBe(1);
    expect(live.deduped).toBe(0);
    /* ⭐ Not deduplicated against the live event, despite every other identity field matching. */
    expect(offline.persisted).toBe(1);
    expect(offline.deduped).toBe(0);

    const all = await store.query(scope, query({ includeAnalyses: true }));
    expect(all.events).toHaveLength(2);
  });

  it('interleaved live and offline ingest never cross-deduplicate', async () => {
    const { service } = build();
    let livePersisted = 0;
    let offlinePersisted = 0;

    for (let seq = 1; seq <= 6; seq += 1) {
      /* ⚠️ Live frames advance in wall time; offline frames replay footage time. Interleaved. */
      const l = await service.ingest(
        result({ seq, capturedAt: new Date(1786000000000 + seq * 20_000).toISOString() }),
      );
      const o = await service.ingest(
        result({
          seq,
          capturedAt: new Date(Date.parse('2026-02-14T18:30:00.000Z') + seq * 20_000).toISOString(),
          analysisSessionId: 'ases_A',
        }),
      );
      livePersisted += l.persisted;
      offlinePersisted += o.persisted;
    }

    expect(livePersisted).toBe(6);
    expect(offlinePersisted).toBe(6);
  });

  /** ⚠️ Live deduplication must still work while an analysis is running beside it. */
  it('live still deduplicates its own repeats during an offline run', async () => {
    const { service } = build();
    const at = '2026-08-07T11:00:00.000Z';

    await service.ingest(result({ capturedAt: at }));
    await service.ingest(result({ seq: 2, capturedAt: at, analysisSessionId: 'ases_A' }));
    /* ⛔ Same live observation again, same bucket — must collapse exactly as before ADR-0047. */
    const repeat = await service.ingest(result({ seq: 3, capturedAt: at }));

    expect(repeat.persisted).toBe(0);
    expect(repeat.deduped).toBe(1);
  });
});

describe('⭐ query isolation — offline cannot pollute a live dashboard', () => {
  async function seeded() {
    const { service, store } = build();
    /* Two live events on cam_1, at two different wall-clock moments. */
    await service.ingest(result({ capturedAt: '2026-08-07T11:00:00.000Z' }));
    await service.ingest(result({ seq: 2, capturedAt: '2026-08-07T11:00:30.000Z' }));
    /* Two analyses of the same footage on the same camera. */
    await service.ingest(result({ capturedAt: '2026-02-14T18:30:00.000Z', analysisSessionId: 'ases_A' }));
    await service.ingest(result({ capturedAt: '2026-02-14T18:30:00.000Z', analysisSessionId: 'ases_B' }));
    return { store };
  }

  /**
   * ⛔ **The assertion that makes "cannot pollute" true rather than merely documented.**
   *
   * The console's Events page, every dashboard and every pre-existing export call this API with no
   * knowledge that offline analysis exists. If the default returned analysis events, six-week-old
   * footage replayed on demand would appear in a view an operator reads as "what is happening now" —
   * and no change to those callers would be required for it to happen.
   */
  it('a live dashboard query returns ONLY live events, with no change to the caller', async () => {
    const { store } = await seeded();
    const dashboard = await store.query(scope, query({ cameraId: 'cam_1' }));

    expect(dashboard.events).toHaveLength(2);
    expect(dashboard.events.every((e) => e.analysisSessionId === undefined)).toBe(true);
    /* ⚠️ And they are the wall-clock ones, not the replayed footage. */
    expect(dashboard.events.every((e) => e.occurredAt.startsWith('2026-08-07'))).toBe(true);
  });

  /** ⚠️ The escape hatch is explicit, so a caller that genuinely wants both must say so. */
  it('returns both only when the caller asks for both', async () => {
    const { store } = await seeded();
    const all = await store.query(scope, query({ cameraId: 'cam_1', includeAnalyses: true }));
    expect(all.events).toHaveLength(4);
  });

  /** ⚠️ Naming a run is already an unambiguous request for it — the flag must not gate that. */
  it('selects a run without needing the flag', async () => {
    const { store } = await seeded();
    const a = await store.query(scope, query({ analysisSessionId: 'ases_A' }));
    expect(a.events).toHaveLength(1);
  });

  it('an offline query returns only its own run', async () => {
    const { store } = await seeded();

    const a = await store.query(scope, query({ analysisSessionId: 'ases_A' }));
    const b = await store.query(scope, query({ analysisSessionId: 'ases_B' }));

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events.every((e) => e.analysisSessionId === 'ases_A')).toBe(true);
    expect(b.events.every((e) => e.analysisSessionId === 'ases_B')).toBe(true);
    /* ⭐ And the two runs share no event. */
    expect(a.events[0]?.id).not.toBe(b.events[0]?.id);
  });

  /**
   * ⭐ **A live dashboard can exclude analyses entirely**, which is what "cannot pollute" requires in
   * practice. The live events are the ones with no analysis run, and they are identifiable without
   * any new filter — absence is the signal (ADR-0039's rule, applied to identity).
   */
  it('live events are identifiable by the absence of an analysis run', async () => {
    const { store } = await seeded();
    const all = await store.query(scope, query({ cameraId: 'cam_1', includeAnalyses: true }));

    const live = all.events.filter((e) => e.analysisSessionId === undefined);
    const offline = all.events.filter((e) => e.analysisSessionId !== undefined);

    expect(live).toHaveLength(2);
    expect(offline).toHaveLength(2);
    /* ⚠️ Every live event's occurredAt is a real wall-clock moment, not footage time. */
    expect(live.every((e) => e.occurredAt.startsWith('2026-08-07'))).toBe(true);
  });
});

describe('⭐ reproducibility — two runs of one recording are independently queryable', () => {
  /**
   * The Architect's requirement: execute the same recording twice under two session ids, persist
   * both independently, and keep both timelines reproducible. This is that, through the real ingest.
   */
  async function analyse(service: EventIngestService, sessionId: string) {
    let persisted = 0;
    for (let seq = 1; seq <= 8; seq += 1) {
      const offsetMs = (seq - 1) * 5_000;
      const out = await service.ingest(
        result({
          seq,
          capturedAt: new Date(Date.parse('2026-02-14T18:30:00.000Z') + offsetMs).toISOString(),
          analysisSessionId: sessionId,
        }),
      );
      persisted += out.persisted;
    }
    return persisted;
  }

  it('persists both runs in full and keeps each independently queryable', async () => {
    const { service, store } = build();

    const first = await analyse(service, 'ases_A');
    const second = await analyse(service, 'ases_B');

    /* ⛔ Before ADR-0047 the second number was ZERO. That is the whole defect, in one assertion. */
    expect(second).toBe(first);
    expect(first).toBeGreaterThan(0);

    const a = await store.query(scope, query({ analysisSessionId: 'ases_A', limit: 500 }));
    const b = await store.query(scope, query({ analysisSessionId: 'ases_B', limit: 500 }));
    expect(a.events).toHaveLength(first);
    expect(b.events).toHaveLength(second);

    /* ⭐ Analytically identical — same footage, same answer — and separately addressable. */
    const analytic = (e: (typeof a.events)[number]) => ({
      type: e.type,
      cameraId: e.cameraId,
      occurredAt: e.occurredAt,
      subjects: e.subjects,
      confidence: e.confidence,
    });
    expect(b.events.map(analytic).sort()).toEqual(a.events.map(analytic).sort());
  });

  /**
   * ⚠️ **A rerun never overwrites the first answer.** Sessions are append-only by construction here:
   * a different session id is a different dedup key, so there is no write path that could replace
   * run A's events with run B's. Asserted because "rule changes must never overwrite historical
   * analysis results" is a property somebody will one day be tempted to optimise away.
   */
  it('a later run leaves the earlier run untouched', async () => {
    const { service, store } = build();
    await analyse(service, 'ases_A');
    const before = await store.query(scope, query({ analysisSessionId: 'ases_A', limit: 500 }));

    await analyse(service, 'ases_B');
    const after = await store.query(scope, query({ analysisSessionId: 'ases_A', limit: 500 }));

    expect(after.events).toEqual(before.events);
  });
});

describe('republished events carry the run', () => {
  /**
   * ⚠️ Ingest re-publishes every persisted envelope for the rule engine. If the run were dropped
   * there, rules would evaluate offline events with no way to attribute what they raised — and slice
   * 5 would have nothing to filter on.
   */
  it('the envelope republished to the backbone keeps its analysisSessionId', async () => {
    const { service, published } = build();
    await service.ingest(result({ analysisSessionId: 'ases_A' }));
    await service.ingest(result({ capturedAt: '2026-08-07T11:00:00.000Z' }));

    expect(published).toHaveLength(2);
    expect(published[0]?.envelope.analysisSessionId).toBe('ases_A');
    /* ⚠️ …and the live one still carries none. */
    expect(published[1]?.envelope.analysisSessionId).toBeUndefined();
  });
});
