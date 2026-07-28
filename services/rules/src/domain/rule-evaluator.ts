/**
 * Domain: **rule evaluation** — decides whether an `EventEnvelope` matches a `Rule`. Kept strictly
 * separate from incident creation (P1-7 Architect review): this module answers only "does it match?"
 * and never constructs a candidate or touches state. Pure + deterministic. The optional windowed
 * threshold is NOT decided here (it needs tenant-scoped state) — the engine layer applies it after a
 * positive stateless match.
 */
import type { EventEnvelope, Rule } from '@vip/contracts';
import { evaluateCondition } from './condition.js';

export interface RuleEvaluation {
  /** The type/category pre-filter passed. */
  prefilterPassed: boolean;
  /** The detailed predicate tree passed (true when no condition is set). */
  conditionPassed: boolean;
  /** Stateless match = prefilter AND condition (windowing is applied separately). */
  matched: boolean;
}

/** Fast pre-filter: an empty list means "any". */
export function prefilterPasses(rule: Rule, envelope: EventEnvelope): boolean {
  const typeOk = rule.eventTypes.length === 0 || rule.eventTypes.includes(envelope.type);
  const catOk = rule.categories.length === 0 || rule.categories.includes(envelope.category);
  return typeOk && catOk;
}

/** Evaluate a rule's stateless match against one event. No side effects, no incident, no state. */
export function evaluateRule(rule: Rule, envelope: EventEnvelope): RuleEvaluation {
  const prefilterPassed = prefilterPasses(rule, envelope);
  const conditionPassed =
    prefilterPassed && (rule.condition ? evaluateCondition(rule.condition, envelope) : true);
  return { prefilterPassed, conditionPassed, matched: prefilterPassed && conditionPassed };
}

/** Deterministic evaluation order: higher priority first, then id ascending (stable replay). */
export function byEvaluationOrder(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
