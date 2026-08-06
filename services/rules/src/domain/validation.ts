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
  type RuleLimits,
  type RuleReferenceKind,
  type RuleValidationIssue,
  type RuleValidationReport,
} from '@vip/contracts';
import { budgetChecks } from './budget.js';
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

  // --- P-8 Phase 7 ------------------------------------------------------------------------------
  /** Camera groups named by the scope that the camera service could not find. */
  missingGroupIds?: readonly string[];
  /** Groups that exist but hold no cameras — inert, not invalid. */
  emptyGroupIds?: readonly string[];
  /** Cameras the named groups expanded to. */
  groupCameraIds?: readonly string[];
  /** Detection zones named by the scope that do not exist. */
  missingZoneIds?: readonly string[];
  /** Detection zones that exist but are switched off. */
  disabledZoneIds?: readonly string[];
  /** Which camera each named zone belongs to — for the zone-outside-camera-scope check. */
  zoneCameraIds?: Readonly<Record<string, string>>;

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

  issues.push(...dwellChecks(rule));
  return issues;
}

/**
 * **Dwell coherence** (P-8 Phase 7) — every way a dwell rule can be configured to never fire.
 *
 * Each of these is a rule that saves cleanly, enables cleanly, reports healthy, and does nothing. A
 * loitering rule that silently never fires is the single most expensive failure this milestone can
 * ship, because the customer discovers it by *not* being told about a theft. So the checks are
 * deliberately opinionated and say what to do rather than what is wrong.
 */
