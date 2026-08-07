/**
 * ADR-0047 — an analysis run is part of an event's identity.
 *
 * ⭐ The whole risk of this change is that it is a **platform-wide envelope field**, so the tests
 * that matter most are the ones asserting nothing changed for anybody who does not set it. The
 * compatibility half comes first for that reason.
 */
import { describe, expect, it } from 'vitest';
import { EventEnvelope, DetectionResult } from '@vip/contracts';
import { dedupKey, normalizeDetectionResult } from '../src/domain/event-normalizer.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');
let seq = 0;
const deps = { now: () => NOW, newId: () => `ev_${String(++seq)}` };

/** A result as the runtime produces it for a LIVE camera — no analysis provenance anywhere. */
function liveResult(over: Record<string, unknown> = {}): DetectionResult {
  return DetectionResult.parse({
    schemaVersion: '1.1',
    tenantId: 'tnt_a',
    cameraId: 'cam_1',
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '0.1.0',
    executionProvider: 'CPUExecutionProvider',
    model: { name: 'yolox-nano', version: '1.0.0', task: 'object-detection' },
    frame: { seq: 1, capturedAt: '2026-08-07T11:59:59.000Z' },
    inferenceMs: 30,
    at: '2026-08-07T12:00:00.000Z',
    detections: [
      {
        label: 'person',
        confidence: 0.9,
        bbox: [0.1, 0.1, 0.2, 0.4],
        attributes: {},
        metadata: {},
        trackingId: 'trk_1',
        identityId: 'trk_1',
      },
    ],
    ...over,
  });
}

const envelopeOf = (result: DetectionResult) => normalizeDetectionResult(result, deps)[0]!;

// ---------------------------------------------------------------------------------------------
// Compatibility — the half that protects every existing producer and consumer
// ---------------------------------------------------------------------------------------------

describe('⭐ backward compatibility — a live event is byte-identical to before ADR-0047', () => {
  /**
   * ⛔ **The single most important assertion in this file.**
   *
   * Dedup state outlives a deployment. A key whose *shape* changed — even by one placeholder
   * separator — would make every live camera miss its window once on rollout: a burst of duplicate
   * events at exactly the moment an operator is watching a deploy. The literal below is the string
   * this function produced before the field existed, and it is written out in full on purpose so
   * that changing it requires changing this test deliberately.
   */
  it('produces exactly the pre-ADR dedup key, separator for separator', () => {
    const envelope = envelopeOf(liveResult());
    const key = dedupKey(envelope, 10_000);

    expect(key).toBe('tnt_a|perception.person.detected|cam_1|-|trk_1|178610399');
    /* ⚠️ Six segments, not seven. A trailing empty segment would be the exact regression. */
    expect(key.split('|')).toHaveLength(6);
    expect(key.endsWith('|')).toBe(false);
  });

  it('leaves the field absent rather than writing a placeholder into it', () => {
    const envelope = envelopeOf(liveResult());
    expect(envelope.analysisSessionId).toBeUndefined();
    expect('analysisSessionId' in envelope).toBe(false);
  });

  /** ⚠️ An envelope written before this ADR must still parse, unchanged. */
  it('accepts an envelope stored before the field existed', () => {
    const stored = {
      id: '8f14e45f-ceea-467a-9575-4a0b2b0f3e11',
      type: 'perception.person.detected',
      envelopeVersion: '1.0.0',
      category: 'perception',
      schemaVersion: '1.0.0',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      occurredAt: '2026-08-01T00:00:00.000Z',
      ingestedAt: '2026-08-01T00:00:00.000Z',
      producer: { capability: 'perception.person-detection', capabilityVersion: '1.0.0' },
      subjects: [],
      payload: {},
      evidenceRefs: [],
      priority: 'info',
    };
    const parsed = EventEnvelope.parse(stored);
    expect(parsed.analysisSessionId).toBeUndefined();
    /* ⭐ And its dedup key is the same one it had when it was written. */
    expect(dedupKey(parsed, 10_000)).toBe(
      'tnt_a|perception.person.detected|cam_1|-|-|178554240',
    );
  });

  /** ⚠️ A result from the frozen runtime, which never sets the field, must still parse. */
  it('accepts a DetectionResult that has never heard of analysis sessions', () => {
    expect(liveResult().analysisSessionId).toBeUndefined();
  });

  /** ⛔ Live deduplication must still collapse a repeat. Separating runs must not separate frames. */
  it('still collapses two live observations in the same bucket', () => {
    const a = envelopeOf(liveResult());
    const b = envelopeOf(liveResult({ frame: { seq: 2, capturedAt: '2026-08-07T11:59:59.500Z' } }));
    expect(dedupKey(a, 10_000)).toBe(dedupKey(b, 10_000));
  });
});

// ---------------------------------------------------------------------------------------------
// The defect this ADR closes
// ---------------------------------------------------------------------------------------------

