/**
 * Domain: **incident creation** — turns a matched rule + triggering event into an `IncidentCandidate`
 * (and the lightweight `rule.matched` audit signal). Deliberately separate from evaluation (P1-7
 * Architect review): a match does not imply an incident, and this is the only place a candidate is
 * shaped. Pure — no I/O, no state. The `dedupKey` lets identical candidates collapse downstream.
 */
import type { EventEnvelope, IncidentCandidate, Rule, RuleAction, RuleMatch } from '@vip/contracts';

type RaiseIncident = Extract<RuleAction, { type: 'raise-incident' }>;

export interface IncidentDeps {
  newId: () => string;
  now: () => Date;
}

/** The group key for windowing/dedup, per the rule's `window.groupBy`. */
export function groupKeyFor(rule: Rule, envelope: EventEnvelope): string {
  switch (rule.window?.groupBy) {
    case 'camera':
      return envelope.cameraId ?? '-';
    case 'zone':
      return envelope.zoneId ?? '-';
    default:
      return '-';
  }
}

/**
 * Dedup key for an incident candidate: identical (tenant, rule, group, time-bucket) candidates
 * collapse within `windowMs`, so a burst of matches raises one incident, not hundreds.
 */
export function candidateDedupKey(rule: Rule, envelope: EventEnvelope, windowMs: number): string {
  const bucket =
    windowMs > 0 ? Math.floor(Date.parse(envelope.occurredAt) / windowMs) : envelope.id;
  return [envelope.tenantId, rule.id, groupKeyFor(rule, envelope), bucket].join('|');
}

/** The first `raise-incident` action on the rule, if any. */
function raiseAction(rule: Rule): RaiseIncident | undefined {
  return rule.actions.find((a): a is RaiseIncident => a.type === 'raise-incident');
}

/** Does this rule raise an incident at all (vs only emit-event / audit)? */
export function raisesIncident(rule: Rule): boolean {
  return raiseAction(rule) !== undefined;
}

export function buildIncidentCandidate(
  rule: Rule,
  envelope: EventEnvelope,
  matchedCount: number,
  dedupWindowMs: number,
  deps: IncidentDeps,
): IncidentCandidate {
  const action = raiseAction(rule);
  const severity = action?.severity ?? rule.severity;
  const title = action?.title ?? `${rule.name}: ${envelope.type}`;
  const candidate: IncidentCandidate = {
    id: deps.newId(),
    tenantId: envelope.tenantId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleName: rule.name,
    severity,
    title,
    category: envelope.category,
    triggeredBy: {
      eventId: envelope.id,
      eventType: envelope.type,
      occurredAt: envelope.occurredAt,
    },
    matchedCount,
    dedupKey: candidateDedupKey(rule, envelope, dedupWindowMs),
    at: deps.now().toISOString(),
  };
  if (envelope.cameraId) candidate.triggeredBy.cameraId = envelope.cameraId;
  if (envelope.zoneId) candidate.triggeredBy.zoneId = envelope.zoneId;
  if (envelope.correlationId) candidate.correlationId = envelope.correlationId;
  return candidate;
}

export function buildRuleMatch(
  rule: Rule,
  envelope: EventEnvelope,
  raisedIncident: boolean,
  now: Date,
): RuleMatch {
  return {
    tenantId: envelope.tenantId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    ruleName: rule.name,
    eventId: envelope.id,
    eventType: envelope.type,
    raisedIncident,
    at: now.toISOString(),
  };
}
