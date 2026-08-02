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
  RuleStage,
  StageTrace,
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

  /*
   * The stage list is built **once** and both answers are read off it: the one-line summary and the
   * tree (P-4.1, Architect rec 6). Assembling them separately is how a summary that names the scope
   * ends up beside a tree whose scope node is green — two descriptions of one evaluation that drift
   * the first time either is edited.
   */
  const ordered: Array<{ stage: RuleStage; passed: boolean; reason: string }> = [
    {
      stage: 'lifecycle',
      passed: stages.lifecyclePassed,
      reason: stages.lifecyclePassed
        ? 'the rule is enabled'
        : 'the rule is not enabled, so it was not evaluated',
    },
    { stage: 'scope', passed: stages.scopePassed, reason: input.scopeReason },
    { stage: 'prefilter', passed: stages.prefilterPassed, reason: input.prefilterReason },
    {
      stage: 'condition',
      passed: stages.conditionPassed,
      reason: conditionReason(input),
    },
    { stage: 'window', passed: stages.windowPassed, reason: windowReason(input) },
  ];

  const failure = ordered.find((stage) => !stage.passed);
  const decidedBy: RuleExplanation['decidedBy'] = failure?.stage ?? 'matched';
  const summary = failure?.reason ?? 'every stage matched — the rule fired';

  /*
   * Stages after the decisive one are still reported, with the verdict the caller supplied. Evaluation
   * short-circuits and the caller may not have run them; what the tree must never do is invent a
   * result. Marking the decisive node is what stops a reader mistaking a not-reached stage for a
   * passing one — and on a match **no** node is decisive, because every stage was.
   */
  const tree: StageTrace[] = ordered.map((stage) => ({
    stage: stage.stage,
    passed: stage.passed,
    decisive: stage.stage === failure?.stage,
    reason: stage.reason,
    ...(stage.stage === 'condition' && input.condition ? { children: [input.condition] } : {}),
  }));

  return {
    ruleId: input.ruleId,
    ruleVersion: input.ruleVersion,
    ruleName: input.ruleName,
    matched: decidedBy === 'matched',
    decidedBy,
    summary,
    stages,
    tree,
    ...(input.condition ? { condition: input.condition } : {}),
    ...(input.window ? { window: input.window } : {}),
  };
}

/** The condition stage in one line — the first failing leaf when it failed, the root when it passed. */
function conditionReason(input: ExplanationInput): string {
  if (!input.condition) return 'the rule has no condition beyond its pre-filter';
  if (input.stages.conditionPassed) return input.condition.reason;
  return firstFailure(input.condition)?.reason ?? input.condition.reason;
}

function windowReason(input: ExplanationInput): string {
  const w = input.window;
  if (!w) {
    return input.stages.windowPassed
      ? 'the rule has no windowed threshold'
      : 'the windowed threshold was not reached';
  }
  return input.stages.windowPassed
    ? `${w.counted} of ${w.required} matching events within ${w.withinSeconds}s — the threshold is met`
    : `${w.counted} of ${w.required} matching events within ${w.withinSeconds}s — not enough yet`;
}
