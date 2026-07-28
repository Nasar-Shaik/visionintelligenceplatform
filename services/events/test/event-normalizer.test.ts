import { describe, it, expect } from 'vitest';
import {
  dedupKey,
  eventTypeForLabel,
  normalizeDetectionResult,
} from '../src/domain/event-normalizer.js';
import { detectionResult } from './helpers.js';

const deps = { now: () => new Date('2026-07-28T00:00:00.200Z'), newId: () => 'evt_fixed' };

describe('eventTypeForLabel', () => {
  it('maps known labels to catalog types and falls back to generic object', () => {
    expect(eventTypeForLabel('person')).toBe('perception.person.detected');
    expect(eventTypeForLabel('Car')).toBe('perception.vehicle.detected');
    expect(eventTypeForLabel('smoke')).toBe('perception.smoke.detected');
    expect(eventTypeForLabel('forklift')).toBe('perception.object.detected');
  });
});

describe('normalizeDetectionResult', () => {
  it('turns each detection into a domain-neutral envelope with provenance + subject', () => {
    const [env, ...rest] = normalizeDetectionResult(detectionResult(), deps);
    expect(rest).toHaveLength(0);
    expect(env).toMatchObject({
      type: 'perception.person.detected',
      envelopeVersion: '1.0.0',
      category: 'perception',
      tenantId: 'tnt_a',
      cameraId: 'cam_1',
      occurredAt: '2026-07-28T00:00:00.000Z',
      ingestedAt: '2026-07-28T00:00:00.200Z',
      confidence: 0.84,
      correlationId: 'corr_9',
      priority: 'info',
    });
    expect(env!.producer).toMatchObject({
      capability: 'perception.person-detection',
      capabilityVersion: '1.0.0',
      modelVersion: '1.0.0',
    });
    expect(env!.subjects[0]).toMatchObject({ class: 'person', bbox: [0.1, 0.2, 0.3, 0.4] });
  });

  it('emits one envelope per detection', () => {
    const result = detectionResult({
      detections: [
        { label: 'person', confidence: 0.9, bbox: [0, 0, 0.1, 0.1], attributes: {}, metadata: {} },
        { label: 'car', confidence: 0.7, bbox: [0.5, 0.5, 0.2, 0.2], attributes: {}, metadata: {} },
      ],
    });
    const envs = normalizeDetectionResult(result, deps);
    expect(envs.map((e) => e.type)).toEqual([
      'perception.person.detected',
      'perception.vehicle.detected',
    ]);
  });
});

describe('dedupKey', () => {
  it('collapses the same subject within a time-bucket, distinguishes tracks and buckets', () => {
    const base = normalizeDetectionResult(detectionResult(), deps)[0]!;
    const window = 10_000;
    const k1 = dedupKey(base, window);
    // same everything, later id → same key (idempotent redelivery)
    expect(dedupKey({ ...base, id: 'other' }, window)).toBe(k1);
    // different track → different key
    const withTrack = { ...base, subjects: [{ ...base.subjects[0]!, trackId: 't1' }] };
    expect(dedupKey(withTrack, window)).not.toBe(k1);
    // a later bucket → different key
    const later = { ...base, occurredAt: '2026-07-28T00:00:20.000Z' };
    expect(dedupKey(later, window)).not.toBe(k1);
  });
});