describe('⭐ L-61 — two runs of one recording are two answers, not one', () => {
  /**
   * The measured defect: an offline analysis stamps **footage** time, so a rerun reproduces
   * `tenant + type + camera + zone + track + bucket` exactly — and because footage time never
   * advances the collision is permanent. 120 detections offered, 120 deduped, 0 persisted.
   */
  const footage = { seq: 1, capturedAt: '2026-02-14T18:30:00.000Z' };

  it('gives two runs of identical footage different dedup keys', () => {
    const runA = envelopeOf(liveResult({ frame: footage, analysisSessionId: 'ases_A' }));
    const runB = envelopeOf(liveResult({ frame: footage, analysisSessionId: 'ases_B' }));

    expect(dedupKey(runA, 10_000)).not.toBe(dedupKey(runB, 10_000));
    expect(dedupKey(runA, 10_000)).toContain('|ases_A');
    expect(dedupKey(runB, 10_000)).toContain('|ases_B');
  });

  /**
   * ⚠️ **Within one run, deduplication is unchanged** — and this is the assertion that stops the fix
   * from becoming "offline events are never deduplicated", which would multiply a four-hour
   * analysis's events by its frame rate.
   */
  it('still collapses two observations inside ONE run', () => {
    const first = envelopeOf(liveResult({ frame: footage, analysisSessionId: 'ases_A' }));
    const second = envelopeOf(
      liveResult({
        frame: { seq: 2, capturedAt: '2026-02-14T18:30:00.500Z' },
        analysisSessionId: 'ases_A',
      }),
    );
    expect(dedupKey(first, 10_000)).toBe(dedupKey(second, 10_000));
  });

  it('carries the run onto the envelope verbatim', () => {
    const envelope = envelopeOf(liveResult({ analysisSessionId: 'ases_7' }));
    expect(envelope.analysisSessionId).toBe('ases_7');
  });

  /**
   * ⭐ **A live event and an offline event on the same camera never collide either.** An analysis of
   * yesterday's footage from `cam_1` must not silence today's live detections on `cam_1`, which is
   * the same defect pointing the other way and would be far worse.
   */
  it('never lets an analysis silence the live camera it replays', () => {
    const live = envelopeOf(liveResult({ frame: footage }));
    const offline = envelopeOf(liveResult({ frame: footage, analysisSessionId: 'ases_A' }));
    expect(dedupKey(live, 10_000)).not.toBe(dedupKey(offline, 10_000));
  });
});

// ---------------------------------------------------------------------------------------------
// Replay — the same footage twice, end to end through the normalizer
// ---------------------------------------------------------------------------------------------

describe('⭐ replay — the same recording analysed twice', () => {
  /** 12 frames of footage, two people each, replayed identically under two session ids. */
  function replay(sessionId: string) {
    const out: ReturnType<typeof envelopeOf>[] = [];
    for (let seq = 1; seq <= 12; seq += 1) {
      const offsetMs = (seq - 1) * 500;
      out.push(
        ...normalizeDetectionResult(
          liveResult({
            analysisSessionId: sessionId,
            frame: {
              seq,
              capturedAt: new Date(Date.parse('2026-02-14T18:30:00.000Z') + offsetMs).toISOString(),
            },
          }),
          deps,
        ),
      );
    }
    return out;
  }

  it('produces the same events, distinguishable only by their run', () => {
    const a = replay('ases_A');
    const b = replay('ases_B');

    expect(a).toHaveLength(12);
    expect(b).toHaveLength(12);

    /* ⭐ Analytically identical: everything that describes WHAT happened matches exactly. */
    const analytic = (e: (typeof a)[number]) => ({
      type: e.type,
      cameraId: e.cameraId,
      occurredAt: e.occurredAt,
      confidence: e.confidence,
      subjects: e.subjects,
      producer: e.producer,
    });
    expect(b.map(analytic)).toEqual(a.map(analytic));

    /* …and separable: no dedup key is shared between the two runs. */
    const keysA = new Set(a.map((e) => dedupKey(e, 10_000)));
    const keysB = b.map((e) => dedupKey(e, 10_000));
    expect(keysB.some((k) => keysA.has(k))).toBe(false);
  });

  /**
   * ⚠️ **The count that would have been zero before ADR-0047.** With a 10 s window and 6 s of
   * footage, one run collapses to a single bucket per track; the second run must produce the same
   * number again rather than none.
   */
  it('the second run persists as many distinct events as the first', () => {
    const keysA = new Set(replay('ases_A').map((e) => dedupKey(e, 10_000)));
    const keysB = new Set(replay('ases_B').map((e) => dedupKey(e, 10_000)));
    expect(keysB.size).toBe(keysA.size);
    expect(keysA.size).toBeGreaterThan(0);
  });
});
