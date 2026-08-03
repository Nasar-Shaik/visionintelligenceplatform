/**
 * Investigation metrics (P-5.4, Architect rec 10) — duration, counts, dispositions, escalation rate
 * and operator workload.
 *
 * ⚠️ **Derived on read, never stored** (CONSTRAINTS §46). A stored metric is a number that was true
 * once, and the first time an incident is reassigned or reopened it becomes a number that disagrees
 * with the records it summarises. Everything here is computed from incidents that already exist.
 *
 * Three of the requested measures could not be reserved as asked, and each is reserved differently
 * for a stated reason.
 *
 * ### ⚠️ 1. A false negative is, by construction, not in the data
 *
 * A false positive is an incident that was raised and should not have been — the record exists, so
 * it can be counted. A **false negative is an incident that was never raised**: there is no
 * document, no event, no trace. Nothing the platform can query will ever find one, and a dashboard
 * that computes "false negatives: 0" from platform data is stating the one thing it cannot know,
 * on the metric a customer is most likely to make a purchasing decision on.
 *
 * So `falseNegatives` is **externally reported**: a count somebody entered, with a source and a
 * date. Absent means *not known*, and the surface says "not measured" rather than drawing a zero.
 *
 * ### ⚠️ 2. A false positive needs a declaration, never an inference
 *
 * The tempting shortcut is to infer one — resolved quickly, resolved with no evidence, closed
 * without escalation. Every one of those is also what a well-handled real incident looks like. So a
 * false positive is counted only from an explicit {@link IncidentDisposition} recorded by a person,
 * and incidents with no disposition are reported as `undisposed` rather than assumed genuine.
 *
 * ### ⚠️ 3. Operator workload is staff monitoring, and it is gated as such
 *
 * "Incidents handled per operator" is a productivity measure of named employees. This platform has
 * already had one finding of exactly this class — `audit:read` would have exposed a staff-activity
 * log to every `viewer` because `viewer` holds `*:read` (TD-26, §69). The same hazard applies here
 * and is handled the same way: a **distinct, non-wildcard permission** (`metrics:workload`), and an
 * aggregate-only default so the common dashboard never needs it.
 *
 * ⚠️ **Frozen with no producer.** Nothing computes any of this.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/**
 * What a person concluded an incident actually was.
 *
 * ⚠️ Recorded, never inferred — see note 2. `inconclusive` exists so an honest operator is not
 * forced to choose between two claims they cannot support; without it, everything ambiguous gets
 * filed as genuine and the false-positive rate reads better than it is.
 */
export const IncidentDisposition = z.enum([
  'confirmed',
  'false-positive',
  'inconclusive',
  'duplicate',
]);
export type IncidentDisposition = z.infer<typeof IncidentDisposition>;

/** The window a metric covers. Always explicit: a rate with no window is not a rate. */
export const MetricWindow = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
});
export type MetricWindow = z.infer<typeof MetricWindow>;

/**
 * A count with the sample it came from.
 *
 * ⚠️ `sampleSize` is carried beside every average because a mean resolution time over three
 * incidents and one over three thousand are rendered identically and mean entirely different
 * things. A surface that shows the mean without the sample invites a decision the data cannot bear.
 */
export const MetricAverage = z.object({
  /** ⚠️ Absent ⇒ no qualifying incidents, never 0 — a zero mean duration is not a fast team. */
  meanSeconds: z.number().nonnegative().optional(),
  medianSeconds: z.number().nonnegative().optional(),
  sampleSize: z.number().int().min(0),
});
export type MetricAverage = z.infer<typeof MetricAverage>;

/**
 * An externally reported figure — something a person asserted that the platform cannot observe.
 *
 * ⚠️ `source` is required. A number with no attribution ends up quoted in a report a year later
 * with nobody able to say where it came from.
 */
export const ReportedMetric = z.object({
  value: z.number().int().min(0),
  source: z.string().min(1).max(300),
  reportedBy: z.string().min(1),
  reportedAt: IsoDateTime,
});
export type ReportedMetric = z.infer<typeof ReportedMetric>;

/**
 * Tenant-level investigation metrics over a window. **Aggregate only** — nothing here names a
 * person, which is what lets the ordinary dashboard run on `metrics:read`.
 */