export function dwellChecks(rule: Rule): RuleValidationIssue[] {
  const dwell = rule.dwell;
  if (dwell === undefined) return [];
  const issues: RuleValidationIssue[] = [];

  /*
   * ⚠️ The reset must exceed the observation interval or the visit resets between frames and nothing
   * ever accumulates. The platform's conservative sizing runs at 2 fps, so a reset under a second is
   * always wrong; between 1s and 5s it depends on the deployment's frame rate, which this pure module
   * cannot know — hence a warning rather than an error.
   */
  if (dwell.resetAfterSeconds < 1) {
    issues.push(
      issue(
        'dwell-reset-too-short',
        'error',
        'dwell',
        `a reset of ${dwell.resetAfterSeconds}s is shorter than the gap between two frames — every observation would start a new visit and the threshold could never be reached`,
      ),
    );
  } else if (dwell.resetAfterSeconds < 5) {
    issues.push(
      issue(
        'dwell-reset-near-frame-interval',
        'warning',
        'dwell',
        `a reset of ${dwell.resetAfterSeconds}s is close to the frame interval on a conservatively sized deployment — a single dropped frame would restart the clock`,
      ),
    );
  }

  if (dwell.minSeconds <= dwell.resetAfterSeconds) {
    issues.push(
      issue(
        'dwell-threshold-below-reset',
        'warning',
        'dwell',
        `the threshold (${dwell.minSeconds}s) is at or below the reset (${dwell.resetAfterSeconds}s) — a subject seen twice that far apart fires immediately, which is probably not the intent`,
      ),
    );
  }

  /*
   * ⚠️ Without a cool-down a rule past its threshold raises on EVERY frame — 120 candidates a minute
   * at 2 fps for one stationary person. It is legal, because a rule with a long reset may want
   * exactly one candidate per visit and gets it from the visit lifecycle. It is warned about, loudly,
   * because the far more common reason for a zero here is that nobody thought about it.
   */
  if (dwell.cooldownSeconds === 0) {
    issues.push(
      issue(
        'dwell-no-cooldown',
        'warning',
        'dwell',
        'with no cool-down this rule raises a candidate on every frame once the threshold is met — set one unless the reset window is doing that job',
      ),
    );
  }

  /*
   * A dwell rule needs a subject on every event it evaluates. It cannot check that from here — the
   * producer decides — but it CAN check that the author has not scoped the rule to event types that
   * structurally carry no subject at all.
   */
  const subjectless = rule.eventTypes.filter(
    (t) => t.startsWith('system.') || t.startsWith('camera.'),
  );
  for (const type of subjectless) {
    issues.push(
      issue(
        'dwell-on-subjectless-event',
        'error',
        'dwell',
        `"${type}" carries no tracked subject, so there is nothing for a dwell rule to accumulate against`,
        type,
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

  // --- P-8 Phase 7: groups and detection zones --------------------------------------------------

  for (const groupId of findings.missingGroupIds ?? []) {
    issues.push(
      issue(
        'missing-camera-group',
        'error',
        'camera-group',
        `camera group "${groupId}" does not exist in this tenant`,
        groupId,
      ),
    );
  }

  for (const groupId of findings.emptyGroupIds ?? []) {
    issues.push(
      issue(
        'empty-camera-group',
        'warning',
        'camera-group',
        `camera group "${groupId}" holds no cameras — it contributes nothing to this rule's scope yet`,
        groupId,
      ),
    );
  }

  for (const zoneId of findings.missingZoneIds ?? []) {
    issues.push(
      issue(
        'missing-zone',
        'error',
        'zone',
        `detection zone "${zoneId}" does not exist in this tenant`,
        zoneId,
      ),
    );
  }

  for (const zoneId of findings.disabledZoneIds ?? []) {
    issues.push(
      issue(
        'disabled-zone',
        'warning',
        'zone',
        `detection zone "${zoneId}" is switched off — no event will be stamped with it, so this rule will not fire on it`,
        zoneId,
      ),
    );
  }

  /*
   * ⚠️ A zone on a camera the rule does not cover.
   *
   * This one is worth an error rather than a warning, and it is the mistake an operator makes most:
   * they scope a rule to "the front-door camera" and then pick a zone drawn on the stockroom camera
   * from a list that shows every zone in the tenant. `matchesScope` narrows to the zone, so the rule
   * covers the intersection — which is empty. It saves, it validates, it enables, and it can never
   * fire.
   */
  const zoneCameras = findings.zoneCameraIds ?? {};
  const scopedCameras = new Set(scopeOf(rule).cameraIds ?? []);
  const groupCameras = findings.groupCameraIds ?? [];
  for (const cameraId of groupCameras) scopedCameras.add(cameraId);
  if (scopedCameras.size > 0) {
    for (const [zoneId, cameraId] of Object.entries(zoneCameras)) {
      if (scopedCameras.has(cameraId)) continue;
      issues.push(
        issue(
          'zone-outside-camera-scope',
          'error',
          'zone',
          `zone "${zoneId}" is on camera "${cameraId}", which this rule's camera scope does not cover — the two scopes intersect to nothing and the rule can never fire`,
          zoneId,
        ),
      );
    }
  }

  /*
   * A scope that names real places but expands to no zones is legal, inert, and almost certainly a
   * mistake — an empty building, say. A warning rather than an error: an operator may be scoping a
   * rule ahead of installing the cameras, and refusing that would make the product argue with them.
   */
  const authored = scopeOf(rule);
  const scoped = (authored.nodeIds?.length ?? 0) > 0 || (authored.cameraIds?.length ?? 0) > 0;
  const resolvedNothing =
    (findings.resolvedZoneIds?.length ?? 0) === 0 && (authored.cameraIds?.length ?? 0) === 0;
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
  /** Deployment ceilings (P-4.1, Architect rec 4). Defaults to the documented set. */
  limits?: RuleLimits,
): RuleValidationReport {
  const issues = [
    ...selfChecks(rule),
    ...budgetChecks(rule, limits),
    ...referenceChecks(rule, findings),
  ];

  const authored = scopeOf(rule);
  const needed: RuleReferenceKind[] = ['event-type', 'category', 'action'];
  if ((authored.nodeIds?.length ?? 0) > 0) needed.push('location');
  if ((authored.cameraIds?.length ?? 0) > 0) needed.push('camera');
  if ((authored.groupIds?.length ?? 0) > 0) needed.push('camera-group');
  if ((authored.zoneIds?.length ?? 0) > 0) needed.push('zone');

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
