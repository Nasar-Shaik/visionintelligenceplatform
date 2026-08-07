/**
 * Domain: **incident creation** — turns a matched rule + triggering event into an `IncidentCandidate`
 * (and the lightweight `rule.matched` audit signal). Deliberately separate from evaluation (P1-7
 * Architect review): a match does not imply an incident, and this is the only place a candidate is
 * shaped. Pure — no I/O, no state. The `dedupKey` lets identical candidates collapse downstream.
 */
import type { EventEnvelope, IncidentCandidate, Rule, RuleAction, RuleMatch } from '@vip/contracts';
import { buildEvidenceRefs, buildExplanation, buildTimeline } from './candidate-detail.js';
import type { DwellOutcome } from './dwell.js';

type RaiseIncident = Extract<RuleAction, { type: 'raise-incident' }>;

export interface IncidentDeps {
  newId: () => string;
  now: () => Date;
}

/**
 * What the dwell stage produced, when the rule has one (P-8 Phase 7).
 *
 * ⚠️ Optional throughout. A stateless rule's candidate carries no dwell fields at all, rather than
 * zeroes — the difference between "this rule does not measure duration" and "the duration was zero"
 * is the difference between a correct record and a broken-looking one.
 */
export interface DwellContext {
  outcome: DwellOutcome;
  /** The subject key the visit was filed under. */
  subject: string;
  zoneName?: string | undefined;
  zoneVersion?: number | undefined;
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
 * The subject an incident candidate is about, when the observation identifies one.
 *
 * ⚠️ **`trackId` only — never a fallback to the class.** `class` is `'person'` for everybody, so
 * keying on it would put every person in one bucket: identical to having no subject at all, but
 * looking as though the subject had been accounted for. Absent means *this observation names no
 * subject*, and the key then behaves exactly as it did before subjects were considered.
 */
function subjectKeyOf(envelope: EventEnvelope): string | undefined {
  return envelope.subjects[0]?.trackId;
}

/**
 * Dedup key for an incident candidate: identical (tenant, rule, group, subject, time-bucket)
 * candidates collapse within `windowMs`, so a burst of matches raises one incident, not hundreds.
 *
 * ### ⚠️ The SUBJECT is part of the key, and getting this wrong loses incidents
 *
 * The time-bucket dedup exists to collapse a burst from one rule. For a dwell rule the natural group
 * is `'-'` (no window), so **two different people loitering in the same minute would share a dedup
 * key** and the second candidate would be silently collapsed into the first by the broker. One person
 * would get an incident; the other would vanish, with no error anywhere — the platform would simply
 * have decided that two loiterers were one.
 *
 * So the subject is part of the key whenever there is one. The cool-down, not dedup, is what stops a
 * single subject firing repeatedly — dedup's job here is only to make a redelivery idempotent.
 *
 * ### ⛔ That reasoning was written for dwell rules and applied only to dwell rules (V-15)
 *
 * The bucketed branch below carried **no subject at all**, so the failure the paragraph above
 * describes was live in the ordinary match path the whole time. Found on the Architect's own
 * 19-second recording: they walked past the camera three times, the tracker followed three separate
 * subjects (`…_2`, `…_3`, `…_5`), the events tier persisted three `perception.person.detected`
 * events — and the rules tier raised **one** incident, because `[tenant, rule, '-', bucket]` cannot
 * tell three people apart and the whole recording is shorter than one 60 s bucket.
 *
 * ⚠️ **The two tiers of one pipeline disagreed about what a duplicate is.** `dedupKey` in
 * `services/events` has keyed on `subjects[0].trackId` since it was written; this key did not. Three
 * events collapsing to one incident is the exact arithmetic of that disagreement.
 *
 * ### ⚠️ What this changes for a live camera
 *
 * A live match rule now raises one incident per *subject* per window instead of one per *group* per
 * window, so a camera that sees thirty people a minute can raise thirty incidents where it used to
 * raise one. That is the correct answer to "how many people triggered this rule" and it is a real
 * increase in volume: `RULES_CANDIDATE_DEDUP_WINDOW_MS` is the knob, and the ceiling is bounded by
 * the events tier already emitting at most one event per track per `EVENTS_DEDUP_WINDOW_MS`. See
 * [L-69].
 *
 * ### ⛔ The analysis run is part of the key — ADR-0047, and the layer it missed
 *
 * Every component of this key is derived from the observation, and an offline analysis stamps
 * **footage** time. Re-analysing one recording reproduces `occurredAt` exactly, so it reproduces
 * `bucket` exactly, so a rerun's candidates collide with the first run's — permanently, because
 * footage time never advances out of the window.
 *
 * ADR-0047 fixed precisely this shape in three places (the publisher's ordering gate, the events
 * dedup key, JetStream's `msgId`) and **did not reach here**. Measured by P-8.5 Product Validation
 * against the deployed stack (V-4): a five-minute recording raised 8 incidents on its first run and
 * **0 on an identical second run**, while its events, timeline and tracks all reproduced correctly.
 * That is the exact promise ADR-0047 makes — "both analyses persisted independently, both
 * independently queryable" — holding for events and silently failing for incidents.
 *
 * ⚠️ **Appended only when present, never joined with a placeholder.** A live candidate has no
 * analysis run, so its key is **byte-identical** to the one this function produced before. That
 * matters beyond tidiness: dedup state outlives a deployment, and a key whose *shape* changed would
 * make every live rule miss its window once on rollout — a burst of duplicate incidents at exactly
 * the moment an operator is watching a deploy.
 */
export function candidateDedupKey(
  rule: Rule,
  envelope: EventEnvelope,
  windowMs: number,
  dwell?: DwellContext | undefined,
): string {
  const bucket =
    windowMs > 0 ? Math.floor(Date.parse(envelope.occurredAt) / windowMs) : envelope.id;
  const parts: (string | number)[] =
    dwell !== undefined
      ? /*
         * ⚠️ Keyed on the subject, the zone and the moment the visit STARTED — not on a time bucket.
         * Two candidates for the same visit are the same candidate however far apart they fall,
         * which makes a redelivery idempotent; a second visit by the same person starts at a
         * different instant and is correctly a second candidate. `firedAtMs` would have made every
         * cool-down expiry a new key, which is right, but it would also have made a redelivery a new
         * key, which is not.
         */
        [
          envelope.tenantId,
          rule.id,
          envelope.zoneId ?? '-',
          dwell.subject,
          dwell.outcome.record.firstObservedAtMs,
          dwell.outcome.record.firedAtMs ?? bucket,
        ]
      : [envelope.tenantId, rule.id, groupKeyFor(rule, envelope), bucket];
  /*
   * ⚠️ **Appended, and only when the observation names a subject** — the same discipline the
   * analysis run below is held to, for the same reason. An envelope with no `trackId` (a system
   * event, a rule-on-rule signal, anything the perception tier did not produce) keeps a key that is
   * byte-identical to the one this function returned before V-15, so nothing that was deduping
   * correctly starts double-firing on the deploy that ships this.
   *
   * The dwell branch already carries `dwell.subject` and must not be given a second one.
   */
  if (dwell === undefined) {
    const subject = subjectKeyOf(envelope);
    if (subject !== undefined) parts.push(subject);
  }
  if (envelope.analysisSessionId !== undefined) parts.push(envelope.analysisSessionId);
  return parts.join('|');
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
  dwell?: DwellContext | undefined,
): IncidentCandidate {
  const action = raiseAction(rule);
  const severity = action?.severity ?? rule.severity;
  /*
   * ⚠️ A dwell title says what happened, not which event type happened to arrive. "Retail Loitering:
   * perception.person.detected" is technically accurate and tells an operator nothing — the event
   * type is the *sampling mechanism*, and the fact is the duration.
   */
  const title =
    action?.title ??
    (dwell !== undefined
      ? `${rule.name}: ${Math.round(dwell.outcome.observedSeconds)}s in ${dwell.zoneName ?? envelope.zoneId ?? 'the monitored area'}`
      : `${rule.name}: ${envelope.type}`);
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
    dedupKey: candidateDedupKey(rule, envelope, dedupWindowMs, dwell),
    at: deps.now().toISOString(),
    status: 'candidate',
    evidence: [],
    dryRun: rule.dryRun,
  };
  if (envelope.cameraId) candidate.triggeredBy.cameraId = envelope.cameraId;
  if (envelope.zoneId) candidate.triggeredBy.zoneId = envelope.zoneId;
  if (envelope.correlationId) candidate.correlationId = envelope.correlationId;
  /*
   * ⭐ **The analysis run travels with the finding** (ADR-0047, extended to incidents).
   *
   * ⚠️ Copied, never defaulted. Absent means a live camera raised this — which is every candidate
   * any deployment produced before offline analysis existed — and absence is what keeps it in the
   * live queue. A placeholder here would put every live incident into an investigation.
   */
  if (envelope.analysisSessionId !== undefined) {
    candidate.analysisSessionId = envelope.analysisSessionId;
  }

  if (dwell !== undefined) {
    const detail = {
      rule,
      envelope,
      outcome: dwell.outcome,
      subject: dwell.subject,
      zoneName: dwell.zoneName,
      zoneVersion: dwell.zoneVersion,
    };
    candidate.identityId = dwell.subject;
    candidate.durationSeconds = dwell.outcome.observedSeconds;
    candidate.explanation = buildExplanation(detail);
    candidate.timeline = buildTimeline(detail);
    candidate.evidence = buildEvidenceRefs(detail);
    candidate.confidence = dwell.outcome.meanConfidence;
    /*
     * ⚠️ `matchedCount` becomes the observation count for a dwell rule. It is the closest honest
     * reading of "how many matching events satisfied this rule" — and leaving it at 1 would make a
     * candidate assembled from 180 observations look identical to one from a single frame.
     */
    candidate.matchedCount = Math.max(1, dwell.outcome.record.observations);
  }
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
