/**
 * Domain: **what a rule is allowed to cost** (P-4.1, Architect rec 4).
 *
 * The engine evaluates every enabled rule against every event. That makes one pathological rule not
 * one author's problem but a tenant-wide latency change — and on a shared node, a neighbour's. The
 * defence is a ceiling checked before the rule can go live.
 *
 * The ceilings that matter are the ones with **no natural bound**. `RuleScope` already caps its arrays
 * in the schema, and the event catalogue is finite; what is unbounded is the condition tree, which is
 * recursive and arrives as JSON from a client. A thousand-deep nest of `not` is a stack overflow in
 * the interpreter, reachable by anyone who can call the API.
 *
 * Two deliberate choices:
 *
 * - **Enforced at validation, never during evaluation.** A live rule that suddenly exceeds a limit
 *   because the limit was lowered must keep working. Refusing to evaluate it would convert a
 *   configuration problem into a silent outage, which is a strictly worse failure than the one the
 *   limit was protecting against.
 * - **Measured, then compared.** `measureRule` reports what a rule costs whether or not anything is
 *   wrong, so an author can see they are at 180 of 200 nodes before the day they are at 201.
 *
 * Pure and total.
 */
import {
  DEFAULT_RULE_LIMITS,
  type Rule,
  type RuleComplexity,
  type RuleCondition,
  type RuleLimits,
  type RuleValidationIssue,
} from '@vip/contracts';
import { scopeOf } from './scope.js';

/**
 * Raw object nesting a request body may reach before it is refused, unparsed.
 *
 * Two orders of magnitude below a Node stack limit and one above the deepest sane rule (20 condition
 * levels is already unreadable, and lands near 60 here).
 */
export const MAX_BODY_NESTING = 200;

/**
 * The nesting depth of an **unparsed** body, measured iteratively.
 *
 * This exists because the budget check above runs too late to help. `RuleCondition` is a recursive
 * Zod schema, so a deeply nested body overflows the stack *inside the parser* — before any validation
 * runs, before the rule exists, turning an authenticated request into a crashed handler. The check has
 * to happen on the raw value, and it cannot itself recurse.
 *
 * It measures **raw object nesting**, not condition depth — every array and wrapper counts a level, so
 * one condition level is roughly three here. That is why `MAX_BODY_NESTING` is set far above any
 * legitimate rule rather than derived from `maxConditionDepth`: this is a crash guard, and the precise
 * limit is enforced afterwards by `budgetChecks` with a number that means something to an author.
 *
 * Stops counting at `stopAt`, so a hostile body costs a bounded walk rather than a full traversal.
 */
export function rawDepth(value: unknown, stopAt: number): number {
  let deepest = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    if (deepest > stopAt) return deepest;
    if (node === null || typeof node !== 'object') continue;
    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

/** Nodes and depth of a condition tree, in one walk. */
function measureCondition(condition: RuleCondition): { nodes: number; depth: number } {
  if ('all' in condition || 'any' in condition) {
    const children = 'all' in condition ? condition.all : condition.any;
    let nodes = 1;
    let depth = 0;
    for (const child of children) {
      const measured = measureCondition(child);
      nodes += measured.nodes;
      depth = Math.max(depth, measured.depth);
    }
    return { nodes, depth: depth + 1 };
  }
  if ('not' in condition) {
    const measured = measureCondition(condition.not);
    return { nodes: measured.nodes + 1, depth: measured.depth + 1 };
  }
  return { nodes: 1, depth: 1 };
}

/** What this rule costs. Always computable — a rule is never too broken to measure. */
export function measureRule(rule: Rule): RuleComplexity {
  const condition = rule.condition ? measureCondition(rule.condition) : { nodes: 0, depth: 0 };
  const scope = scopeOf(rule);
  return {
    conditionNodes: condition.nodes,
    conditionDepth: condition.depth,
    eventTypes: rule.eventTypes.length,
    categories: rule.categories.length,
    actions: rule.actions.length,
    scopeNodes: scope.nodeIds.length,
    scopeCameras: scope.cameraIds.length,
    resolvedZones: rule.resolvedScope?.zoneIds.length ?? 0,
  };
}

interface Ceiling {
  readonly measured: keyof RuleComplexity;
  readonly limit: keyof RuleLimits;
  readonly code: string;
  readonly kind: RuleValidationIssue['kind'];
  readonly noun: string;
}

const CEILINGS: readonly Ceiling[] = [
  {
    measured: 'conditionNodes',
    limit: 'maxConditionNodes',
    code: 'condition-too-large',
    kind: 'condition',
    noun: 'condition nodes',
  },
  {
    measured: 'conditionDepth',
    limit: 'maxConditionDepth',
    code: 'condition-too-deep',
    kind: 'condition',
    noun: 'levels of nesting',
  },
  {
    measured: 'eventTypes',
    limit: 'maxEventTypes',
    code: 'too-many-event-types',
    kind: 'event-type',
    noun: 'event types',
  },
  {
    measured: 'categories',
    limit: 'maxCategories',
    code: 'too-many-categories',
    kind: 'category',
    noun: 'categories',
  },
  {
    measured: 'actions',
    limit: 'maxActions',
    code: 'too-many-actions',
    kind: 'action',
    noun: 'actions',
  },
  {
    measured: 'scopeNodes',
    limit: 'maxScopeNodes',
    code: 'scope-too-large',
    kind: 'location',
    noun: 'scoped locations',
  },
  {
    measured: 'scopeCameras',
    limit: 'maxScopeCameras',
    code: 'scope-too-many-cameras',
    kind: 'camera',
    noun: 'scoped cameras',
  },
  {
    measured: 'resolvedZones',
    limit: 'maxResolvedZones',
    code: 'scope-expands-too-far',
    kind: 'location',
    noun: 'covered zones',
  },
];

/**
 * Every ceiling this rule exceeds, as blocking issues.
 *
 * Reports **all** of them rather than the first. An author who fixes one limit only to be told about
 * the next is being made to guess at a number the platform already knows.
 */
export function budgetChecks(
  rule: Rule,
  limits: RuleLimits = DEFAULT_RULE_LIMITS,
): RuleValidationIssue[] {
  const measured = measureRule(rule);
  const issues: RuleValidationIssue[] = [];
  for (const ceiling of CEILINGS) {
    const actual = measured[ceiling.measured];
    const allowed = limits[ceiling.limit];
    if (actual <= allowed) continue;
    issues.push({
      code: ceiling.code,
      severity: 'error',
      kind: ceiling.kind,
      message: `this rule has ${actual} ${ceiling.noun}; the deployment allows ${allowed}`,
    });
  }
  return issues;
}
