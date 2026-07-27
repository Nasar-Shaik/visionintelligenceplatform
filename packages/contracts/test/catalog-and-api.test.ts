import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EVENT_CATALOG, EventCatalogEntry, isKnownEventType, lookupEvent } from '../src/events/catalog.js';
import { apiEnvelope } from '../src/common/api-envelope.js';

describe('event catalog', () => {
  it('every entry is a valid catalog entry', () => {
    for (const entry of EVENT_CATALOG) expect(() => EventCatalogEntry.parse(entry)).not.toThrow();
  });

  it('event types are unique', () => {
    const types = EVENT_CATALOG.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it('safety-critical types default to critical priority', () => {
    expect(lookupEvent('perception.fire.detected')?.defaultPriority).toBe('critical');
    expect(lookupEvent('perception.smoke.detected')?.defaultPriority).toBe('critical');
  });

  it('lookup/known helpers behave', () => {
    expect(isKnownEventType('spatial.line.crossed')).toBe(true);
    expect(isKnownEventType('nope.not.here')).toBe(false);
    expect(lookupEvent('nope.not.here')).toBeUndefined();
  });
});

describe('apiEnvelope', () => {
  const Env = apiEnvelope(z.object({ id: z.string() }));

  it('accepts a success envelope', () => {
    expect(() => Env.parse({ success: true, data: { id: 'x' } })).not.toThrow();
  });

  it('accepts an error envelope', () => {
    expect(() => Env.parse({ success: false, error: { code: 'not_found', message: 'nope' } })).not.toThrow();
  });

  it('rejects a success envelope missing data', () => {
    expect(() => Env.parse({ success: true })).toThrow();
  });
});
