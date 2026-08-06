/**
 * Per-zone event fan-out (P-8 Phase 7).
 *
 * ⚠️ The attribute key this normalizer reads is written by **another service** (`services/media`), and
 * the two cannot import each other — they are joined by a broker. A mismatch fails silently and
 * totally: every event would carry no zone, every zone-scoped rule would decline at the scope stage,
 * and loitering would never fire with nothing in any log. The end-to-end verification asserts a zone
 * actually arrives on an envelope; this file pins the shape on the reading side.
 */
import { describe, expect, it } from 'vitest';
import type { DetectionResult } from '@vip/contracts';
import { dedupKey, normalizeDetectionResult } from '../src/domain/event-normalizer.js';

/** ⚠️ Duplicated deliberately, so a change to the producer's key makes this file fail loudly. */
const ZONE_ATTRIBUTE = 'zoneIds';

const deps = { now: () => new Date('2026-08-06T10:00:00.000Z'), newId: idGen() };

function idGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `0000000${n}-1111-4111-8111-111111111111`.slice(-36);
  };
}

function result(detections: DetectionResult['detections']): DetectionResult {
  return {
    tenantId: 't-1',
    cameraId: 'cam-1',
    capabilityId: 'perception.person-detection',
    capabilityVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    executionProvider: 'cpu',
    model: {
      name: 'yolox-nano',
      version: '1.0.0',
      task: 'detect',
      family: '*',
      accelerator: 'cpu',
    },
    frame: { cameraId: 'cam-1', seq: 7, capturedAt: '2026-08-06T10:00:00.000Z' },
    detections,
    inferenceMs: 10,
  } as DetectionResult;
}

const person = (attributes: Record<string, unknown> = {}) => ({
  label: 'person',
  confidence: 0.9,
  bbox: [0.1, 0.1, 0.1, 0.3] as [number, number, number, number],
  attributes,
  metadata: {},
  trackingId: 'trk-1',
  identityId: 'id-1',
});

describe('zone fan-out', () => {
  /**
   * ⚠️ Unchanged from before this milestone, and it must stay that way: tenant-wide and
   * camera-scoped rules, and every existing verification, depend on a zoneless event still arriving.
   */
  it('emits one zoneless envelope for a subject inside no zone', () => {
    const envelopes = normalizeDetectionResult(result([person()]), deps);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.zoneId).toBeUndefined();
  });

  it('emits one envelope carrying the zone for a subject inside one', () => {
    const envelopes = normalizeDetectionResult(
      result([person({ [ZONE_ATTRIBUTE]: ['zn-queue'] })]),
      deps,
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.zoneId).toBe('zn-queue');
  });

  /**
   * ⚠️ Two facts, not one. A rule scoped to the queue must see "in the queue" without also seeing
   * "in the aisle" — and `EventEnvelope.zoneId` is a single value by design, so the scope stage stays
   * a hash lookup rather than a set intersection per rule per event.
   */
  it('emits one envelope per zone when zones overlap', () => {
    const envelopes = normalizeDetectionResult(
      result([person({ [ZONE_ATTRIBUTE]: ['zn-queue', 'zn-aisle'] })]),
      deps,
    );
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((e) => e.zoneId).sort()).toEqual(['zn-aisle', 'zn-queue']);
  });

  it('gives the per-zone envelopes distinct ids and distinct dedup keys', () => {
    const envelopes = normalizeDetectionResult(
      result([person({ [ZONE_ATTRIBUTE]: ['zn-queue', 'zn-aisle'] })]),
      deps,
    );
    const [a, b] = envelopes;
    expect(a?.id).not.toBe(b?.id);
    expect(dedupKey(a!, 60_000)).not.toBe(dedupKey(b!, 60_000));
  });

  /** They came from one frame, so they share a correlation id — the trace must stay joinable. */
  it('keeps every envelope from one frame on one correlation chain', () => {
    const envelopes = normalizeDetectionResult(
      result([person({ [ZONE_ATTRIBUTE]: ['zn-queue', 'zn-aisle'] })]),
      deps,
    );
    expect(envelopes[0]?.correlationId).toBe(envelopes[1]?.correlationId);
    expect(envelopes[0]?.payload['frameId']).toBe('t-1:cam-1:7');
  });

  it('carries the identity onto every zoned envelope, because dwell groups by it', () => {
    const envelopes = normalizeDetectionResult(
      result([person({ [ZONE_ATTRIBUTE]: ['zn-queue', 'zn-aisle'] })]),
      deps,
    );
    for (const envelope of envelopes) {
      expect(envelope.subjects[0]?.identityId).toBe('id-1');
      expect(envelope.subjects[0]?.trackId).toBe('trk-1');
    }
  });

  /**
   * ⚠️ Defensive: `attributes` is an open map that crossed a broker. A malformed value must not
   * become an envelope's `zoneId` and then an incident's primary key.
   */
  it('ignores a malformed zone attribute rather than trusting it', () => {
    for (const bad of ['zn-queue', 42, { zoneId: 'zn-queue' }, [1, 2]]) {
      const envelopes = normalizeDetectionResult(result([person({ [ZONE_ATTRIBUTE]: bad })]), deps);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.zoneId).toBeUndefined();
    }
  });

  it('fans out per detection as well as per zone', () => {
    const envelopes = normalizeDetectionResult(
      result([
        person({ [ZONE_ATTRIBUTE]: ['zn-queue'] }),
        person({ [ZONE_ATTRIBUTE]: ['zn-queue', 'zn-aisle'] }),
        person(),
      ]),
      deps,
    );
    expect(envelopes).toHaveLength(4);
  });
});
