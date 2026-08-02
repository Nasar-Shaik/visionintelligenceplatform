/**
 * Domain: **rule validation** (P-4, Architect rec 5).
 *
 * A rule that references a zone which no longer exists, or an event type nothing produces, is not a
 * rule — it is a rule-shaped object that will never fire, and the customer will not find out until
 * the incident they expected never arrives. Validation catches that **before activation**.
 *
 * The rule this module encodes, and the one worth stating plainly:
 *
 * > **A check that could not run is not a check that passed.**
 *
 * When the context that owns a referenced thing is unreachable, the report says `verified: false` and
 * the rule cannot be enabled. Letting a rule go live because a check was skipped is the configuration
 * version of certifying hardware from a simulation — the exact failure
 * [Foundation Principle 3](../../../../docs/project/FOUNDATION_PRINCIPLES.md) exists to prevent.
 *
 * Pure: this module is handed what the providers found and decides what it means. It cannot query.
 */
import {
  EVENT_CATALOG,
  isKnownEventType,
  type Rule,
  type RuleReferenceKind,
  type RuleValidationIssue,
  type RuleValidationReport,
} from '@vip/contracts';
import { scopeOf } from './scope.js';

/** What the reference providers found, gathered by the application layer. */
export interface ReferenceFindings {
  /** Node ids named by the scope that the hierarchy could not find. */
  missingNodeIds?: readonly string[];
  /** Camera ids named by the scope that the camera inventory could not find. */
  missingCameraIds?: readonly string[];
  /** Nodes that resolved but are archived — a rule scoped to a retired place fires on nothing. */
  archivedNodeIds?: readonly string[];
  /** Zone ids the scope expanded to. Used to warn about a scope that covers nothing. */
  resolvedZoneIds?: readonly string[];
  /** Which reference kinds were actually checked. Anything absent was not looked at. */
  checked: readonly RuleReferenceKind[];
}

const issue = (
  code: string,
  severity: RuleValidationIssue['severity'],
  kind: RuleReferenceKind,
  message: string,
  ref?: string,
): RuleValidationIssue => ({ code, severity, kind, message, ...(ref ? { ref } : {}) });

/**
 * Checks that need no other context — the rule is inspected against itself and the event catalog,
 * which is compiled in. These always run, so a rule is never completely unchecked.
 */
export function selfChecks(rule: Rule): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];

  for (const type of rule.eventTypes) {
    if (!isKnownEventType(type)) {
      issues.push(
        issue(
          'unknown-event-type',
          'error',
          'event-type',
          `no capability publishes "${type}" — this rule would never fire`,
          type,
        ),
      );
    }
  }

  // A rule filtering on a category that no catalogued type belongs to is equally inert.
  for (const category of rule.categories) {
    const known = EVENT_CATALOG.some((entry) => entry.category === category);
    if (!known) {
      issues.push(
        issue(
          'unknown-category',
          'error',
          'category',
          `no event type belongs to category "${category}"`,
          category,
        ),
      );
    }
  }

  if (rule.actions.length === 0) {
    issues.push(issue('no-actions', 'error', 'action', 'a rule with no action cannot do anything'));
  }

  for (const action of rule.actions) {
    if (action.type === 'emit-event' && !isKnownEventType(action.eventType)) {
      issues.push(
        issue(
          'unknown-emit-type',
          'error',
          'action',
          `this rule emits "${action.eventType}", which is not in the event catalog`,
          action.eventType,
        ),
      );
    }
  }

  /*
   * A window grouped by zone or camera on a rule whose events may carry neither would count every
   * such event into one bucket. Not wrong, but rarely what the author meant — a warning, because
   * "rarely" is not "never".
   */
  if (rule.window && rule.window.groupBy !== 'none' && rule.eventTypes.length === 0) {
    issues.push(
      issue(
        'ungrouped-window',
        'warning',
        'event-type',
        `this rule counts per ${rule.window.groupBy} but matches any event type — events without a ${rule.window.groupBy} all share one counter`,
      ),
    );
  }

  return issues;
}

/** Checks that depend on another context having answered. */
export function referenceChecks(rule: Rule, findings: ReferenceFindings): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];

  for (const nodeId of findings.missingNodeIds ?? []) {
    issues.push(
      issue(
        'missing-location',
        'error',
        'location',
        `location "${nodeId}" does not exist in this tenant`,
        nodeId,
      ),
    );
  }

  for (const nodeId of findings.archivedNodeIds ?? []) {
    issues.push(
      issue(
        'archived-location',
        'error',
        'location',
        `location "${nodeId}" is archived — a rule scoped to a retired place fires on nothing`,
        nodeId,
      ),
    );
  }

  for (const cameraId of findings.missingCameraIds ?? []) {
    issues.push(
      issue(
        'missing-camera',
        'error',
        'camera',
        `camera "${cameraId}" does not exist in this tenant`,
        cameraId,
      ),
    );
  }

  /*
   * A scope that names real places but expands to no zones is legal, inert, and almost certainly a
   * mistake — an empty building, say. A warning rather than an error: an operator may be scoping a
   * rule ahead of installing the cameras, and refusing that would make the product argue with them.
   */
  const authored = scopeOf(rule);
  const scoped = authored.nodeIds.length > 0 || authored.cameraIds.length > 0;
  const resolvedNothing =
    (findings.resolvedZoneIds?.length ?? 0) === 0 && authored.cameraIds.length === 0;
  if (scoped && resolvedNothing && findings.checked.includes('location')) {
    issues.push(
      issue(
        'empty-scope',
        'warning',
        'location',
        'this scope contains no zones yet — the rule will not fire until one exists',
      ),
    );
  }

  return issues;
}

/**
 * Build the report.
 *
 * `verified` is true only when **every** reference the rule actually makes was checked. A rule with
 * no scope needs no location check, so it can be fully verified without the hierarchy being
 * reachable — the requirement is proportional to what the rule references, not a blanket demand.
 */
export function validateRule(
  rule: Rule,
  findings: ReferenceFindings,
  at: Date,
): RuleValidationReport {
  const issues = [...selfChecks(rule), ...referenceChecks(rule, findings)];

  const authored = scopeOf(rule);
  const needed: RuleReferenceKind[] = ['event-type', 'category', 'action'];
  if (authored.nodeIds.length > 0) needed.push('location');
  if (authored.cameraIds.length > 0) needed.push('camera');

  const checked = new Set(findings.checked);
  const verified = needed.every((kind) => checked.has(kind));
  const hasErrors = issues.some((i) => i.severity === 'error');

  if (!verified) {
    const unchecked = needed.filter((kind) => !checked.has(kind));
    for (const kind of unchecked) {
      issues.push(
        issue(
          'unverified-reference',
          'error',
          kind,
          `${kind} references could not be checked — the owning service was unavailable. A rule is not activated on an unverified check.`,
        ),
      );
    }
  }

  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    valid: verified && !hasErrors,
    verified,
    issues,
    checked: [...checked],
    checkedAt: at.toISOString(),
  };
}

/** Whether a report permits the rule to be enabled. Errors block; warnings do not. */
export function permitsActivation(report: RuleValidationReport | undefined): boolean {
  return report?.valid === true;
}
