/**
 * Domain: **is this rule in good shape?** (P-4.2, Architect rec 2).
 *
 * A health score is easy to build badly. The failure mode is a confident number nobody can take
 * apart: a rule sits at 78, everyone learns 78 is normal, and a real problem hides behind it forever.
 *
 * Three rules keep this one honest:
 *
 * 1. **Every point removed is named.** The score is `100` minus the sum of the findings' deductions,
 *    and the findings travel with it. If the arithmetic and the list ever disagree, the list is right
 *    — which is why the score is computed *from* the list rather than beside it.
 * 2. **`unknown` beats a confident guess.** When validation could not verify its references, the
 *    health of this rule is not known, and saying "82" would be inventing it. Same rule as
 *    `RuleValidationReport.verified`, one layer up.
 * 3. **It reports, it never decides.** Nothing in evaluation reads a health score, and the moment
 *    something did, a rule would fire based on how a node felt about it.
 *
 * Pure: handed what the other modules found, it decides what that means.
 */
import type {
  Rule,
  RuleComplexityReport,
  RuleDependencyGraph,
  RuleHealth,
  RuleHealthFinding,
  RuleHealthStatus,
  RuleRuntimeStats,
  RuleValidationReport,
} from '@vip/contracts';

/** How long a scope expansion may go unrefreshed before it is worth mentioning. */
export const SCOPE_STALE_AFTER_DAYS = 30;

/**
 * A rule enabled this long ago with zero evaluations on this node is worth a look — but only after
 * long enough that a quiet night does not raise it.
 */
const IDLE_AFTER_HOURS = 24;

export interface HealthInputs {
  rule: Rule;
  validation: RuleValidationReport;
  complexity: RuleComplexityReport;
  dependencies: RuleDependencyGraph;
  /** This node's counters, when it evaluates. Absent is not a finding — it is a different question. */
  runtime?: RuleRuntimeStats | undefined;
  /** How long this node has been collecting, so "never evaluated" is only claimed when it means something. */
  uptimeSeconds?: number | undefined;
  now: Date;
}

const finding = (
  code: string,
  severity: RuleHealthFinding['severity'],
  message: string,
  deduction: number,
): RuleHealthFinding => ({ code, severity, message, deduction });

function ageInDays(from: string, now: Date): number {
  return (now.getTime() - new Date(from).getTime()) / 86_400_000;
}

/**
 * Assess a rule.
 *
 * Deductions are weighted by **what an operator would actually do about it**: a broken reference is
 * worth fixing today, a stale expansion is worth a click, and a complex rule is worth knowing about
 * and usually worth nothing else.
 */
export function assessHealth(inputs: HealthInputs): RuleHealth {
  const { rule, validation, complexity, dependencies, runtime, now } = inputs;
  const findings: RuleHealthFinding[] = [];

  // --- Validation: the strongest signal, and the one that can make the whole verdict unknown. ---
  if (!validation.verified) {
    findings.push(
      finding(
        'unverified',
        'error',
        'some of this rule’s references could not be checked — the owning service was unavailable',
        0, // Deducts nothing: the status becomes `unknown`, and scoring an unknown is the mistake.
      ),
    );
  } else {
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    const warnings = validation.issues.filter((issue) => issue.severity === 'warning');
    if (errors.length > 0) {
      findings.push(
        finding(
          'validation-errors',
          'error',
          `${errors.length} problem(s) block this rule: ${errors[0]!.message}`,
          50,
        ),
      );
    }
    if (warnings.length > 0) {
      findings.push(
        finding(
          'validation-warnings',
          'warning',
          `${warnings.length} warning(s): ${warnings[0]!.message}`,
          10,
        ),
      );
    }
  }

  // --- Dependencies: something the rule points at is not there. ---
  if (dependencies.statusChecked) {
    const broken = dependencies.dependencies.filter(
      (dep) => dep.status === 'missing' || dep.status === 'archived',
    );
    if (broken.length > 0) {
      findings.push(
        finding(
          'broken-dependencies',
          'error',
          `${broken.length} reference(s) no longer resolve, starting with ${broken[0]!.kind} "${broken[0]!.ref}"`,
          30,
        ),
      );
    }
  }

  // --- Scope: resolved, and how long ago. ---
  const authoredScope = rule.scope;
  const isScoped =
    (authoredScope?.nodeIds.length ?? 0) > 0 || (authoredScope?.cameraIds.length ?? 0) > 0;
  if (isScoped && !rule.resolvedScope) {
    findings.push(
      finding(
        'scope-unresolved',
        'error',
        'this rule names locations but has no resolved scope, so it matches nothing',
        40,
      ),
    );
  } else if (rule.resolvedScope && !rule.resolvedScope.tenantWide) {
    const days = ageInDays(rule.resolvedScope.resolvedAt, now);
    if (days > SCOPE_STALE_AFTER_DAYS) {
      findings.push(
        finding(
          'scope-stale',
          'warning',
          `the covered zones were last worked out ${Math.floor(days)} days ago — zones added since are not covered`,
          10,
        ),
      );
    }
  }

  // --- Runtime: what this node has actually seen. ---
  if (runtime) {
    if (runtime.failures > 0) {
      findings.push(
        finding(
          'evaluation-failures',
          'error',
          `${runtime.failures} evaluation(s) of this rule threw — that is a defect, not a tuning signal`,
          40,
        ),
      );
    }
    const observedLongEnough = (inputs.uptimeSeconds ?? 0) > IDLE_AFTER_HOURS * 3600;
    if (rule.lifecycle === 'enabled' && runtime.evaluations === 0 && observedLongEnough) {
      findings.push(
        finding(
          'never-evaluated',
          'warning',
          'this rule is enabled but has not been evaluated on this node — no events are reaching it',
          15,
        ),
      );
    }
    if (rule.lifecycle === 'enabled' && runtime.evaluations > 10_000 && runtime.matches === 0) {
      findings.push(
        finding(
          'never-matched',
          'info',
          `evaluated ${runtime.evaluations} times and never matched — check the condition against a real event`,
          5,
        ),
      );
    }
  }

  // --- Complexity: worth knowing, rarely worth acting on. ---
  if (complexity.class === 'very-complex') {
    findings.push(
      finding(
        'very-complex',
        'warning',
        `this rule is at ${complexity.utilization}% of a deployment ceiling`,
        10,
      ),
    );
  }

  /*
   * Unverified wins over everything. A score computed from checks that did not run is the same class
   * of mistake as activating on one — see `RuleValidationReport.verified`, and Foundation Principle 3
   * underneath it.
   */
  if (!validation.verified) {
    return {
      ruleId: rule.id,
      ruleVersion: rule.version,
      status: 'unknown',
      score: 0,
      findings,
      assessedAt: now.toISOString(),
    };
  }

  const deducted = findings.reduce((sum, item) => sum + item.deduction, 0);
  const score = Math.max(0, 100 - deducted);
  const status: RuleHealthStatus = findings.some((item) => item.severity === 'error')
    ? 'unhealthy'
    : findings.some((item) => item.severity === 'warning')
      ? 'degraded'
      : 'healthy';

  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    status,
    score,
    findings,
    assessedAt: now.toISOString(),
  };
}
