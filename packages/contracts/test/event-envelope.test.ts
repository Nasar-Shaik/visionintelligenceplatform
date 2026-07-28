import { describe, expect, it } from 'vitest';
import { EventEnvelope } from '../src/events/envelope.js';

const validBase = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'spatial.line.crossed',
  category: 'perception',
  schemaVersion: '1.0.0',
  tenantId: 't_123',
  occurredAt: '2026-07-27T10:00:00.000Z',
  ingestedAt: '2026-07-27T10:00:00.500Z',
  producer: { capability: 'spatial.line-crossing', capabilityVersion: '2.1.0' },
  priority: 'info',
};

describe('EventEnvelope', () => {
  it('parses a valid minimal event and applies defaults', () => {
    const parsed = EventEnvelope.parse(validBase);
    expect(parsed.subjects).toEqual([]);
    expect(parsed.evidenceRefs).toEqual([]);
    expect(parsed.payload).toEqual({});
    // contract evolution (P1-5 recs): envelopeVersion defaults, category is explicit
    expect(parsed.envelopeVersion).toBe('1.0.0');
    expect(parsed.category).toBe('perception');
  });

  it('rejects an invalid event type (not <domain>.<subject>.<predicate>)', () => {
    expect(() => EventEnvelope.parse({ ...validBase, type: 'BadType' })).toThrow();
    expect(() => EventEnvelope.parse({ ...validBase, type: 'single' })).toThrow();
  });

  it('rejects a non-semver schemaVersion', () => {
    expect(() => EventEnvelope.parse({ ...validBase, schemaVersion: 'v1' })).toThrow();
  });

  it('requires a tenantId (Law 5 — no operation without tenant context)', () => {
    const { tenantId: _omit, ...noTenant } = validBase;
    expect(() => EventEnvelope.parse(noTenant)).toThrow();
  });

  it('bounds confidence to [0,1]', () => {
    expect(() => EventEnvelope.parse({ ...validBase, confidence: 1.2 })).toThrow();
    expect(EventEnvelope.parse({ ...validBase, confidence: 0.9 }).confidence).toBe(0.9);
  });
});
