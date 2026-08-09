/**
 * **Composable temporal rules over the behaviour graph** (Phase 2.4 slice 2.7) — Layer 3.
 *
 *     behaviour graph  ──▶  BehaviourRule  ──▶  BehaviourCandidate + WHY chain
 *     geometry, no intent   ordered steps       the first thing allowed to mean something
 *
 * ### ⛔ Why the existing rule engine could not express this
 *
 * `RuleCondition` is a predicate tree over **one `EventEnvelope`**, with a windowed count on top. It
 * answers *"does this event match, and have N matched lately"*. It cannot say *"this person entered
 * a zone, **then** took something, **then** it stopped being visible, and they **never** went to the
 * till"* — an ordered chain across time with a negation in it. That sentence is the whole of what a
 * behaviour rule is, and every clause of it is a fact the graph already holds.
 *
 * ⚠️ **This is an addition, not a replacement.** Per-event rules keep doing what they do well
 * (a threshold crossed, a class seen, a rate exceeded) and remain the only thing on the hot path.
 * These are evaluated on demand over a finished or in-progress analysis, never per frame.
 *
 * ### ⛔ The vocabulary is geometry; only the *rule* names a domain
 *
 * Every `kind` below is an edge or attribute the behaviour graph already produces — `visited`,
 * `carried`, `picked`, `wentMissing`, `near`, `crossed`, `linger`. None of them names an intent, and
 * a test asserts that. What makes a rule about retail is the *author* writing `zoneId: 'z_shelf'`
 * and `objectLabel: 'bottle'` into the steps — configuration, in one tenant's database, not a
 * concept compiled into the platform. That is exactly the line [ADR-0052] draws, and it is why the
 * platform ships this language with **no** retail rule in it.
 *
 * ### ⭐ `absent` is the step that makes the language worth having
 *
 * *"…and never entered the checkout zone"* is not a missing step, it is an asserted one. Without it,
 * a rule can only describe what happened, and the interesting patterns are all shaped like *this
 * happened and that did not*. It is also the step most likely to be wrong for an honest reason: an
 * absence is only meaningful over a stated window and against a scene that was actually observed,
 * which is why the evaluator records what it searched rather than only that it found nothing.
 *
 * [ADR-0052]: ../../../../docs/adr/ADR-0052-behaviour-reasoning-is-not-perception.md
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

/**
 * The graph facts a step can match.
 *
 * ⚠️ These are **exactly** the edge kinds `behaviour_graph.py` emits plus the two node attributes
 * that describe a subject alone. A kind here with no producer there is a rule nobody can satisfy and
 * nothing would say so; a contract test asserts the two lists agree.
 */
export const BehaviourStepKind = z.enum([
  /** Edges between an identity and a place, thing or person. */
  'visited',
  'crossed',
  'carried',
  'picked',
  'dropped',
  'wentMissing',
  'returned',
  'handedOver',
  'near',
  'followed',
  'approached',
  'receded',
  'member',
  /** Node attributes — things a subject did alone. See `behaviour_graph` on why these are not edges. */
  'idle',
  'linger',
]);
export type BehaviourStepKind = z.infer<typeof BehaviourStepKind>;

/**
 * One clause of a chain.
 *
 * ⚠️ Every filter is optional and every omitted filter widens the step. `{ kind: 'carried' }` matches
 * carrying anything; adding `objectLabel: 'bottle'` narrows it. A step with no filters at all is
 * legal and says "this kind of thing happened", which is occasionally exactly the question.
 */
export const BehaviourStep = z.object({
  kind: BehaviourStepKind,
  /** Free-text, shown in the WHY chain instead of the machine phrasing when present. */
  as: z.string().max(120).optional(),
  /** For `visited`: which zone. For `crossed`: which line. */
  zoneId: z.string().min(1).max(120).optional(),
  lineId: z.string().min(1).max(120).optional(),
  /** For `crossed`: which way. ⚠️ Bound to the zone *version* — reversing a line swaps the sides. */
  toSide: z.enum(['left', 'right']).optional(),
  /** For object steps: the detector class of the thing, e.g. `bottle`. */
  objectLabel: z.string().min(1).max(80).optional(),
  /** For `near` / `followed` / `handedOver`: the other party's detector class. */
  otherLabel: z.string().min(1).max(80).optional(),
  /** The fact must have lasted at least this long. */
  minSeconds: z.number().min(0).max(86_400).optional(),
  /**
   * ⛔ **The step must NOT have happened.**
   *
   * Checked over the chain's window, or the whole observed run when the chain has none. ⚠️ An
   * absence is only as strong as the observation behind it, so the evaluator records the window it
   * searched and how many candidate facts it looked at — "nothing found" and "nothing looked at" are
   * different answers and they read identically in a summary.
   */
  absent: z.boolean().default(false),
});
export type BehaviourStep = z.infer<typeof BehaviourStep>;

/**
 * An ordered chain of behaviour facts about one subject.
 *
 * ⚠️ **Steps are ordered in footage time, and each matches at or after the previous one.** A rule
 * whose steps could match in any order is a set, not a sequence, and the sequence is the point:
 * taking something and then putting it back is a different story from putting something back and
 * then taking it.
 */
