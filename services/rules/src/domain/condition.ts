/**
 * Domain: the **sandboxed condition interpreter** — evaluates a `RuleCondition` predicate tree
 * against an `EventEnvelope`. Pure, total, and data-only: there is NO code execution, no regex
 * (ReDoS-safe), no network/IO; a rule is just a finite tree of field/op/value leaves combined with
 * `all`/`any`/`not`. Field access is a safe dotted-path lookup that refuses prototype-pollution keys.
 * This is what makes tenant-authored rules safe to run (RULE_ENGINE §Security).
 */
import type { EventEnvelope, RuleCondition, RulePredicate } from '@vip/contracts';

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Safe dotted-path read (e.g. `subjects.0.class`). Returns `undefined` for any missing/blocked step. */
export function getField(envelope: EventEnvelope, path: string): unknown {
  let current: unknown = envelope;
  for (const rawKey of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    if (BLOCKED_KEYS.has(rawKey)) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(rawKey);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[rawKey];
    }
  }
  return current;
}

function asComparable(v: unknown): number | string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return v;
  return undefined;
}

/**
 * Evaluate one leaf.
 *
 * Exported so the explainer (`explain.ts`) can report **the same** verdict the engine reached rather
 * than a second implementation of it. Two interpreters would drift, and the explanation would
 * eventually describe a decision the engine did not make — which is worse than no explanation,
 * because it is believed.
 */
export function evaluatePredicate(leaf: RulePredicate, envelope: EventEnvelope): boolean {
  const actual = getField(envelope, leaf.field);
  const expected = leaf.value;

  switch (leaf.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asComparable(actual);
      const b = asComparable(expected);
      if (a === undefined || b === undefined || typeof a !== typeof b) return false;
      if (leaf.op === 'gt') return a > b;
      if (leaf.op === 'gte') return a >= b;
      if (leaf.op === 'lt') return a < b;
      return a <= b;
    }
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return false;
    default:
      return false;
  }
}

/** Evaluate a condition tree. An absent condition (handled by the caller) is treated as always-true. */
export function evaluateCondition(condition: RuleCondition, envelope: EventEnvelope): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, envelope));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, envelope));
  if ('not' in condition) return !evaluateCondition(condition.not, envelope);
  return evaluatePredicate(condition, envelope);
}
