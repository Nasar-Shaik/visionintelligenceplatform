/**
 * Domain: **what actually changed between two versions** (P-4.2, Architect rec 6).
 *
 * The version history says a rule changed. That is enough to notice and never enough to review — the
 * question is always _which condition was added, which zone left the scope, did the severity move_.
 * A reviewer who has to open two JSON blobs and compare them by eye will do it once and then stop.
 *
 * Two properties:
 *
 * - **It works on any pair in the history**, including two versions written long before this module
 *   existed, because it reads the immutable snapshots rather than a change record someone had to
 *   remember to write.
 * - **It reports behaviour separately from bookkeeping.** `behaviourUnchanged` comes from the content
 *   hash, so "renamed, nothing else" is one glance rather than a careful read of nine areas.
 *
 * Pure.
 */
import type { Rule, RuleCondition, RuleDiff, RuleDiffChange, RuleScope } from '@vip/contracts';
import { contentHash } from './fingerprint.js';
import { scopeOf } from './scope.js';

function short(value: unknown): string {
  if (value === undefined || value === null) return 'nothing';
  if (typeof value === 'string') return `"${value}"`;
  if (Array.isArray(value)) return value.length === 0 ? 'nothing' : value.join(', ');
  if (typeof value === 'object') return 'a different shape';
  return String(value);
}

/** Set difference in both directions, for the many list-shaped fields on a rule. */
function listChanges(
  area: RuleDiffChange['area'],
  path: string,
  noun: string,
  before: readonly string[],
  after: readonly string[],
): RuleDiffChange[] {
  const added = after.filter((item) => !before.includes(item));
  const removed = before.filter((item) => !after.includes(item));
  const changes: RuleDiffChange[] = [];
  if (added.length > 0) {
    changes.push({
      area,
      kind: 'added',
      path,
      summary: `added ${noun} ${added.join(', ')}`,
      after: added,
    });
  }
  if (removed.length > 0) {
    changes.push({
      area,
      kind: 'removed',
      path,
      summary: `removed ${noun} ${removed.join(', ')}`,
      before: removed,
    });
  }
  return changes;
}

/**
 * Flatten a condition tree into comparable leaves.
 *
 * Compared as a **set of leaves**, not structurally. A structural diff of a recursive tree produces
 * output like "the third child of the second `all` changed", which is accurate and unreadable. What a
 * reviewer wants is which predicates are new and which are gone; the rare case where only the boolean
 * shape moved is caught separately by comparing the serialised tree.
 */
function conditionLeaves(condition: RuleCondition | undefined, into: string[] = []): string[] {
  if (!condition) return into;
  if ('all' in condition) {
    for (const child of condition.all) conditionLeaves(child, into);
    return into;
  }
  if ('any' in condition) {
    for (const child of condition.any) conditionLeaves(child, into);
    return into;
  }
  if ('not' in condition) {
    conditionLeaves(condition.not, into);
    return into;
  }
  into.push(
    condition.op === 'exists'
      ? `${condition.field} exists`
      : `${condition.field} ${condition.op} ${short(condition.value)}`,
  );
  return into;
}

function scopeChanges(before: RuleScope, after: RuleScope): RuleDiffChange[] {
  return [
    ...listChanges('scope', 'scope.nodeIds', 'location', before.nodeIds, after.nodeIds),
    ...listChanges('scope', 'scope.cameraIds', 'camera', before.cameraIds, after.cameraIds),
  ];
}

function scalarChange(
  area: RuleDiffChange['area'],
  path: string,
  label: string,
  before: unknown,
  after: unknown,
): RuleDiffChange[] {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return [];
  return [
    {
      area,
      kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
      path,
      summary: `${label} ${short(before)} → ${short(after)}`,
      before,
      after,
    },
  ];
}

/**
 * Compare two versions of a rule.
 *
 * `from` and `to` are whichever versions the caller asked for — the function does not assume `to` is
 * later, because comparing backwards is a legitimate thing to want and silently reversing the answer
 * would be worse than either direction.
 */
export function diffRules(from: Rule, to: Rule): RuleDiff {
  const changes: RuleDiffChange[] = [
    ...scalarChange('identity', 'name', 'name', from.name, to.name),
    ...scalarChange('identity', 'description', 'description', from.description, to.description),
    ...scalarChange('lifecycle', 'lifecycle', 'lifecycle', from.lifecycle, to.lifecycle),
    ...scalarChange('priority', 'priority', 'priority', from.priority, to.priority),
    ...scalarChange('severity', 'severity', 'severity', from.severity, to.severity),
    ...listChanges('prefilter', 'eventTypes', 'event type', from.eventTypes, to.eventTypes),
    ...listChanges('prefilter', 'categories', 'category', from.categories, to.categories),
    ...scopeChanges(scopeOf(from), scopeOf(to)),
  ];

  // Conditions: leaves added and removed, plus a note when only the boolean structure moved.
  const beforeLeaves = conditionLeaves(from.condition);
  const afterLeaves = conditionLeaves(to.condition);
  changes.push(...listChanges('condition', 'condition', 'condition', beforeLeaves, afterLeaves));
  const sameLeaves =
    beforeLeaves.length === afterLeaves.length &&
    beforeLeaves.every((leaf) => afterLeaves.includes(leaf));
  if (
    sameLeaves &&
    JSON.stringify(from.condition ?? null) !== JSON.stringify(to.condition ?? null)
  ) {
    changes.push({
      area: 'condition',
      kind: 'changed',
      path: 'condition',
      summary: 'the same conditions, combined differently (all/any/not restructured)',
      before: from.condition,
      after: to.condition,
    });
  }

  changes.push(
    ...scalarChange(
      'window',
      'window',
      'windowed threshold',
      from.window
        ? `${from.window.count} within ${from.window.withinSeconds}s per ${from.window.groupBy}`
        : undefined,
      to.window
        ? `${to.window.count} within ${to.window.withinSeconds}s per ${to.window.groupBy}`
        : undefined,
    ),
  );

  changes.push(
    ...listChanges(
      'actions',
      'actions',
      'action',
      from.actions.map((action) => action.type),
      to.actions.map((action) => action.type),
    ),
  );

  return {
    ruleId: to.id,
    fromVersion: from.version,
    toVersion: to.version,
    // The hash excludes name, description and lifecycle — so a rename reports `true` here, correctly.
    behaviourUnchanged: contentHash(from) === contentHash(to),
    changes,
  };
}