export const BehaviourRule = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** ⚠️ Bumped on every content change and stamped onto every candidate, so a past verdict stays readable. */
  version: z.number().int().min(1).default(1),
  enabled: z.boolean().default(true),
  /** Cameras this rule applies to. Empty means every camera the caller can see. */
  cameraIds: z.array(z.string().min(1)).default([]),
  steps: z.array(BehaviourStep).min(1).max(20),
  /**
   * The whole chain must complete within this many footage seconds of its first step.
   *
   * ⚠️ Optional, and its absence is a real choice rather than a default: a shift-long pattern has no
   * useful window, while "took something and left within two minutes" is only meaningful with one.
   */
  withinSeconds: z.number().min(1).max(86_400).optional(),
  /**
   * What to call a subject that matches. ⛔ **The only place in the platform allowed to name an
   * intent**, and it is tenant configuration rather than code — see the module docstring.
   */
  candidateLabel: z.string().min(1).max(200),
  /** Advisory severity for whatever consumes the candidate. Never read while evaluating. */
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  createdAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime.optional(),
});
export type BehaviourRule = z.infer<typeof BehaviourRule>;

/**
 * One link of the WHY chain: the step, whether it held, and the graph fact that decided it.
 *
 * ⛔ **`evidence` is not optional decoration.** A link that cannot be clicked back to a frame is an
 * assertion, and a chain of assertions is exactly what this layer exists not to produce.
 */
export const BehaviourReasonLink = z.object({
  index: z.number().int().min(0),
  step: BehaviourStep,
  matched: z.boolean(),
  /** A sentence an operator reads. ⚠️ States the fact and the number, never a motive. */
  reason: z.string().min(1).max(600),
  /** ⚠️ An offset into the run — see `BehaviourCandidate.fromSeconds`. */
  atSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
  seconds: z.number().optional(),
  /** The same instant on the footage clock, for joining. */
  footageAtSeconds: z.number().optional(),
  /** The graph edge or node this link matched, so a viewer can highlight it. */
  edgeId: z.string().optional(),
  nodeId: z.string().optional(),
  /** `{ frameIndex, trackId }` — where to look. */
  evidence: z.record(z.string(), z.unknown()).default({}),
  /**
   * For an `absent` step: how much was actually examined.
   *
   * ⚠️ `considered: 0` means nothing of that kind was in the graph *at all*, which is a much weaker
   * statement than "seven candidates were checked and none was the checkout zone". Both satisfy the
   * step; only one is worth acting on.
   */
  considered: z.number().int().min(0).optional(),
  searchedFromSeconds: z.number().optional(),
  searchedToSeconds: z.number().optional(),
});
export type BehaviourReasonLink = z.infer<typeof BehaviourReasonLink>;

/**
 * A subject that matched a rule, and the chain that says why.
 *
 * ⚠️ **A candidate, never an incident.** Naming it that is a deliberate refusal: what this layer can
 * establish is that a described sequence of geometry occurred. Whether that warrants an incident,
 * a notification or a shrug is a decision with a human and a policy behind it.
 */
export const BehaviourCandidate = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  ruleName: z.string().min(1),
  label: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  identityId: z.string().min(1),
  cameraId: z.string(),
  streamId: z.string().optional(),
  /**
   * Offsets into the run of the first and last matched step.
   *
   * ⛔ **Offsets, not the footage clock.** A recording stamped with wall-clock capture times gives
   * footage seconds around 1.79e9, and the first deployed evaluation of this rule reported a subject
   * "was inside the zone at 1786221387.294 s" — true, useless, and exactly the defect `TimelineEntry`
   * was fixed for a milestone earlier. The absolute values are kept beside these because that is what
   * joins to a history point or an event; one is readable, the other is joinable.
   */
  fromSeconds: z.number(),
  toSeconds: z.number(),
  footageFromSeconds: z.number(),
  footageToSeconds: z.number(),
  /**
   * 0–1, and ⛔ **it is a coverage measure, not a probability.** It is the share of the chain's steps
   * that matched on evidence carrying a frame reference — a rule whose every link is seekable scores
   * 1.0. Calling it a likelihood would invite somebody to read 0.8 as "probably a thief", which this
   * layer has no basis whatsoever to claim.
   */
  confidence: z.number().min(0).max(1),
  /** Every link, matched or not, in order. The matched ones are what fired it. */
  chain: z.array(BehaviourReasonLink),
  /** One line, assembled from the chain rather than written beside it. */
  summary: z.string().min(1).max(2000),
});
export type BehaviourCandidate = z.infer<typeof BehaviourCandidate>;

/** What one evaluation looked at and what it found — the shape the read API returns. */
export const BehaviourReasoningResult = z.object({
  rulesEvaluated: z.number().int().min(0),
  identitiesEvaluated: z.number().int().min(0),
  candidates: z.array(BehaviourCandidate),
  /**
   * ⛔ Carried through from the graph. Past the relational cap the pairwise families never ran, so a
   * rule with a `near` step could not have matched and its silence means nothing.
   */
  graphTruncated: z.object({
    nodes: z.boolean(),
    edges: z.boolean(),
    relational: z.boolean(),
    identitiesConsidered: z.number().int().min(0),
  }),
  /** ⚠️ Wall-clock, so a slow evaluation is visible rather than inferred from a timeout. */
  elapsedMs: z.number().min(0),
});
export type BehaviourReasoningResult = z.infer<typeof BehaviourReasoningResult>;
