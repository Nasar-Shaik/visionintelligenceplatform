/**
 * Domain: **what a person needs in order to act on a candidate** (P-8 Phase 7, Architect recs 4+5).
 *
 * Pure. Given a rule, the triggering event and the dwell outcome, produce the structured explanation,
 * the ordered timeline and the evidence references. No I/O — in particular **no media lookup**: a
 * candidate is built on the per-event path, and an alert that waits on object storage is an alert
 * that stops arriving when storage is slow.
 *
 * ### ⚠️ The summary is rendered, never authored
 *
 * `CandidateExplanation.summary` is computed from the same fields the object carries. Writing a
 * sentence *alongside* the numbers creates two descriptions of one event, and they drift on the first
 * edit — usually the sentence, because it is the one a human touches. Anything a reader sees in the
 * summary can be found in a field, and anything in a field appears in the summary if it changes the
 * meaning.
 */
import type {
  CandidateEvidenceRef,
  CandidateExplanation,
  CandidateTimeline,
  CandidateTimelineEntry,
  EventEnvelope,
  Rule,
} from '@vip/contracts';
import { gapIsUnusual, moments, type DwellOutcome } from './dwell.js';

/**
 * How long before and after the observed window an evidence reference should reach.
 *
 * ⚠️ Padding is not cosmetic. A clip that starts at the first detection shows a person already in
 * frame and tells a reviewer nothing about how they got there; one that ends at the last shows them
 * still standing, with no idea what happened next. Both are the questions actually asked when
 * somebody disputes an incident.
 */
const EVIDENCE_PAD_SECONDS = 10;

export interface CandidateDetailInput {
  rule: Rule;
  envelope: EventEnvelope;
  outcome: DwellOutcome;
  /** The subject key the visit was filed under — an identityId or a trackId. */
  subject: string;
  /** The zone's name and version, when the event named a zone the resolver could describe. */
  zoneName?: string | undefined;
  zoneVersion?: number | undefined;
}

/** Seconds, to one decimal. ⚠️ Rendered once, here, so every surface reads the same number. */
function secs(value: number): string {
  return `${Math.round(value * 10) / 10}s`;
}

/**
 * The structured explanation, plus the sentence rendered from it.
 *
 * ⚠️ The sentence names the two honesty fields **whenever they are non-trivial** — a fragmented or
 * gappy observation says so in the first line an operator reads, not three clicks deeper. A summary
 * that mentioned them only in the detail view would let the reassuring half travel further than the
 * qualifying half.
 */
export function buildExplanation(input: CandidateDetailInput): CandidateExplanation {
  const { rule, envelope, outcome, subject } = input;
  const dwell = rule.dwell;
  const where = input.zoneName ?? envelope.zoneId ?? 'the monitored area';
  const trackId = envelope.subjects[0]?.trackId;

  const parts = [
    `the same subject was observed in ${where} for ${secs(outcome.observedSeconds)}`,
    dwell ? `, above the ${secs(dwell.minSeconds)} threshold` : '',
    ` across ${outcome.record.observations} observation(s)`,
  ];
  if (outcome.trackFragments > 1) {
    parts.push(
      `; identity was carried across ${outcome.trackFragments} track fragments, so the duration ` +
        'spans a link the platform inferred rather than observed',
    );
  }
  /*
   * ⚠️ Mentioned only when it is UNUSUAL for this deployment. Before `typicalGapSeconds` existed
   * this fired on every single incident — the events dedup window is ten seconds, so a continuously
   * observed person always had a "ten-second unobserved gap". A qualification that appears every
   * time is a qualification nobody reads.
   */
  if (gapIsUnusual(outcome.longestGapSeconds, outcome.typicalGapSeconds)) {
    parts.push(
      `; ⚠️ the longest unobserved gap was ${secs(outcome.longestGapSeconds)}, against a typical ` +
        `${secs(outcome.typicalGapSeconds ?? 0)} between sightings`,
    );
  }

  const explanation: CandidateExplanation = {
    trigger: 'dwell',
    summary: parts.join('').slice(0, 600),
  };
  if (dwell) {
    explanation.subjectKind = dwell.groupBy;
    explanation.thresholdSeconds = dwell.minSeconds;
  }
  /*
   * ⚠️ `identityId` carries the key the rule ACCUMULATED on, whichever kind it is. A field that held
   * an identity for one rule and a track for another, with nothing saying which, is the ambiguity
   * ADR-0041 exists to prevent — `subjectKind` above is what disambiguates it.
   */
  explanation.identityId = subject;
  if (trackId !== undefined) explanation.trackId = trackId;
  if (envelope.cameraId !== undefined) explanation.cameraId = envelope.cameraId;
  if (envelope.zoneId !== undefined) explanation.zoneId = envelope.zoneId;
  if (input.zoneName !== undefined) explanation.zoneName = input.zoneName;
  if (input.zoneVersion !== undefined) explanation.zoneVersion = input.zoneVersion;
  explanation.observedSeconds = outcome.observedSeconds;
  explanation.firstObservedAt = new Date(outcome.record.firstObservedAtMs).toISOString();
  explanation.lastObservedAt = new Date(outcome.record.lastObservedAtMs).toISOString();
  explanation.observations = outcome.record.observations;
  explanation.trackFragments = outcome.trackFragments;
  explanation.longestGapSeconds = outcome.longestGapSeconds;
  explanation.typicalGapSeconds = outcome.typicalGapSeconds;
  explanation.meanConfidence = outcome.meanConfidence;
  return explanation;
}

