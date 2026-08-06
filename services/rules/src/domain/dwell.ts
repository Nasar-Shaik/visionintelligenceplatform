/**
 * Domain: **dwell accumulation** (P-8 Phase 7) — how long has this subject been in this zone?
 *
 * Pure, total, deterministic. No clock, no store, no I/O: every function takes the current record and
 * the observation, and returns the next record. That is what makes the whole loitering feature
 * testable without a broker, a camera or a wall clock, and it is what lets the mutation suite corrupt
 * one input and watch exactly one check go red.
 *
 * ### ⚠️ What "dwell" actually means here, stated plainly because the alternative is a lie
 *
 * `observedSeconds = lastObservedAt − firstObservedAt`. It is the span between the first and most
 * recent sighting of one subject in one zone. It is **not** a measurement of continuous physical
 * presence, and it cannot be: the platform sees the frames it was sent, and between two of them a
 * person may have left, walked round the aisle and come back.
 *
 * Two fields exist so nobody has to take the number on trust:
 *
 * - `longestGapSeconds` — the biggest hole in the observation series. A 90-second dwell sampled twice
 *   a second and a 90-second dwell assembled from two sightings 89 seconds apart are wildly different
 *   claims, and only one of them is worth waking somebody for.
 * - `trackFragments` — how many distinct track ids the identity spanned. `> 1` means the duration
 *   crosses a link the tracker *inferred* geometrically, with no appearance model, which it can get
 *   wrong ([L-42]).
 *
 * Both travel onto every candidate. An operator who can see them can judge the incident; one who
 * cannot is being asked to trust a number whose provenance was thrown away.
 *
 * ### ⚠️ Why the clock keeps running through a cool-down
 *
 * Cool-down suppresses *raising*, not *counting*. A person who has now been at the counter for ten
 * minutes is a stronger fact than "another five minutes elapsed", so the second candidate reports the
 * whole visit rather than restarting. Resetting the clock on fire would make every candidate after the
 * first understate the situation — and understating is the direction that gets missed.
 */
import { gapIsUnusual } from '@vip/contracts';
import type { CandidateTimelineKind, DwellGroupBy, EventEnvelope, RuleDwell } from '@vip/contracts';

/**
 * How many moments to keep at each end of a visit.
 *
 * ⚠️ Head **and** tail, not a plain ring. The interesting entries cluster at both ends: the start of
 * the visit and the crossing of the threshold. A ring of the last 32 would lose the moment the clock
 * started, which is the one an investigator looks for first.
 */
export const TIMELINE_HEAD = 12;
export const TIMELINE_TAIL = 12;

/** One thing that happened to a subject, kept for the candidate's timeline. */
export interface DwellMoment {
  readonly atMs: number;
  readonly kind: CandidateTimelineKind;
  readonly eventId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly trackId?: string | undefined;
  readonly confidence?: number | undefined;
  /**
   * The frame this was observed in — `tenant:camera:seq` (P-8 Phase 7 rec 1).
   *
   * ⚠️ Carried per moment rather than derived at candidate-build time, because by then only the
   * *triggering* frame is in hand. The timeline's whole value is that it points at the earlier ones.
   */
  readonly frameId?: string | undefined;
  /** For a `gap` moment: how long nothing was seen. */
  readonly gapSeconds?: number | undefined;
}

/**
 * One subject's visit to one zone under one rule.
 *
 * ⚠️ Plain data, serialisable, with no methods — so a future Redis-backed store can persist it
 * without a translation layer, and so a test can assert on the whole thing with one comparison.
 */
