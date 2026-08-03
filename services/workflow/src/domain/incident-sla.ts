/**
 * Domain: **SLA attainment** (P-5.1, finding F-4). Pure — handed a policy and an incident, it
 * decides what that means.
 *
 * The failure this is built to avoid is a dashboard reporting 98% SLA compliance for a deployment
 * that has never configured an SLA. Every incident would be "compliant", the number would look
 * excellent, and it would mean nothing at all.
 *
 * So: **no policy means `unknown`, never `met`.** An incident with no target is not compliant, it
 * is *unmeasured*, and a report that cannot distinguish the two is worse than one without the
 * column. The same rule as `RuleHealthStatus.unknown` and `RuleValidationReport.verified`, one
 * context over (CONSTRAINTS §44, §52).
 *
 * Nothing here is stored. The clocks are recomputed from `raisedAt`, `acknowledgedAt` and
 * `resolvedAt`, which the incident already carries — so this works on incidents raised long before
 * any policy existed, and changing a policy re-reports history against the new target rather than
 * leaving stale verdicts behind. That is the right trade for an operational metric; it would be the
 * wrong one for an audit record, which is why the audit record is the transitions, not this.
 */
import type {
  Incident,
  IncidentSlaClock,
  IncidentSlaPolicy,
  IncidentSlaState,
  IncidentSlaStatus,
} from '@vip/contracts';

function elapsed(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

function clockFor(
  raisedAt: string,
  withinSeconds: number,
  reachedAt: string | undefined,
  now: Date,
): IncidentSlaClock {
  const dueAt = new Date(Date.parse(raisedAt) + withinSeconds * 1000).toISOString();
  const nowIso = now.toISOString();
  if (reachedAt !== undefined) {
    return {
      dueAt,
      metAt: reachedAt,
      breached: Date.parse(reachedAt) > Date.parse(dueAt),
      elapsedSeconds: elapsed(raisedAt, reachedAt),
    };
  }
  // Still running: breached the moment the due time passes, without waiting for the transition.
  return {
    dueAt,
    breached: Date.parse(nowIso) > Date.parse(dueAt),
    elapsedSeconds: elapsed(raisedAt, nowIso),
  };
}

/**
 * The overall verdict, from the clocks that are actually configured.
 *
 * Ordering matters: any breach dominates, then any clock still running is `on-track`, and only when
 * every configured clock has been met is the answer `met`. A policy that configures neither target
 * yields `unknown` — it is a policy in name only.
 */
function stateOf(clocks: (IncidentSlaClock | undefined)[]): IncidentSlaState {
  const present = clocks.filter((clock): clock is IncidentSlaClock => clock !== undefined);
  if (present.length === 0) return 'unknown';
  if (present.some((clock) => clock.breached)) return 'breached';
  if (present.some((clock) => clock.metAt === undefined)) return 'on-track';
  return 'met';
}

/**
 * Derive an incident's SLA status.
 *
 * `policy` absent — no SLA configured for this tenant and severity — yields `unknown` with no
 * clocks. That is the honest answer and the common one in a fresh deployment.
 */
export function deriveSla(
  incident: Incident,
  policy: IncidentSlaPolicy | undefined,
  now: Date,
): IncidentSlaStatus {
  if (!policy) {
    return { incidentId: incident.id, state: 'unknown', derivedAt: now.toISOString() };
  }

  const acknowledge =
    policy.acknowledgeWithinSeconds !== undefined
      ? clockFor(
          incident.raisedAt,
          policy.acknowledgeWithinSeconds,
          // Any move out of `raised` is an acknowledgement of attention — an incident resolved
          // straight from `raised` was not ignored, and reporting it as an ack breach would be a
          // number that punishes the fastest possible response.
          incident.acknowledgedAt ?? firstAttentionAt(incident),
          now,
        )
      : undefined;

  const resolve =
    policy.resolveWithinSeconds !== undefined
      ? clockFor(incident.raisedAt, policy.resolveWithinSeconds, incident.resolvedAt, now)
      : undefined;

  const status: IncidentSlaStatus = {
    incidentId: incident.id,
    state: stateOf([acknowledge, resolve]),
    policy,
    derivedAt: now.toISOString(),
  };
  if (acknowledge) status.acknowledge = acknowledge;
  if (resolve) status.resolve = resolve;
  return status;
}

/** The first transition away from `raised` — when a human first did something about it. */
function firstAttentionAt(incident: Incident): string | undefined {
  return incident.history.find((entry) => entry.from === 'raised')?.at;
}

/**
 * Look up the policy for an incident from a deployment's configured set.
 *
 * Per tenant **and** severity, because a critical incident and a low one do not share a target.
 * No match is not an error — it is the `unknown` case above.
 */
export function policyFor(
  policies: readonly IncidentSlaPolicy[],
  incident: Incident,
): IncidentSlaPolicy | undefined {
  return policies.find(
    (policy) => policy.tenantId === incident.tenantId && policy.severity === incident.severity,
  );
}
