import { describe, expect, it } from 'vitest';
import { CreateRuleInput, RuleCondition } from '../src/rules/rules.js';
import { EVENT_CATALOG, EventCatalogEntry } from '../src/events/catalog.js';

describe('RuleCondition (recursive, sandboxed)', () => {
  it('parses a nested all/any/not predicate tree (data, not code)', () => {
    const cond = {
      all: [
        { field: 'category', op: 'eq', value: 'perception' },
        {
          any: [
            { field: 'confidence', op: 'gte', value: 0.8 },
            { not: { field: 'cameraId', op: 'exists' } },
          ],
        },
      ],
    };
    expect(() => RuleCondition.parse(cond)).not.toThrow();
  });

  it('rejects an empty all/any group', () => {
    expect(() => RuleCondition.parse({ all: [] })).toThrow();
  });
});

describe('CreateRuleInput', () => {
  it('applies defaults and requires at least one action', () => {
    const parsed = CreateRuleInput.parse({
      name: 'person after hours',
      categories: ['perception'],
      actions: [{ type: 'raise-incident' }],
    });
    expect(parsed.lifecycle).toBe('draft');
    expect(parsed.priority).toBe(100);
    expect(parsed.severity).toBe('medium');
    expect(parsed.eventTypes).toEqual([]);
    expect(() => CreateRuleInput.parse({ name: 'x', actions: [] })).toThrow();
  });
});

describe('event catalog categorization (P1-5 rec 2)', () => {
  it('every catalog entry declares a valid category', () => {
    for (const entry of EVENT_CATALOG) {
      expect(() => EventCatalogEntry.parse(entry)).not.toThrow();
      expect(['perception', 'security', 'safety', 'system', 'analytics']).toContain(entry.category);
    }
  });
});