export interface DwellRecord {
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  observations: number;
  /**
   * Distinct track ids seen under this subject key.
   *
   * ⚠️ Bounded by construction: it only ever grows when the tracker produces a *new* id for the same
   * identity, which is a rare event by design. A pathological tracker could still grow it, so the
   * count is what is reported and the set is capped — an unbounded set on a per-subject record is how
   * a memory leak gets into the one process that must not have one.
   */
  trackIds: string[];
  longestGapMs: number;
  /**
   * Recent inter-observation gaps, for the **typical** gap (P-8 Phase 7, found by the deployment).
   *
   * ⚠️ `longestGapMs` alone is meaningless, and the deployment proved it. The events service
   * collapses repeated detections of one subject into one event per dedup bucket
   * (`EVENTS_DEDUP_WINDOW_MS`, 10 s by default), so a dwell rule observes a *continuously present*
   * person about once every ten seconds however fast the camera runs. Every incident therefore
   * reported "the longest unobserved gap was 10s" — true, alarming, and describing nothing but the
   * platform's own sampling. An operator would have learned within a week to ignore the one field
   * that exists to make them careful.
   *
   * The median of these gaps is what "normal" looks like for this deployment, so a *real* hole is
   * one that stands out against it. Bounded: only the most recent are kept, because the median of a
   * recent window is the useful statistic and an unbounded array on a per-subject record is a leak.
   */
  gapsMs: number[];
  confidenceSum: number;
  confidenceCount: number;
  /** When this visit last raised a candidate. `undefined` until it has. Anchors the cool-down. */
  firedAtMs?: number | undefined;
  /** The observed duration at the moment it last fired — so a repeat can say what changed. */
  firedAtSeconds?: number | undefined;
  /** First moments of the visit. */
  head: DwellMoment[];
  /** Most recent moments. Trimmed from the front once `TIMELINE_TAIL` is exceeded. */
  tail: DwellMoment[];
  /** Moments dropped between head and tail — the timeline's `omitted`. */
  omitted: number;
}

/** ⚠️ Cap on distinct track ids retained per visit. The count is what matters; the ids are for detail. */
const MAX_TRACK_IDS = 32;

/** Gaps kept for the median. Enough to characterise the sampling, small enough to be free. */
const MAX_GAP_SAMPLES = 64;

/** What one observation did to a visit. */
export interface DwellOutcome {
  /** The visit after this observation. */
  readonly record: DwellRecord;
  /** True when the gap exceeded the reset and this observation started a fresh visit. */
  readonly reset: boolean;
  /** Observed duration in seconds, after this observation. */
  readonly observedSeconds: number;
  /** True when the observed duration is at or past the rule's threshold. */
  readonly thresholdMet: boolean;
  /** True when the threshold is met but a cool-down is suppressing the candidate. */
  readonly coolingDown: boolean;
  /** Seconds left on the cool-down, when one is running. */
  readonly cooldownRemainingSeconds: number | undefined;
  /** True when a candidate should be raised for this observation. */
  readonly fires: boolean;
  /** True when this observation crossed the threshold for the first time in this visit. */
  readonly crossedNow: boolean;
  /** Distinct track ids seen — `> 1` means tracking fragmented and identity bridged it. */
  readonly trackFragments: number;
  readonly longestGapSeconds: number;
  /**
   * The **median** gap between observations — what regular sampling looks like on this deployment.
   *
   * ⚠️ `null` until at least one gap has been measured; a single observation has no interval, and
   * reporting `0` would say "sampled continuously" about a visit nobody has watched twice.
   *
   * Read `longestGapSeconds` against this, never alone. Longest ≈ typical means regular sampling;
   * longest ≫ typical means the platform genuinely lost sight of the subject.
   */
  readonly typicalGapSeconds: number | null;
  /** Mean confidence over the visit, or `null` when no observation carried one (ADR-0039). */
  readonly meanConfidence: number | null;
}

/**
 * The key a rule accumulates on — the answer to "who is this?".
 *
 * ⚠️ Returns `undefined` rather than a fallback when the event carries no usable id, and the caller
 * must treat that as *cannot evaluate* rather than as a subject called `'unknown'`. Bucketing every
 * anonymous detection under one key would pool strangers into a single ever-present subject that
 * crosses any threshold within seconds and never leaves — a loitering rule that fires constantly, on
 * nobody, forever. This is the "Missing Identity" mutation.
 */
export function subjectKeyFor(groupBy: DwellGroupBy, envelope: EventEnvelope): string | undefined {
  const subject = envelope.subjects[0];
  if (subject === undefined) return undefined;
  if (groupBy === 'track') return subject.trackId;
  /*
   * ⚠️ `identityId` first, `trackId` only as a fallback. The fallback is correct rather than lazy: a
   * producer that has not adopted ADR-0041 sends `trackId` alone, and for a subject that has never
   * been occluded the two are equal by definition. What it must never do is silently *prefer*
   * trackId — that is the fragmentation bug, and it is invisible.
   */
  return subject.identityId ?? subject.trackId;
}

/** The zone half of the key. ⚠️ `'-'` for an event with no zone — the whole frame is one zone. */
export function zoneKeyFor(envelope: EventEnvelope): string {
  return envelope.zoneId ?? '-';
}

