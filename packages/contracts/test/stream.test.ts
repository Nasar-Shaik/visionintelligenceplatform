/**
 * Real-time stream contract tests (P2-2 G-5). Prove the wire frames the gateway pushes over SSE:
 * shapes, the `streamVersion` default, priority ranking, and — critically — that `payload` stays
 * opaque so the transport frame is decoupled from `EventEnvelope` evolution (Architect rec 5).
 */
import { describe, expect, it } from 'vitest';
import {
  StreamEnvelope,
  StreamControl,
  StreamTopic,
  StreamPriority,
  STREAM_PRIORITY_RANK,
} from '../src/stream/stream.js';

const baseEnvelope = {
  id: '42',
  topic: 'incidents' as const,
  tenantId: 'tnt_a',
  type: 'incident.raised',
  priority: 'medium' as const,
  occurredAt: '2026-07-31T09:00:00.000Z',
  payload: { incidentId: 'inc_1', anything: { nested: true } },
};

describe('StreamEnvelope', () => {
  it('parses a valid frame and defaults streamVersion to 1.0.0', () => {
    const env = StreamEnvelope.parse(baseEnvelope);
    expect(env.streamVersion).toBe('1.0.0');
    expect(env.topic).toBe('incidents');
  });

  it('keeps payload opaque (unknown) — arbitrary shapes pass, so it is version-safe', () => {
    // A future EventEnvelope with brand-new fields must still flow through unchanged.
    const env = StreamEnvelope.parse({
      ...baseEnvelope,
      payload: { schemaVersion: '9.9.9', brandNewField: [1, 2, 3], whatever: null },
    });
    expect((env.payload as { brandNewField: number[] }).brandNewField).toEqual([1, 2, 3]);
  });

  it('rejects an unknown topic and an empty id', () => {
    expect(() => StreamEnvelope.parse({ ...baseEnvelope, topic: 'nope' })).toThrow();
    expect(() => StreamEnvelope.parse({ ...baseEnvelope, id: '' })).toThrow();
  });
});

describe('StreamControl', () => {
  it('parses a ready frame with granted topics + resume cursor', () => {
    const c = StreamControl.parse({
      type: 'ready',
      at: '2026-07-31T09:00:00.000Z',
      topics: ['incidents', 'alerts'],
      cursor: '100',
    });
    expect(c.topics).toEqual(['incidents', 'alerts']);
  });
});

describe('priority ranking', () => {
  it('orders high < medium < low (lower = more urgent)', () => {
    expect(STREAM_PRIORITY_RANK.high).toBeLessThan(STREAM_PRIORITY_RANK.medium);
    expect(STREAM_PRIORITY_RANK.medium).toBeLessThan(STREAM_PRIORITY_RANK.low);
    expect(StreamPriority.options).toEqual(['high', 'medium', 'low']);
    expect(StreamTopic.options).toEqual(['incidents', 'alerts', 'events', 'system']);
  });
});
