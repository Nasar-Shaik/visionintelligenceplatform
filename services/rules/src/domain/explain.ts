/**
 * Domain: **why a rule did or did not fire** (P-4, Architect rec 7).
 *
 * An operator asking that question needs the leaf that decided it and the value it compared against.
 * "Condition did not match" starts an investigation; "confidence was 0.71, the rule needs ≥ 0.8" ends
 * one. The difference costs a support ticket every time.
 *
 * Two properties this module keeps:
 *
 * - **It re-uses the interpreter, never re-implements it.** `explainCondition` walks the same tree
 *   with the same operators as `evaluateCondition`; a second implementation would drift, and the
 *   explanation would eventually describe a decision the engine did not make. A test asserts the two
 *   agree on every node.
 * - **Explanations are derived, never stored** ([Foundation Principle 2]). Nothing consults one, so
 *   an explanation can improve retroactively instead of being frozen in the words of whatever version
 *   wrote it.
 */
import type {
  ConditionTrace,
  EventEnvelope,
  RuleCondition,
  RuleExplanation,
  RulePredicate,
} from '@vip/contracts';
import { evaluatePredicate, getField } from './condition.js';

/** Render a value for an operator to read. Long values are cut rather than filling the screen. */
function show(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.slice(0, 5).map(show).join(', ')}${value.length > 5 ? ', …' : ''}]`;
  if (typeof value === 'object') return '{…}';
  return String(value);
}

const OPERATOR_WORDS: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is one of',
  nin: 'is not one of',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  exists: 'is present',
  contains: 'contains',
};

/** One leaf, explained: what was read, what was expected, and what was actually there. */
function tracePredicate(leaf: RulePredicate, envelope: EventEnvelope): ConditionTrace {
  const actual = getField(envelope, leaf.field);
  const passed = evaluatePredicate(leaf, envelope);
  const words = OPERATOR_WORDS[leaf.op] ?? leaf.op;

  const reason =
    leaf.op === 'exists'
      ? passed
        ? `${leaf.field} is present`
        : `${leaf.field} is absent`
      : passed
        ? `${leaf.field} ${words} ${show(leaf.value)}`
        : `${leaf.field} is ${show(actual)}, which ${words.replace(/^is /, 'is not ')} ${show(leaf.value)}`;

  return {
    kind: 'predicate',
    passed,
    field: leaf.field,
    op: leaf.op,
    expected: leaf.value,
    actual,
    reason,
  };
}

/**
 * Walk a condition tree, recording each node's outcome.
 *
 * Composites are **not short-circuited**. Evaluation stops at the first decisive child because that is
 * correct and fast; an explanation must not, because the leaf that would have failed next is often
 * exactly what the author needs to see. This runs on demand for one event, never in the hot path.
 */
export function explainCondition(
  condition: RuleCondition,
  envelope: EventEnvelope,
): ConditionTrace {
  if ('all' in condition) {
    const children = condition.all.map((child) => explainCondition(child, envelope));
    const failed = children.filter((child) => !child.passed);
    return {
      kind: 'all',
      passed: failed.length === 0,
      children,
      reason:
        failed.length === 0
          ? `all ${children.length} condition(s) matched`
          : `${failed.length} of ${children.length} condition(s) did not match`,
    };
  }

  if ('any' in condition) {
    const children = condition.any.map((child) => explainCondition(child, envelope));
    const passedCount = children.filter((child) => child.passed).length;
    return {
      kind: 'any',
      passed: passedCount > 0,
      children,
      reason:
        passedCount > 0
          ? `${passedCount} of ${children.length} condition(s) matched`
          : `none of the ${children.length} condition(s) matched`,
    };
  }

  if ('not' in condition) {
    const child = explainCondition(condition.not, envelope);
    return {
      kind: 'not',
      passed: !child.passed,
      children: [child],
      reason: child.passed
        ? 'the negated condition matched'
        : 'the negated condition did not match',
    };
  }

  return tracePredicate(condition, envelope);
}

/** The first leaf that failed, depth-first — the one worth putting in a one-line summary. */
export function firstFailure(trace: ConditionTrace): ConditionTrace | undefined {
  if (trace.passed) return undefined;
  for (const child of trace.children ?? []) {
    const failure = firstFailure(child);
    if (failure) return failure;
  }
  return trace.kind === 'predicate' ? trace : undefined;
}

export interface ExplanationStages {
  lifecyclePassed: boolean;
  scopePassed: boolean;
  prefilterPassed: boolean;
  conditionPassed: boolean;
  windowPassed: boolean;
}

export interface ExplanationInput {
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  stages: ExplanationStages;
  /** Why the scope stage came out as it did. */
  scopeReason: string;
  condition?: ConditionTrace | undefined;
  window?: { counted: number; required: number; withinSeconds: number } | undefined;
  /** Which event types/categories the rule pre-filters on, for the prefilter message. */
  prefilterReason: string;
}

/**
 * Assemble the explanation.
 *
 * The stages are checked in the order the engine applies them and the **first** failure decides, so a
 * rule scoped to the wrong site reports the scope rather than a condition that also happens to fail.
 * Reporting the last failure, or all of them, sends someone to fix something that would not have
 * helped.
 */
export function explain(input: ExplanationInput): RuleExplanation {
  const { stages } = input;

  const decided = ((): { decidedBy: RuleExplanation['decidedBy']; summary: string } => {
    if (!stages.lifecyclePassed) {
      return {
        decidedBy: 'lifecycle',
        summary: 'the rule is not enabled, so it was not evaluated',
      };
    }
    if (!stages.scopePassed) return { decidedBy: 'scope', summary: input.scopeReason };
    if (!stages.prefilterPassed) return { decidedBy: 'prefilter', summary: input.prefilterReason };
    if (!stages.conditionPassed) {
      const failure = input.condition ? firstFailure(input.condition) : undefined;
      return {
        decidedBy: 'condition',
        summary: failure?.reason ?? input.condition?.reason ?? 'the condition did not match',
      };
    }
    if (!stages.windowPassed) {
      const w = input.window;
      return {
        decidedBy: 'window',
        summary: w
          ? `${w.counted} of ${w.required} matching events within ${w.withinSeconds}s — not enough yet`
          : 'the windowed threshold was not reached',
      };
    }
    return { decidedBy: 'matched', summary: 'every stage matched — the rule fired' };
  })();

  return {
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    ruleName: input.ruleName,
    matched: decided.decidedBy === 'matched',
    decidedBy: decided.decidedBy,
    summary: decided.summary,
    stages,
    ...(input.condition ? { condition: input.condition } : {}),
    ...(input.window ? { window: input.window } : {}),
  };
}