/**
 * The state key for one visit.
 *
 * ⚠️ Rule id is in the key, so two rules watching the same zone accumulate **independently**. They
 * have different thresholds and different cool-downs; sharing state would make whichever fired first
 * silence the other, and which one that was would depend on evaluation order.
 */
export function dwellKey(
  tenantId: string,
  ruleId: string,
  zoneKey: string,
  subject: string,
): string {
  return `${tenantId}:${ruleId}:${zoneKey}:${subject}`;
}

/** A visit that has just begun. */
function begin(atMs: number, moment: DwellMoment, trackId: string | undefined): DwellRecord {
  return {
    firstObservedAtMs: atMs,
    lastObservedAtMs: atMs,
    observations: 1,
    trackIds: trackId === undefined ? [] : [trackId],
    longestGapMs: 0,
    gapsMs: [],
    confidenceSum: moment.confidence ?? 0,
    confidenceCount: moment.confidence === undefined ? 0 : 1,
    head: [{ ...moment, kind: 'first-observed' }],
    tail: [],
    omitted: 0,
  };
}

function push(record: DwellRecord, moment: DwellMoment): void {
  if (record.head.length < TIMELINE_HEAD) {
    record.head.push(moment);
    return;
  }
  record.tail.push(moment);
  while (record.tail.length > TIMELINE_TAIL) {
    record.tail.shift();
    record.omitted += 1;
  }
}

export interface DwellObservationInput {
  /** When the observation happened — the event's `occurredAt`, never the receiving node's clock. */
  atMs: number;
  eventId?: string | undefined;
  eventType?: string | undefined;
  trackId?: string | undefined;
  confidence?: number | undefined;
  /** `tenant:camera:seq` — the frame this event came from, when the producer stamped one. */
  frameId?: string | undefined;
}

/**
 * Fold one observation into a visit.
 *
 * ⚠️ **Time comes from the event, not from the node.** `atMs` is the envelope's `occurredAt`, so a
 * replayed or delayed event contributes the duration it actually represents. Using the receiving
 * node's clock would make dwell a measure of broker latency, and a backlog after an outage would
 * raise a loitering incident for everybody who walked past during it.
 *
 * ⚠️ **An out-of-order observation never moves the clock backwards.** Events arrive out of order under
 * load; treating an older one as "now" would shrink the observed duration and could un-cross a
 * threshold that had already been crossed. It counts as an observation — it is real evidence the
 * subject was there — and nothing else about it is trusted.
 */
