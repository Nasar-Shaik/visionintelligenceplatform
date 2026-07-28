import { describe, it, expect } from 'vitest';
import type { RuleCondition } from '@vip/contracts';
import { evaluateCondition, getField } from '../src/domain/condition.js';
import { personEvent } from './helpers.js';

describe('getField (safe dotted-path)', () => {
  it('reads nested + array-indexed paths', () => {
    const ev = personEvent();
    expect(getField(ev, 'type')).toBe('perception.person.detected');
    expect(getField(ev, 'subjects.0.class')).toBe('person');
    expect(getField(ev, 'subjects.0.attributes.color')).toBe('red');
    expect(getField(ev, 'subjects.5.class')).toBeUndefined();
    expect(getField(ev, 'nope.nope')).toBeUndefined();
  });

  it('refuses prototype-pollution keys', () => {
    expect(getField(personEvent(), '__proto__.polluted')).toBeUndefined();
    expect(getField(personEvent(), 'constructor.name')).toBeUndefined();
  });
});

describe('evaluateCondition (sandboxed operators)', () => {
  const ev = personEvent();
  const cases: Array<[string, RuleCondition, boolean]> = [
    ['eq true', { field: 'category', op: 'eq', value: 'perception' }, true],
    ['eq false', { field: 'category', op: 'eq', value: 'safety' }, false],
    ['ne', { field: 'cameraId', op: 'ne', value: 'cam_2' }, true],
    ['gte number', { field: 'confidence', op: 'gte', value: 0.8 }, true],
    ['lt number', { field: 'confidence', op: 'lt', value: 0.8 }, false],
    ['in', { field: 'zoneId', op: 'in', value: ['zone_1', 'zone_2'] }, true],
    ['nin', { field: 'zoneId', op: 'nin', value: ['zone_9'] }, true],
    ['exists', { field: 'cameraId', op: 'exists' }, true],
    ['exists false', { field: 'branchId', op: 'exists' }, false],
    ['contains string', { field: 'type', op: 'contains', value: 'person' }, true],
    ['gt across incomparable types is false', { field: 'confidence', op: 'gt', value: 'x' }, false],
  ];
  for (const [label, cond, expected] of cases) {
    it(label, () => expect(evaluateCondition(cond, ev)).toBe(expected));
  }

  it('composes all / any / not', () => {
    const cond: RuleCondition = {
      all: [
        { field: 'type', op: 'eq', value: 'perception.person.detected' },
        {
          any: [
            { field: 'confidence', op: 'gte', value: 0.99 },
            { not: { field: 'zoneId', op: 'eq', value: 'zone_9' } },
          ],
        },
      ],
    };
    expect(evaluateCondition(cond, ev)).toBe(true);
  });
});