/** One line per moment, in the words an operator reads on the timeline. */
function summarise(
  kind: CandidateTimelineEntry['kind'],
  elapsed: number,
  gapSeconds: number | undefined,
  threshold: number | undefined,
): string {
  switch (kind) {
    case 'first-observed':
      return 'first seen in the zone — the clock starts';
    case 'observed':
      return `still in the zone at ${secs(elapsed)}`;
    case 'identity-relinked':
      return `track changed at ${secs(elapsed)} — identity carried across the gap`;
    case 'gap':
      return `not observed for ${secs(gapSeconds ?? 0)}`;
    case 'threshold-crossed':
      return `reached the ${secs(threshold ?? 0)} threshold`;
    case 'raised':
      return `candidate raised at ${secs(elapsed)}`;
  }
}

/**
 * The ordered timeline (Architect rec 5).
 *
 * ⚠️ `elapsedSeconds` is precomputed against the visit's start so a renderer can lay the track out
 * without parsing a date per entry. It is also what makes the browser's loiter bar a straight
 * multiplication rather than a date library.
 */
export function buildTimeline(input: CandidateDetailInput): CandidateTimeline {
  const { outcome, rule } = input;
  const startMs = outcome.record.firstObservedAtMs;
  const threshold = rule.dwell?.minSeconds;

  const cameraId = input.envelope.cameraId;

  const entries: CandidateTimelineEntry[] = moments(outcome.record).map((moment) => {
    const elapsed = Math.max(0, (moment.atMs - startMs) / 1000);
    const entry: CandidateTimelineEntry = {
      at: new Date(moment.atMs).toISOString(),
      kind: moment.kind,
      elapsedSeconds: elapsed,
      evidence: [],
      summary: summarise(moment.kind, elapsed, moment.gapSeconds, threshold),
    };
    if (moment.eventId !== undefined) entry.eventId = moment.eventId;
    if (moment.eventType !== undefined) entry.eventType = moment.eventType;
    if (moment.trackId !== undefined) entry.trackId = moment.trackId;
    if (input.envelope.zoneId !== undefined) entry.zoneId = input.envelope.zoneId;
    if (moment.confidence !== undefined) entry.confidence = moment.confidence;

    /*
     * ⚠️ **What a reader can open from this instant** (Architect rec 1). Two references at most, and
     * both are derived rather than looked up: the event by id, and the frame by the deterministic
     * `tenant:camera:seq` triple the publisher stamps. Neither costs an I/O on the per-event path.
     *
     * ⚠️ The frame reference is only emitted when the moment came from an event. A derived marker
     * (`gap`, `threshold-crossed`) has no frame, and inventing one would point an operator at an
     * image that does not show what the entry claims.
     */
    if (moment.eventId !== undefined) {
      entry.evidence.push({
        kind: 'event',
        id: moment.eventId,
        ...(cameraId !== undefined ? { cameraId } : {}),
        startedAt: entry.at,
        locator: `/events/events/${moment.eventId}`,
        label: 'The event at this moment',
      });
    }
    if (moment.frameId !== undefined) {
      entry.frameId = moment.frameId;
      entry.evidence.push({
        kind: 'frame',
        id: moment.frameId,
        ...(cameraId !== undefined ? { cameraId } : {}),
        startedAt: entry.at,
        /*
         * ⚠️ A **playback locator at an instant**, not an image endpoint — nothing in the platform
         * serves a stored frame by id, and pretending otherwise would produce a link that 404s from
         * an evidence record. Seeking recorded footage to that moment is the honest equivalent, and
         * it is a route that exists.
         */
        locator: `/playback?cameraId=${encodeURIComponent(cameraId ?? '')}&at=${entry.at}`,
        label: `Footage at ${secs(elapsed)} into the visit`,
      });
    }
    return entry;
  });

  /*
   * ⚠️ The **identity** reference sits on the first entry, once, rather than on every one of them.
   * It is a property of the visit, not of an instant — repeating it on 24 entries would triple the
   * timeline's size to say the same thing 24 times.
   */
  const first = entries[0];
  if (first !== undefined && cameraId !== undefined) {
    first.evidence.push({
      kind: 'identity',
      id: input.subject,
      cameraId,
      startedAt: first.at,
      locator: `/media/tracking/${encodeURIComponent(cameraId)}/tracks?identityId=${encodeURIComponent(input.subject)}`,
      label: 'This subject’s track history',
    });
  }

  return {
    entries,
    omitted: outcome.record.omitted,
    /* ⚠️ Moments, not observations — see `CandidateTimeline.total`. */
    total: entries.length + outcome.record.omitted,
  };
}