export function observe(
  previous: DwellRecord | undefined,
  input: DwellObservationInput,
  config: RuleDwell,
): DwellOutcome {
  const moment: DwellMoment = {
    atMs: input.atMs,
    kind: 'observed',
    eventId: input.eventId,
    eventType: input.eventType,
    trackId: input.trackId,
    confidence: input.confidence,
    frameId: input.frameId,
  };

  const resetMs = config.resetAfterSeconds * 1000;
  const gapMs = previous === undefined ? 0 : input.atMs - previous.lastObservedAtMs;

  /*
   * A gap longer than the reset ends the previous visit. ⚠️ Compared against the *forward* gap only:
   * a negative gap is an out-of-order event, not an absence, and resetting on one would let reordering
   * destroy a legitimate accumulation.
   */
  const reset = previous !== undefined && gapMs > resetMs;
  let record: DwellRecord;

  if (previous === undefined || reset) {
    record = begin(input.atMs, moment, input.trackId);
  } else {
    record = {
      ...previous,
      trackIds: [...previous.trackIds],
      gapsMs: [...previous.gapsMs],
      head: [...previous.head],
      tail: [...previous.tail],
    };
    record.observations += 1;
    if (input.atMs > record.lastObservedAtMs) {
      record.lastObservedAtMs = input.atMs;
      if (gapMs > record.longestGapMs) record.longestGapMs = gapMs;
      record.gapsMs.push(gapMs);
      while (record.gapsMs.length > MAX_GAP_SAMPLES) record.gapsMs.shift();
    }
    if (input.confidence !== undefined) {
      record.confidenceSum += input.confidence;
      record.confidenceCount += 1;
    }

    /*
     * ⚠️ A new track id under a stable identity is the fragmentation the whole design exists to
     * survive, and it is marked in the timeline rather than smoothed away. An investigator asking
     * "was this the same person throughout?" gets to see exactly where the platform inferred that it
     * was — the same discipline `TrackTimelineEntry` applies to a track's own history.
     */
    const relinked =
      input.trackId !== undefined &&
      record.trackIds.length > 0 &&
      !record.trackIds.includes(input.trackId);
    if (relinked && input.trackId !== undefined && record.trackIds.length < MAX_TRACK_IDS) {
      record.trackIds.push(input.trackId);
    }

    /*
     * ⚠️ A gap moment only when the gap is **unusual for this deployment** — the same predicate the
     * summary and the incident panel use.
     *
     * The first version marked any gap over half the reset window. On a platform that observes a
     * continuously present subject once per event-dedup bucket, that was **every single
     * observation**: the timeline read "not observed for 10s · still in the zone · not observed for
     * 10s · still in the zone" and the markers meant nothing. Same failure as the summary's, one
     * surface further in.
     */
    /*
     * ⚠️ **At least two prior gaps before anything is called unusual.** With no history there is no
     * "normal" to be unusual against, and `gapIsUnusual` falls back to an absolute threshold — which
     * marked the SECOND observation of every visit, on every deployment, for ever. Refusing to judge
     * without a baseline is the honest reading, and it costs one unmarked gap at the start of a visit
     * that the `first-observed` moment already accounts for.
     */
    if (previous.gapsMs.length >= 2 && gapIsUnusual(gapMs / 1000, median(previous.gapsMs))) {
      push(record, { atMs: input.atMs, kind: 'gap', gapSeconds: gapMs / 1000 });
    }
    push(record, relinked ? { ...moment, kind: 'identity-relinked' } : moment);
  }

  const observedMs = record.lastObservedAtMs - record.firstObservedAtMs;
  const observedSeconds = observedMs / 1000;
  const thresholdMet = observedSeconds >= config.minSeconds;

  /*
   * Cool-down. ⚠️ Anchored to when the visit last FIRED, not to when it started, and it survives the
   * observations in between — which is the whole point. Without it a rule past its threshold raises a
   * candidate on every single frame: at 2 fps that is 120 incidents a minute for one stationary
   * person, which is not an alerting system.
   */
  const cooldownMs = config.cooldownSeconds * 1000;
  const sinceFired = record.firedAtMs === undefined ? undefined : input.atMs - record.firedAtMs;
  const coolingDown =
    thresholdMet && sinceFired !== undefined && cooldownMs > 0 && sinceFired < cooldownMs;
  const cooldownRemainingSeconds =
    coolingDown && sinceFired !== undefined ? (cooldownMs - sinceFired) / 1000 : undefined;

  /* Fires when the threshold is met and nothing is suppressing it. */
  const fires = thresholdMet && !coolingDown;
  const crossedNow = fires && record.firedAtMs === undefined;

  if (fires) {
    if (crossedNow) {
      push(record, { atMs: input.atMs, kind: 'threshold-crossed' });
    }
    push(record, { atMs: input.atMs, kind: 'raised' });
    record.firedAtMs = input.atMs;
    record.firedAtSeconds = observedSeconds;
  }

  return {
    record,
    reset,
    observedSeconds,
    thresholdMet,
    coolingDown,
    cooldownRemainingSeconds,
    fires,
    crossedNow,
    /* ⚠️ At least 1: a visit with one track id is one fragment, not zero. */
    trackFragments: Math.max(1, record.trackIds.length),
    longestGapSeconds: record.longestGapMs / 1000,
    typicalGapSeconds: median(record.gapsMs),
    meanConfidence:
      record.confidenceCount === 0 ? null : record.confidenceSum / record.confidenceCount,
  };
}

/**
 * Every moment of a visit, in order, head then tail.
 *
 * The two halves are already chronological and disjoint by construction, so this concatenates rather
 * than sorts — and a test asserts the ordering holds, because "it is already sorted" is exactly the
 * kind of invariant that quietly stops being true.
 */
export function moments(record: DwellRecord): DwellMoment[] {
  return [...record.head, ...record.tail];
}