export const InvestigationMetrics = z
  .object({
    tenantId: TenantId,
    window: MetricWindow,
    incidentCount: z.number().int().min(0),
    evidenceCount: z.number().int().min(0),
    /** Time from raise to resolve. */
    resolutionTime: MetricAverage,
    /** Time from first operator action to resolve — how long the *work* took. */
    investigationDuration: MetricAverage,
    /** Incidents that reached `escalated` at any point. */
    escalatedCount: z.number().int().min(0),
    /** Dispositions actually recorded. */
    confirmedCount: z.number().int().min(0),
    falsePositiveCount: z.number().int().min(0),
    inconclusiveCount: z.number().int().min(0),
    duplicateCount: z.number().int().min(0),
    /**
     * ⚠️ Incidents with **no disposition recorded**. Reported rather than folded into `confirmed`:
     * the difference between "we checked and it was real" and "nobody said" is the whole reliability
     * of every other number in this object.
     */
    undisposedCount: z.number().int().min(0),
    /** ⚠️ Externally reported. Absent ⇒ not measured. See note 1. */
    falseNegatives: ReportedMetric.optional(),
    derivedAt: IsoDateTime,
  })
  .superRefine((metrics, ctx) => {
    const dispositioned =
      metrics.confirmedCount +
      metrics.falsePositiveCount +
      metrics.inconclusiveCount +
      metrics.duplicateCount +
      metrics.undisposedCount;
    if (dispositioned !== metrics.incidentCount) {
      ctx.addIssue({
        code: 'custom',
        message: `dispositions must account for every incident (${dispositioned} vs ${metrics.incidentCount})`,
      });
    }
    if (metrics.escalatedCount > metrics.incidentCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['escalatedCount'],
        message: 'more incidents escalated than exist in the window',
      });
    }
  });
export type InvestigationMetrics = z.infer<typeof InvestigationMetrics>;

/**
 * Escalation rate, 0–1.
 *
 * ⚠️ Returns `undefined` for an empty window rather than 0. "No incidents" and "no escalations out
 * of many" are different facts, and only one of them is a compliment.
 */
export function escalationRate(metrics: InvestigationMetrics): number | undefined {
  if (metrics.incidentCount === 0) return undefined;
  return metrics.escalatedCount / metrics.incidentCount;
}

/**
 * False-positive rate over **dispositioned** incidents only, 0–1.
 *
 * ⚠️ The denominator deliberately excludes `undisposedCount`. Including it would let an unreviewed
 * backlog silently improve the rate — the more work nobody did, the better the number would look.
 */
export function falsePositiveRate(metrics: InvestigationMetrics): number | undefined {
  const dispositioned =
    metrics.confirmedCount +
    metrics.falsePositiveCount +
    metrics.inconclusiveCount +
    metrics.duplicateCount;
  if (dispositioned === 0) return undefined;
  return metrics.falsePositiveCount / dispositioned;
}

// ---------------------------------------------------------------------------------------------
// ⚠️ Operator workload — staff monitoring, gated separately. See note 3.
// ---------------------------------------------------------------------------------------------

/**
 * One named operator's throughput.
 *
 * ⚠️ **Reading this requires `metrics:workload`**, which is deliberately not covered by any
 * wildcard a `viewer` or `operator` holds — the exact mistake `audit:read` would have made.
 *
 * ⚠️ It carries **no quality measure on purpose.** "Operator X has a higher false-positive rate"
 * reads as a performance judgement, and the operator does not choose which incidents reach them:
 * a rule tuned badly on a site they happen to cover would show up as their failure. Counts and
 * durations describe load, which is what a rota needs; ranking people is not a feature.
 */
export const OperatorWorkload = z.object({
  operatorId: z.string().min(1),
  assignedCount: z.number().int().min(0),
  resolvedCount: z.number().int().min(0),
  /** Still open at the end of the window. */
  openCount: z.number().int().min(0),
  resolutionTime: MetricAverage,
});
export type OperatorWorkload = z.infer<typeof OperatorWorkload>;

export const OperatorWorkloadReport = z.object({
  tenantId: TenantId,
  window: MetricWindow,
  operators: z.array(OperatorWorkload).max(500).default([]),
  derivedAt: IsoDateTime,
});
export type OperatorWorkloadReport = z.infer<typeof OperatorWorkloadReport>;

/**
 * The permission workload reporting requires. Exported so the string is asserted in one place and
 * a test can prove no role's wildcard grants it by accident.
 */
export const WORKLOAD_PERMISSION = 'metrics:workload';