/**
 * Where the pixels are (Architect rec 4 of the main brief: *reference, never copy*).
 *
 * Three references, in the order a reviewer wants them:
 *
 * 1. **the recorded interval** covering the visit, padded — the thing they actually want to watch;
 * 2. **the triggering event**, so the exact frame is one click away;
 * 3. **the first observation's event**, when it differs — where the clock started.
 *
 * ⚠️ Every `locator` is a **platform-relative path**: no host, no scheme, no token. An incident record
 * outlives the deployment it was raised on, and a stored URL would either break or, worse, keep
 * working and point at the wrong estate. It also cannot leak a credential into a record that gets
 * exported to a customer.
 *
 * ⚠️ No claim is made that the recording exists. The engine cannot check without a media round trip
 * on the per-event path, so the reference says *where it would be* and the console reports honestly
 * when it resolves to nothing. Asserting existence we had not verified would be the worse failure:
 * an incident whose evidence link is confidently broken.
 */
export function buildEvidenceRefs(input: CandidateDetailInput): CandidateEvidenceRef[] {
  const { envelope, outcome } = input;
  const refs: CandidateEvidenceRef[] = [];
  const cameraId = envelope.cameraId;

  if (cameraId !== undefined) {
    const from = new Date(outcome.record.firstObservedAtMs - EVIDENCE_PAD_SECONDS * 1000);
    const to = new Date(outcome.record.lastObservedAtMs + EVIDENCE_PAD_SECONDS * 1000);
    refs.push({
      kind: 'recording-interval',
      cameraId,
      startedAt: from.toISOString(),
      endedAt: to.toISOString(),
      locator: `/media/recordings?cameraId=${encodeURIComponent(cameraId)}&from=${from.toISOString()}&to=${to.toISOString()}`,
      label: `Recorded footage — ${secs(outcome.observedSeconds)} in zone, ±${EVIDENCE_PAD_SECONDS}s`,
    });
  }

  refs.push({
    kind: 'event',
    id: envelope.id,
    ...(cameraId !== undefined ? { cameraId } : {}),
    startedAt: envelope.occurredAt,
    locator: `/events/events/${envelope.id}`,
    label: 'The event that raised this candidate',
  });

  const first = outcome.record.head[0];
  if (first?.eventId !== undefined && first.eventId !== envelope.id) {
    refs.push({
      kind: 'event',
      id: first.eventId,
      ...(cameraId !== undefined ? { cameraId } : {}),
      startedAt: new Date(first.atMs).toISOString(),
      locator: `/events/events/${first.eventId}`,
      label: 'The first observation — where the clock started',
    });
  }

  return refs;
}