/**
 * **Replay a recorded timeline through the accumulator** (P-8 Phase 7, Architect rec 5).
 *
 * The extension point a future rule-replay feature needs, and it is a real one rather than a stub:
 * `observe` is already a pure fold over observations, so replay is that fold applied to a stored
 * sequence instead of a live one. This function *is* the whole mechanism.
 *
 * ⚠️ **No simulator, deliberately** — the Architect asked for the extension point, not the feature.
 * What is missing for replay-in-anger is not this: it is a source of historical observations (the
 * Events context owns those, and reaching into it is its own design — the same boundary
 * `RuleSimulationInput.range` already refuses to cross with a `501`).
 *
 * What this buys today is a **property test**: replaying a candidate's own timeline must reproduce
 * the candidate's numbers. That is what makes the timeline trustworthy as evidence — if the stored
 * moments could not regenerate the verdict, the timeline would be a decoration next to the decision
 * rather than a record of it.
 *
 * ⚠️ Derived markers (`gap`, `threshold-crossed`, `raised`) are **skipped**, not replayed. They are
 * outputs of the fold; feeding them back in would double-count. Only `first-observed`, `observed`
 * and `identity-relinked` are real observations.
 */
export function replayDwell(
  timeline: readonly DwellMoment[],
  config: RuleDwell,
): DwellOutcome | undefined {
  let outcome: DwellOutcome | undefined;
  for (const moment of timeline) {
    if (
      moment.kind !== 'first-observed' &&
      moment.kind !== 'observed' &&
      moment.kind !== 'identity-relinked'
    ) {
      continue;
    }
    outcome = observe(
      outcome?.record,
      {
        atMs: moment.atMs,
        eventId: moment.eventId,
        eventType: moment.eventType,
        trackId: moment.trackId,
        confidence: moment.confidence,
        frameId: moment.frameId,
      },
      config,
    );
  }
  return outcome;
}

/**
 * Where a visit stands right now, for the Live Rule Status page (Architect recs 3 + 6).
 *
 * ⚠️ Derived from the record on read, never stored. The state is a function of the record and the
 * configuration, so a stored copy could disagree with the thing it describes — the same reason
 * `RuleCompilation`'s hashes are derived. See [[Foundation Principle 2]].
 */
export function timerStateOf(
  record: DwellRecord,
  config: RuleDwell,
  nowMs: number,
): { state: 'accumulating' | 'met' | 'cooling-down'; cooldownRemainingSeconds: number | null } {
  const observedSeconds = (record.lastObservedAtMs - record.firstObservedAtMs) / 1000;
  if (observedSeconds < config.minSeconds) {
    return { state: 'accumulating', cooldownRemainingSeconds: null };
  }
  const cooldownMs = config.cooldownSeconds * 1000;
  if (record.firedAtMs === undefined || cooldownMs === 0) {
    return { state: 'met', cooldownRemainingSeconds: null };
  }
  const remainingMs = record.firedAtMs + cooldownMs - nowMs;
  if (remainingMs <= 0) return { state: 'met', cooldownRemainingSeconds: null };
  return { state: 'cooling-down', cooldownRemainingSeconds: remainingMs / 1000 };
}

/**
 * Take a dwell key apart again (P-8 Phase 7).
 *
 * ⚠️ The inverse of `dwellKey`, and it has to parse rather than look up because the store is a flat
 * map keyed by string — which is what makes it cheap. Parsing from the **right** rather than the
 * left: a tenant id and a rule id cannot contain `:` (both are generated), but a subject key is a
 * track id whose format is the tracker's business, so only the last field may contain anything.
 *
 * Returns `undefined` for a key that does not have the expected shape, rather than a partly-filled
 * result. A timer attributed to the wrong rule would report the wrong threshold, and an operator
 * would watch a bar fill towards a number nobody configured.
 */
export function parseDwellKey(
  key: string,
): { tenantId: string; ruleId: string; zoneKey: string; subject: string } | undefined {
  const parts = key.split(':');
  if (parts.length < 4) return undefined;
  const [tenantId, ruleId, zoneKey] = parts;
  if (tenantId === undefined || ruleId === undefined || zoneKey === undefined) return undefined;
  const subject = parts.slice(3).join(':');
  if (subject === '') return undefined;
  return { tenantId, ruleId, zoneKey, subject };
}

/**
 * The median of a small sample, in seconds. `null` for an empty one.
 *
 * ⚠️ Median rather than mean, because one genuine hole would drag a mean towards itself and the
 * statistic would stop describing "normal" at exactly the moment it matters.
 */
function median(valuesMs: readonly number[]): number | null {
  if (valuesMs.length === 0) return null;
  const sorted = [...valuesMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return value / 1000;
}

/* ⚠️ Re-exported so callers in this service have one import — it lives in `@vip/contracts` so every
 * surface asks the same question of the same numbers. */
export { gapIsUnusual };
