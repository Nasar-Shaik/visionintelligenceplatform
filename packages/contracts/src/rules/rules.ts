/**
 * Rule-engine contracts (Phase 1, P1-7). Rules answer **"IF event THEN action"** over the canonical
 * `EventEnvelope` (never over raw `DetectionResult` — the rule engine consumes only events, keeping
 * perception and automation decoupled, per the P1-5 Architect review + [10-RULE-ENGINE]). Conditions
 * are a **pure, sandboxed predicate tree** — data, not code (no arbitrary execution) — evaluated by a
 * bounded interpreter. Distinct from the Policy Engine ([ADR-0013]): rules = business triggers,
 * policy = who/what/where/when governance. Grounds: docs/architecture/10-RULE-ENGINE.md,
 * docs/architecture/phase1/RULE_ENGINE.md.
 */
import { z } from 'zod';
import {
  Confidence,
  EventType,
  IsoDateTime,
  SemVer,
  TenantId,
  Uuid,
} from '../common/primitives.js';
import { EventPriority } from '../events/priority.js';
import { EventCategory } from '../events/category.js';
import { EventEnvelope } from '../events/envelope.js';

/** Comparison operators for a predicate leaf. All are pure + total (no regex/code — ReDoS-safe). */
export const RuleOperator = z.enum([
  'eq',
  'ne',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
  'contains',
]);
export type RuleOperator = z.infer<typeof RuleOperator>;

/**
 * A single predicate over one envelope field. `field` is a dotted path into the `EventEnvelope`
 * (e.g. `type`, `category`, `cameraId`, `zoneId`, `priority`, `confidence`, `subjects.0.class`,
 * `subjects.0.attributes.color`). `value` is absent only for `exists`.
 */
export const RulePredicate = z.object({
  field: z.string().min(1),
  op: RuleOperator,
  value: z.unknown().optional(),
});
export type RulePredicate = z.infer<typeof RulePredicate>;

/** A condition is a predicate leaf or a boolean composite (`all`/`any`/`not`) — a finite tree. */
export type RuleCondition =
  RulePredicate | { all: RuleCondition[] } | { any: RuleCondition[] } | { not: RuleCondition };

export const RuleCondition: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(RuleCondition).min(1) }),
    z.object({ any: z.array(RuleCondition).min(1) }),
    z.object({ not: RuleCondition }),
    RulePredicate,
  ]),
);

/**
 * Optional windowed threshold: fire only when **≥ `count`** matching events occur within
 * `withinSeconds`, grouped by `groupBy` (per camera/zone/tenant). Backed by tenant-scoped rule state
 * (Redis in prod). Absent → the rule is stateless (fires on each matching event).
 */
export const RuleWindow = z.object({
  withinSeconds: z.number().int().min(1).max(86_400),
  count: z.number().int().min(1).max(100_000),
  groupBy: z.enum(['none', 'camera', 'zone']).default('none'),
});
export type RuleWindow = z.infer<typeof RuleWindow>;

/**
 * What a dwell rule accumulates over (P-8 Phase 7).
 *
 * ⚠️ **`identity` is the only correct answer for a person, and picking `track` fails silently.** A
 * subject occluded for a second comes back with a new `trackId` — ADR-0038 forbids reusing one — so a
 * 60-second threshold keyed on `trackId` sees two 30-second visits and never fires. There is no
 * error, nothing is dropped, and it gets *worse as the host gets busier*, because identity fragments
 * under load ([L-42]). The same rule then fires on a quiet site and not on a busy one.
 *
 * `track` is offered anyway, for the case where the question genuinely is "one uninterrupted
 * observation" — an abandoned object, say, where a re-linked identity would be a different object.
 * The console labels it as such and defaults to `identity`.
 */
export const DwellGroupBy = z.enum(['identity', 'track']);
export type DwellGroupBy = z.infer<typeof DwellGroupBy>;

/**
 * **Continuous presence for a minimum duration** — the stateful stage loitering is built from
 * (P-8 Phase 7 §Implementation).
 *
 * ### ⚠️ How this differs from `window`, and why it could not be expressed as one
 *
 * `window` counts *events*: "≥ 5 matches within 60 seconds". Dwell measures *elapsed time between the
 * first and the most recent observation of one subject*: "the same person, here, for 60 seconds". The
 * two come apart whenever the frame rate does — a window of "120 events in 60 s" is a statement about
 * the deployment's fps, not about the customer's rule, and it breaks the moment a camera is throttled
 * or a runtime sheds load. Expressing dwell as a count would have made every loitering rule silently
 * frame-rate-dependent.
 *
 * ### ⚠️ What the accumulated duration actually means
 *
 * It is **observed** duration: `lastObservedAt − firstObservedAt` for one subject in one zone. It is
 * not a claim of continuous physical presence, because the platform sees frames rather than reality.
 * `IncidentDwell.longestGapSeconds` travels with every candidate for exactly this reason — a
 * 90-second dwell assembled from observations with a 40-second hole in the middle is a different
 * assertion from one sampled twice a second, and an operator must be able to tell them apart.
 */
export const RuleDwell = z.object({
  /** How long the subject must be present before the rule fires. The customer's "Minimum Dwell Time". */
  minSeconds: z.number().int().min(1).max(86_400),
  /** What "the same subject" means. See `DwellGroupBy` — `identity` unless you know otherwise. */
  groupBy: DwellGroupBy.default('identity'),
  /**
   * **Reset condition**: a gap longer than this ends the visit, and the next observation starts a new
   * one from zero.
   *
   * ⚠️ This is the knob that decides whether somebody who leaves and returns is one long loiter or two
   * short visits, and there is no universally right value — it is the customer's policy, which is why
   * it is configuration. It must be **larger than the observation interval** or every subject resets
   * between frames and nothing ever accumulates; validation enforces a floor, and the console warns
   * when it is close to the deployment's frame interval.
   */
  resetAfterSeconds: z.number().int().min(1).max(3_600).default(30),
  /**
   * **Cool-down**: after firing for a subject, stay silent about that same subject-in-zone for this
   * long.
   *
   * ⚠️ Without it a loitering rule fires on *every frame* past the threshold — at 2 fps that is 120
   * incidents a minute for one person standing still, which is not an alerting system, it is a denial
   * of service against the operator. `0` disables it and is allowed, because a rule with a very long
   * `resetAfterSeconds` may legitimately want one incident per visit and nothing more.
   */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(300),
});
export type RuleDwell = z.infer<typeof RuleDwell>;

/** Raise an incident candidate (the primary Phase-1 action). */
export const RaiseIncidentAction = z.object({
  type: z.literal('raise-incident'),
  /** Optional title override (else derived from the rule name + triggering event). */
  title: z.string().min(1).optional(),
  /** Optional severity override (else the rule's `severity`). */
  severity: EventPriority.optional(),
});

/** Emit a derived platform event (e.g. an aggregate). Kept minimal in Phase 1. */
export const EmitEventAction = z.object({
  type: z.literal('emit-event'),
  eventType: EventType,
});

export const RuleAction = z.discriminatedUnion('type', [RaiseIncidentAction, EmitEventAction]);
export type RuleAction = z.infer<typeof RuleAction>;

/**
 * Rule lifecycle (P1-7 Architect review) — an explicit authoring/operational state, not a boolean.
 * Only `enabled` rules are evaluated by the engine; `draft`/`validated` are authoring stages,
 * `disabled` is paused, `archived` is retired (retained for audit). Transitions are versioned.
 */
export const RuleLifecycleState = z.enum(['draft', 'validated', 'enabled', 'disabled', 'archived']);
export type RuleLifecycleState = z.infer<typeof RuleLifecycleState>;

/**
 * **Where a rule applies** (P-4) — authored intent, expressed against the frozen Location Hierarchy.
 *
 * A scope is a set of **node ids** (any level: org, region, site, building, floor, zone) and/or a set
 * of **camera ids**. A node includes everything beneath it, so "the London site" is one id rather
 * than the forty zones under it — and stays correct as zones are added.
 *
 * An empty scope means **tenant-wide**, which is the right default for a small customer and a
 * deliberate choice for a large one. It is never implicit: the console shows what a rule covers.
 *
 * This is intent, not evaluation. What the engine matches against is `ResolvedRuleScope` — see there
 * for why the two are separate.
 */
export const RuleScope = z.object({
  /** Hierarchy nodes this rule covers, including their descendants. */
  nodeIds: z.array(z.string().min(1)).max(200).default([]),
  /** Individual cameras this rule covers, regardless of where they sit. */
  cameraIds: z.array(z.string().min(1)).max(500).default([]),
  /**
   * **Camera groups** this rule covers (P-8 Phase 7 §Implementation).
   *
   * Groups were stored but deliberately inert in P-8 Phase 6 — "prepare the contracts and storage,
   * no logic". This is the first thing that reads them, and it reads them exactly once: at
   * validation, where the group is expanded into `ResolvedRuleScope.cameraIds` and snapshotted. The
   * engine never learns that groups exist.
   *
   * ⚠️ The cost of snapshotting is **staleness**, identical to the location hierarchy's: a camera
   * added to a group after the rule was validated is not covered until the rule is re-validated.
   * That is visible (`resolvedAt`, and the console says so) rather than silent, and it is the right
   * trade — the alternative is a group lookup per rule per event.
   */
  groupIds: z.array(z.string().min(1)).max(100).default([]),
  /**
   * **Detection zones** this rule covers (P-8 Phase 7 §Zones) — polygons on a camera's image plane.
   *
   * ⚠️ **Not hierarchy zones.** `nodeIds` may also contain something called a zone, and it means a
   * *place*; these mean *an area of one camera's picture*. Two id spaces, one word. They are kept in
   * separate fields here and in `ResolvedRuleScope` so neither can be silently matched against the
   * other — see `DetectionZone` and ADR-0044.
   */
  zoneIds: z.array(z.string().min(1)).max(500).default([]),
});
export type RuleScope = z.infer<typeof RuleScope>;

/**
 * A rule's scope **resolved to the leaf ids an event can be matched against**, snapshotted at
 * validation time.
 *
 * Two reasons this is stored rather than recomputed:
 *
 * 1. **Evaluation must not query.** Matching an event against "everything under the London site" has
 *    to be a set membership test — the engine sees millions of events and a lookup per event per rule
 *    is the shape that does not survive contact with production.
 * 2. **A version must mean one thing forever.** The resolution is part of the immutable rule version,
 *    so an incident raised six months ago can be shown the exact set of zones its rule covered *then*.
 *    Recomputing would silently rewrite the past — the same failure E-1 records for evidence.
 *
 * The cost is **staleness**: zones added under a scoped node after resolution are not covered until
 * the rule is re-validated. That is visible (`resolvedAt`, and the console says so) rather than
 * silent, and revalidation is one click. See ADR-0026.
 */
export const ResolvedRuleScope = z.object({
  /**
   * Every **location-hierarchy** zone id the scope covers, expanded from the authored `nodeIds`.
   *
   * ⚠️ A *place*, not a polygon. Matched against `EventEnvelope.zoneId` before P-8 Phase 7, which is
   * why the two spaces had to be separated when detection zones started stamping that field — see
   * `detectionZoneIds` and ADR-0044.
   */
  zoneIds: z.array(z.string().min(1)).default([]),
  /**
   * Every **detection zone** id the scope covers (P-8 Phase 7): the zones authored directly, plus
   * nothing else. Zones are not hierarchical, so there is no expansion — this is a snapshot for
   * symmetry with the rest of the resolution and so the engine holds one shape.
   */
  detectionZoneIds: z.array(z.string().min(1)).default([]),
  /**
   * Camera ids the scope covers: authored directly **and** expanded from `groupIds` (P-8 Phase 7).
   *
   * ⚠️ Deliberately merged rather than kept apart. The engine asks one question — "is this camera
   * covered?" — and answering it from two sets would be two lookups for no gain. Which cameras came
   * from a group is authoring provenance, and it lives in `groupCameraIds` for the console to show.
   */
  cameraIds: z.array(z.string().min(1)).default([]),
  /** The subset of `cameraIds` that arrived via a group. Presentation only; the engine ignores it. */
  groupCameraIds: z.array(z.string().min(1)).default([]),
  /** True when the authored scope was empty — the rule applies everywhere in the tenant. */
  tenantWide: z.boolean().default(true),
  /** When the expansion was computed. A hierarchy or group change after this is not reflected. */
  resolvedAt: IsoDateTime,
});
export type ResolvedRuleScope = z.infer<typeof ResolvedRuleScope>;

/** A persisted, versioned rule (owned by the rules context). */
export const Rule = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Lifecycle state — only `enabled` rules are evaluated. */
  lifecycle: RuleLifecycleState.default('draft'),
  /** Evaluation priority (higher first); also the deterministic tie-break with `id`. */
  priority: z.number().int().min(0).max(1000).default(100),
  /** Monotonic version — bumps on every content change (audit trail in rule versions). */
  version: z.number().int().min(1),
  /**
   * **The version that is live** (P-8 Phase 7, Architect rec 1 — versioning preparation).
   *
   * ⚠️ Today this equals `version` whenever the rule is enabled and is absent otherwise, because the
   * engine evaluates the current content and nothing else. It is declared now so that "edit a rule
   * that is running without changing what is running" — the draft/publish split — becomes a change to
   * the *engine's read* rather than a change to the *stored shape*, which is the part that would
   * otherwise need a migration on a live estate.
   *
   * ⚠️ **No approval workflow, deliberately.** The Architect asked for the contract to be ready, not
   * for the feature. A half-built approval gate is worse than none: somebody would ship a rule
   * believing it had been reviewed. What exists is a field an incident already stamps
   * (`IncidentCandidate.ruleVersion`), a full immutable history (`RuleVersionRecord`) and a rollback
   * (`RuleRollbackInput`) — publishing is the only missing verb.
   */
  publishedVersion: z.number().int().min(1).optional(),
  /** Fast pre-filter by event type (empty = any type). */
  eventTypes: z.array(EventType).default([]),
  /** Fast pre-filter by category (empty = any category). */
  categories: z.array(EventCategory).default([]),
  /** Detailed predicate over the envelope (absent = always true given the pre-filter). */
  condition: RuleCondition.optional(),
  /** Optional windowed threshold (stateful). */
  window: RuleWindow.optional(),
  /** Optional minimum-dwell threshold (stateful, per subject per zone) — P-8 Phase 7. */
  dwell: RuleDwell.optional(),
  /**
   * **Dry run** (P-8 Phase 7 §Implementation) — evaluate fully, publish `rule.matched`, raise nothing.
   *
   * ⚠️ Distinct from `POST /rules/:id/simulate`, and the difference is the whole point. Simulation
   * runs a rule against events *you* supply; dry run runs it against the live estate, in the engine,
   * on real traffic, for as long as you leave it on — which is the only way to find out how often a
   * threshold would have fired at 4 p.m. on a Saturday before committing to waking somebody up.
   *
   * ⚠️ It is a property of the **rule**, not of a request, so it survives restarts and is visible in
   * the rule list. A dry-run flag that lived in a session would be forgotten in the on position, and
   * "why did this rule stop raising incidents" is not a question anybody should have to ask twice.
   *
   * Stateful stages still advance: a dry-run dwell rule accumulates and cools down exactly as it
   * would live, or the numbers it reports would describe a rule nobody is going to run.
   */
  dryRun: z.boolean().default(false),
  /** Severity carried onto the incident candidate. */
  severity: EventPriority.default('medium'),
  actions: z.array(RuleAction).min(1),
  /** Where this rule applies (P-4). Absent/empty = tenant-wide. */
  scope: RuleScope.default({ nodeIds: [], cameraIds: [], groupIds: [], zoneIds: [] }),
  /** The scope expanded to leaf ids, snapshotted at validation. Absent until first validated. */
  resolvedScope: ResolvedRuleScope.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: z.string().optional(),
});
export type Rule = z.infer<typeof Rule>;

/** Author input to create a rule (id/version/timestamps are assigned by the service). */
export const CreateRuleInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  lifecycle: RuleLifecycleState.default('draft'),
  priority: z.number().int().min(0).max(1000).default(100),
  eventTypes: z.array(EventType).default([]),
  categories: z.array(EventCategory).default([]),
  condition: RuleCondition.optional(),
  window: RuleWindow.optional(),
  dwell: RuleDwell.optional(),
  dryRun: z.boolean().default(false),
  severity: EventPriority.default('medium'),
  actions: z.array(RuleAction).min(1),
  scope: RuleScope.default({ nodeIds: [], cameraIds: [], groupIds: [], zoneIds: [] }),
});
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;

/** Partial update — any provided field is a content change that bumps the version. */
export const UpdateRuleInput = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  lifecycle: RuleLifecycleState.optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  eventTypes: z.array(EventType).optional(),
  categories: z.array(EventCategory).optional(),
  condition: RuleCondition.optional(),
  window: RuleWindow.optional(),
  dwell: RuleDwell.optional(),
  dryRun: z.boolean().optional(),
  severity: EventPriority.optional(),
  actions: z.array(RuleAction).min(1).optional(),
  scope: RuleScope.optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

/**
 * What a validation check looked at (P-4).
 *
 * Declared as a closed set **ahead of the checks that use it**, for the reason the evidence sources
 * were: adding a value to a published enum is not purely additive for a strict parser, so the values
 * a future check will need are declared now rather than added later.
 *
 * `condition` was added in P-4.1 and is the one value that exercise missed — the budget checks
 * (Architect rec 4) are about the rule's own predicate tree, which is not a reference to anything and
 * had no honest home among the rest. Recorded as a deliberate extension in ADR-0027 rather than
 * squeezed into `action`, which would have made every over-budget condition report the wrong subject.
 */
export const RuleReferenceKind = z.enum([
  'location',
  'camera',
  'event-type',
  'category',
  'behavior',
  'composite',
  'schedule',
  'output',
  'action',
  'condition',
  /**
   * P-8 Phase 7. A **detection zone** — a polygon on a camera, not a location (`location` above is
   * the hierarchy). Separate kinds because "what breaks if I delete this?" has different answers and
   * different owners: the Tenant context owns places, the Camera context owns polygons.
   */
  'zone',
  /** P-8 Phase 7. A **camera group**, expanded at validation into cameras. */
  'camera-group',
  /** P-8 Phase 7. The rule's own `dwell` block — like `condition`, it references nothing external. */
  'dwell',
]);
export type RuleReferenceKind = z.infer<typeof RuleReferenceKind>;

/** Severity of a validation finding. Only `error` blocks activation. */
export const RuleIssueSeverity = z.enum(['error', 'warning', 'info']);
export type RuleIssueSeverity = z.infer<typeof RuleIssueSeverity>;

/** One thing wrong with a rule, named precisely enough to fix without guessing. */
export const RuleValidationIssue = z.object({
  code: z.string().min(1).max(60),
  severity: RuleIssueSeverity,
  kind: RuleReferenceKind,
  message: z.string().min(1).max(400),
  /** The id or field the issue is about, when there is one. */
  ref: z.string().max(200).optional(),
});
export type RuleValidationIssue = z.infer<typeof RuleValidationIssue>;

/**
 * The outcome of validating a rule (P-4). **A rule cannot be enabled without a passing report.**
 *
 * `verified` is the field that matters and the one that is easy to get wrong. A reference check needs
 * the context that owns the thing referenced; when that context is unreachable, the honest answer is
 * **"not verified"** — never "valid". A rule that goes live because a check could not run is exactly
 * the failure the platform's evidence discipline exists to prevent, applied to configuration instead
 * of to devices ([FOUNDATION_PRINCIPLES §3](../../../docs/project/FOUNDATION_PRINCIPLES.md)).
 */
export const RuleValidationReport = z.object({
  ruleId: z.string().min(1),
  /** The rule version this report describes. A later version needs its own report. */
  ruleVersion: z.number().int().min(1),
  /** No `error`-severity issues **and** every check actually ran. */
  valid: z.boolean(),
  /** Every reference check completed. False when a provider was unavailable. */
  verified: z.boolean(),
  issues: z.array(RuleValidationIssue).default([]),
  /** Which reference kinds were actually checked — the rest were not looked at. */
  checked: z.array(RuleReferenceKind).default([]),
  checkedAt: IsoDateTime,
});
export type RuleValidationReport = z.infer<typeof RuleValidationReport>;

/**
 * One node of an evaluated condition tree, with what was actually seen (P-4).
 *
 * Explainability is not a log line. An operator asking _why did this rule not fire_ needs the specific
 * leaf that failed and the value it compared against — "confidence 0.71 is not ≥ 0.8" ends the
 * conversation, while "condition did not match" starts an investigation.
 *
 * Traces are **derived on demand**, never stored: the same rule as
 * [Foundation Principle 2](../../../docs/project/FOUNDATION_PRINCIPLES.md), and what lets an
 * explanation improve retroactively rather than being frozen in the words of the version that wrote
 * it.
 */
export interface ConditionTrace {
  readonly kind: 'predicate' | 'all' | 'any' | 'not';
  readonly passed: boolean;
  /** Leaf only: the dotted field path that was read. */
  readonly field?: string | undefined;
  readonly op?: RuleOperator | undefined;
  /** Leaf only: what the rule expected, and what the event actually carried. */
  readonly expected?: unknown;
  readonly actual?: unknown;
  /** Why this node came out as it did, in words an operator can act on. */
  readonly reason: string;
  readonly children?: readonly ConditionTrace[] | undefined;
}

export const ConditionTrace: z.ZodType<ConditionTrace> = z.lazy(() =>
  z.object({
    kind: z.enum(['predicate', 'all', 'any', 'not']),
    passed: z.boolean(),
    field: z.string().optional(),
    op: RuleOperator.optional(),
    expected: z.unknown().optional(),
    actual: z.unknown().optional(),
    reason: z.string(),
    children: z.array(ConditionTrace).optional(),
  }),
);

/**
 * The stages of evaluation, in the order the engine applies them.
 *
 * ⚠️ `dwell` sits **after** `window` and is the last stage, because it is the most expensive and the
 * only one that can be decided by state this node might not have. Ordering the stages cheapest-first
 * is what makes "evaluate every rule against every event" affordable, and it is also what makes an
 * explanation useful: the first stage that fails is the one worth fixing.
 */
export const RuleStage = z.enum([
  'lifecycle',
  'scope',
  'prefilter',
  'condition',
  'window',
  'dwell',
]);
export type RuleStage = z.infer<typeof RuleStage>;

/**
 * One stage of an evaluation, as a node of a tree (P-4.1, Architect rec 6).
 *
 * `stages` (below) answers _which stage decided_; this answers _show me the whole decision_ in one
 * walkable shape, with the condition tree hanging under the condition stage. It is a **projection of
 * the same evaluation**, assembled from the traces the interpreter already produced — there is no
 * second evaluator, and there must never be one: an explanation that describes a decision the engine
 * did not make is worse than no explanation, because it is believed.
 *
 * P-5's investigation workspace renders this directly.
 */
export interface StageTrace {
  readonly stage: RuleStage;
  readonly passed: boolean;
  /** True for the one stage that decided the outcome — the first that failed, or the last on a match. */
  readonly decisive: boolean;
  readonly reason: string;
  /** The condition tree, under the condition stage. Empty elsewhere. */
  readonly children?: readonly ConditionTrace[] | undefined;
}

export const StageTrace: z.ZodType<StageTrace> = z.lazy(() =>
  z.object({
    stage: RuleStage,
    passed: z.boolean(),
    decisive: z.boolean(),
    reason: z.string(),
    children: z.array(ConditionTrace).optional(),
  }),
);

/**
 * Why a rule did or did not fire for one event (P-4).
 *
 * The stages are listed in the order they are applied, each with its own verdict, so the **first**
 * `false` is the answer. A rule that is scoped to the wrong site and also has a failing condition
 * should report the scope — fixing the condition would not have helped.
 */
export const RuleExplanation = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  ruleName: z.string(),
  matched: z.boolean(),
  /** The stage that decided the outcome. `matched` when every stage passed. */
  decidedBy: z.enum(['lifecycle', 'scope', 'prefilter', 'condition', 'window', 'dwell', 'matched']),
  /** One line an operator can read without knowing the rule's internals. */
  summary: z.string().min(1).max(400),
  stages: z.object({
    lifecyclePassed: z.boolean(),
    scopePassed: z.boolean(),
    prefilterPassed: z.boolean(),
    conditionPassed: z.boolean(),
    windowPassed: z.boolean(),
    /**
     * P-8 Phase 7. ⚠️ Optional so an explanation captured before dwell existed still parses — and,
     * more usefully, so `true` never has to stand in for "this rule has no dwell stage". A rule
     * without dwell reports `undefined` here and no `dwell` stage in `tree`.
     */
    dwellPassed: z.boolean().optional(),
  }),
  /**
   * Every stage as a walkable tree, with the condition nested under its stage (P-4.1). The same
   * evaluation as `stages` + `condition`, in the shape a viewer renders.
   */
  tree: z.array(StageTrace).default([]),
  /** The condition tree with per-node outcomes. Absent when the rule has no condition. */
  condition: ConditionTrace.optional(),
  /** For a windowed rule: how many matches were counted, and how many were needed. */
  window: z
    .object({
      counted: z.number().int().min(0),
      required: z.number().int().min(1),
      withinSeconds: z.number().int().min(1),
    })
    .optional(),
  /**
   * For a dwell rule: how long the subject has been observed, against how long is required
   * (P-8 Phase 7).
   *
   * ⚠️ Every field here is what was *measured*, including the ones that make the rule look bad.
   * `longestGapSeconds` and `trackFragments` are the two that turn "it fired" into "it fired, and
   * here is how much of that duration we actually watched".
   */
  dwell: z
    .object({
      /** `identity` or `track`, whichever the rule accumulates on. */
      groupBy: DwellGroupBy,
      /** The subject key this observation was filed under — an identityId or a trackId. */
      subject: z.string().optional(),
      zoneId: z.string().optional(),
      observedSeconds: z.number().nonnegative(),
      requiredSeconds: z.number().nonnegative(),
      observations: z.number().int().nonnegative(),
      /** Distinct track ids seen under one identity. `>1` means tracking fragmented and was bridged. */
      trackFragments: z.number().int().nonnegative(),
      longestGapSeconds: z.number().nonnegative(),
      /** True when this observation started a fresh visit because the gap exceeded the reset. */
      reset: z.boolean(),
      /** True when the threshold was met but the rule stayed silent inside its cool-down. */
      coolingDown: z.boolean(),
      /** Seconds left on the cool-down, when one is running. */
      cooldownRemainingSeconds: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type RuleExplanation = z.infer<typeof RuleExplanation>;

/** One immutable audit record of a rule change (the versioning/audit trail). */
export const RuleVersionRecord = z.object({
  tenantId: TenantId,
  ruleId: z.string().min(1),
  version: z.number().int().min(1),
  changeKind: z.enum(['created', 'updated', 'lifecycle-changed', 'deleted']),
  changedBy: z.string().optional(),
  changedAt: IsoDateTime,
  /** Snapshot of the rule at this version. */
  snapshot: Rule,
});
export type RuleVersionRecord = z.infer<typeof RuleVersionRecord>;

// ---------------------------------------------------------------------------------------------
// P-8 Phase 7 — what a candidate must carry for a person to act on it.
//
// The Architect's list was: Camera, Identity, Zone, Rule, Duration, Event Timeline, Evidence
// References, Confidence, Explanation. Every one of them below is either **measured** or **derived
// from something measured**, and the ones that cannot be either are absent rather than defaulted.
// ---------------------------------------------------------------------------------------------

/**
 * The candidate's place in a lifecycle that does not exist yet (Architect rec 3).
 *
 * ⚠️ Declared as a **closed set now, emitting one value**, for the reason `RuleReferenceKind` and
 * `DependencyStatus` were: adding a value to a published enum is not purely additive for a strict
 * parser, so the values a future milestone will need are declared while nothing yet depends on the
 * shape. This milestone emits `candidate` and only `candidate`; the rest are reserved and a producer
 * that sets one today would be lying about a workflow nobody has built.
 */
export const IncidentCandidateStatus = z.enum([
  /** Raised by the engine, not yet looked at. The only value P-8 Phase 7 emits. */
  'candidate',
  /** Reserved — a person or a policy accepted it and it became an incident. */
  'promoted',
  /** Reserved — a person judged it not worth an incident. */
  'dismissed',
  /** Reserved — collapsed into an earlier candidate for the same subject. */
  'merged',
  /** Reserved — aged out without anyone deciding. */
  'expired',
]);
export type IncidentCandidateStatus = z.infer<typeof IncidentCandidateStatus>;

/**
 * Where the pixels are (Architect rec 4: *reference evidence rather than copying it*).
 *
 * ⚠️ **A locator, never bytes and never a promise.** The rule engine has no access to media and must
 * not acquire any: an engine that reached for a clip while deciding whether to raise a candidate
 * would put a storage round trip on the per-event path and make an alert depend on a disk. What it
 * can do — with no I/O at all — is say precisely *which camera over which interval*, because it knows
 * both. Turning that into a clip is the Evidence context's job, on demand, when a person asks.
 *
 * ⚠️ `locator` is a **platform-relative path**, not a URL: it carries no host, no scheme and no token,
 * so it stays valid across deployments and cannot become a credential leak inside an incident record.
 */
export const CandidateEvidenceKind = z.enum([
  /** A recorded interval on a camera. The primary reference for a dwell candidate. */
  'recording-interval',
  /** A specific event in the Events context. */
  'event',
  /** An already-materialised Evidence item, when one happens to exist. */
  'evidence',
  /**
   * One captured frame, named by `tenant:camera:seq` (P-8 Phase 7 rec 1).
   *
   * ⚠️ The frame id is **derived**, not stored anywhere — it is the same deterministic triple the
   * event publisher stamps as `correlationId` and the normalizer copies into `payload.frameId`. So a
   * frame reference resolves by construction rather than by lookup, and re-deriving it always names
   * the same observation.
   */
  'frame',
  /**
   * A still image of a moment. ⚠️ **Reserved.** Nothing produces one on this path: the rule engine has
   * no access to pixels and must not acquire any (see `buildEvidenceRefs`). Declared now because
   * adding a value to a published enum is not purely additive for a strict parser, and because a
   * future snapshot capture must fit this timeline rather than replace it.
   */
  'snapshot',
  /** A rendered clip. ⚠️ **Reserved**, for the same reason as `snapshot`. */
  'video',
  /**
   * The subject itself — a reference into the tracking context (P-8 Phase 7 rec 1).
   *
   * ⚠️ An identity is evidence: "this is the person, here is their track history" is what turns a
   * duration into a story. It is the one entry that is not media and is included deliberately, so a
   * future workflow reusing this model has somewhere to put the subject.
   */
  'identity',
]);
export type CandidateEvidenceKind = z.infer<typeof CandidateEvidenceKind>;

export const CandidateEvidenceRef = z.object({
  kind: CandidateEvidenceKind,
  cameraId: z.string().min(1).optional(),
  /** The referenced artefact's id, for `event` and `evidence`. Absent for an interval. */
  id: z.string().min(1).optional(),
  startedAt: IsoDateTime.optional(),
  endedAt: IsoDateTime.optional(),
  /** Platform-relative path that resolves this reference. See the warning above. */
  locator: z.string().min(1).max(500),
  /** One line naming what a person would see if they followed it. */
  label: z.string().min(1).max(200),
});
export type CandidateEvidenceRef = z.infer<typeof CandidateEvidenceRef>;

/** What kind of moment a timeline entry marks (Architect rec 5). */
export const CandidateTimelineKind = z.enum([
  /** The first observation of this subject in this zone — the clock starts. */
  'first-observed',
  /** A subsequent observation. The bulk of a timeline, and the part that gets truncated. */
  'observed',
  /** The subject's track id changed under a stable identity — tracking fragmented and was bridged. */
  'identity-relinked',
  /** A gap longer than the observation interval but shorter than the reset. */
  'gap',
  /** The observed duration reached the rule's threshold. */
  'threshold-crossed',
  /** The candidate was raised. Always the last entry. */
  'raised',
]);
export type CandidateTimelineKind = z.infer<typeof CandidateTimelineKind>;

/**
 * One ordered moment in the story of a candidate (Architect rec 5).
 *
 * ⚠️ **Ordered by `at`, ascending, always** — a timeline whose order depends on the reader is not a
 * timeline. The browser renders it as a track without sorting, and the sort belongs where the entries
 * are built because that is the only place that knows they came from a single subject's history.
 */
export const CandidateTimelineEntry = z.object({
  at: IsoDateTime,
  kind: CandidateTimelineKind,
  /** The event this moment came from, when it came from one. Absent on derived markers. */
  eventId: Uuid.optional(),
  eventType: EventType.optional(),
  /**
   * The frame this moment was observed in — `tenant:camera:seq` (P-8 Phase 7 rec 1).
   *
   * ⚠️ The join key between a timeline entry and the pixels. Every other reference on the entry is a
   * platform id; this is the one that points at an image, and it is what a future snapshot or clip
   * would be captured from.
   */
  frameId: z.string().optional(),
  /** The track id carrying the identity at this moment — it changes on `identity-relinked`. */
  trackId: z.string().optional(),
  zoneId: z.string().optional(),
  confidence: Confidence.optional(),
  /** Seconds since the first observation. Precomputed so a renderer never parses dates to lay out. */
  elapsedSeconds: z.number().nonnegative(),
  /**
   * What a reader can open from this moment (P-8 Phase 7 rec 1).
   *
   * ⚠️ **Per entry, in addition to the candidate-level `evidence` array**, and the two are different
   * questions. The array answers "show me this incident"; these answer "show me *this instant* in
   * it". A timeline whose entries were unlinked would be a list of times, and the operator would be
   * left scrubbing.
   */
  evidence: z.array(CandidateEvidenceRef).max(4).default([]),
  /** One line, for a reader who is not going to expand the entry. */
  summary: z.string().min(1).max(300),
});
export type CandidateTimelineEntry = z.infer<typeof CandidateTimelineEntry>;

/**
 * A candidate's timeline: bounded, ordered, and honest about what it left out.
 *
 * ⚠️ **Bounded, and it has to be.** A ten-minute dwell at 2 fps is 1 200 observations; putting them
 * all on a message that travels through a broker and into a document store would make the record of
 * one person standing still larger than the video of them doing it. The head and tail are kept —
 * which is where the interesting entries are, because the markers cluster at the start and the end —
 * and `omitted` says exactly how many observations are missing rather than leaving a reader to infer
 * it from a suspiciously round count.
 */
export const CandidateTimeline = z.object({
  entries: z.array(CandidateTimelineEntry).max(64).default([]),
  /** Moments dropped between the head and the tail. `0` means the timeline is complete. */
  omitted: z.number().int().nonnegative().default(0),
  /**
   * Every moment that ever existed — `entries.length + omitted`, and the denominator for `omitted`.
   *
   * ⚠️ **Moments, not observations**, and the difference was a rendering bug the deployment found.
   * A timeline carries derived markers (`gap`, `threshold-crossed`, `raised`) as well as sightings,
   * so counting observations here made `entries.length` exceed `total` and the console rendered
   * "15 of 6 shown". The observation count lives on `CandidateExplanation.observations`, which is
   * where a reader asking "how many times was this person seen?" should look.
   */
  total: z.number().int().nonnegative().default(0),
});
export type CandidateTimeline = z.infer<typeof CandidateTimeline>;

/**
 * **The structured explanation** (Architect rec 4) — evidence, not prose.
 *
 * ⚠️ A sentence is unqueryable, untestable and untranslatable. "Person P was in Checkout Queue for
 * 94 s (threshold 60 s)" reads well and cannot answer *"show me every candidate where the observed
 * gap was more than a third of the duration"* — which is the question that finds a fragmenting
 * camera. So every number is a field, and `summary` is **rendered from these fields**, never typed
 * alongside them: one source of truth, and a summary that cannot drift from the evidence it claims
 * to summarise.
 */
export const CandidateExplanation = z.object({
  /** What fired it. `dwell` is the only value this milestone produces. */
  trigger: z.enum(['dwell', 'condition', 'window']),
  /** The subject the rule accumulated on, and which kind of id that is. */
  subjectKind: DwellGroupBy.optional(),
  identityId: z.string().optional(),
  /** The most recent track id under that identity. Differs from `identityId` after a re-link. */
  trackId: z.string().optional(),
  cameraId: z.string().optional(),
  zoneId: z.string().optional(),
  zoneName: z.string().optional(),
  /**
   * The zone's version at the moment the candidate was raised (Architect rec 2).
   *
   * ⚠️ This is what lets an incident from March still be read in September after somebody dragged the
   * polygon. Without it the detail page would draw today's zone over last spring's footage and be
   * wrong in a way that looks completely correct.
   */
  zoneVersion: z.number().int().min(1).optional(),
  /** What was measured against what was configured. */
  observedSeconds: z.number().nonnegative().optional(),
  thresholdSeconds: z.number().nonnegative().optional(),
  /**
   * **Entry time** — the first observation of this subject in this zone (Architect rec 4).
   *
   * ⚠️ First *observation*, not first *presence*. The subject may have been standing there before
   * the camera or the assignment noticed them; the platform can only report when it started counting.
   */
  firstObservedAt: IsoDateTime.optional(),
  /** The most recent observation. Together with `firstObservedAt` this spans `observedSeconds`. */
  lastObservedAt: IsoDateTime.optional(),
  /**
   * **Exit time** — when the subject was confirmed to have left (Architect rec 4).
   *
   * ⚠️ **`null` while the visit is still open, which is the case for almost every candidate.** A
   * candidate is raised *during* a loiter, not after it, so at the moment of raising nobody has left.
   * An exit is only ever known retrospectively, when a gap exceeds the rule's reset — and by then
   * this record has already been written.
   *
   * It would have been easy to set this to `lastObservedAt` and call it the exit. That would be a
   * fabricated fact on an evidence record: it would read as "they left at 14:32" when the truth is
   * "we last saw them at 14:32 and they may still be there". The field is declared so a future
   * visit-closed update has somewhere honest to write, and it is `null` until something actually
   * observes an exit.
   */
  exitAt: IsoDateTime.nullable().optional(),
  observations: z.number().int().nonnegative().optional(),
  /**
   * ⚠️ The two honesty fields. `trackFragments > 1` means the duration spans a link the platform
   * *inferred*; `longestGapSeconds` says how much of the window nothing was actually seen. Both are
   * carried on every candidate, because an operator deciding whether to act on a 94-second dwell
   * needs to know it was assembled from two fragments with a 19-second hole in it.
   */
  trackFragments: z.number().int().nonnegative().optional(),
  longestGapSeconds: z.number().nonnegative().optional(),
  /**
   * The **median** interval between observations (P-8 Phase 7 — added after the deployment).
   *
   * ⚠️ `longestGapSeconds` is meaningless without this, and shipping it alone would have been an
   * honesty field that lied. The events service collapses repeated detections of one subject into
   * one event per dedup bucket, so a *continuously present* person is observed about once per
   * bucket however fast the camera runs — and every incident reported a ten-second "unobserved gap"
   * that described nothing but the platform's own sampling. Read the two together: longest ≈
   * typical is regular sampling; longest ≫ typical is a real hole. `gapIsUnusual` is the shared
   * predicate, so no two surfaces can disagree about which it was.
   */
  typicalGapSeconds: z.number().nonnegative().nullable().optional(),
  /** Mean confidence over the contributing observations. `null` when none carried one (ADR-0039). */
  meanConfidence: z.number().min(0).max(1).nullable().optional(),
  /** Rendered from the fields above. Never authored independently — see the header. */
  summary: z.string().min(1).max(600),
});
export type CandidateExplanation = z.infer<typeof CandidateExplanation>;

/**
 * The `incident.candidate` payload — a rule match proposing an incident. Domain-neutral; the alert /
 * workflow engine (P1-8) promotes it to a raised incident. Carries provenance back to the rule + the
 * triggering event, and a `dedupKey` so repeat matches collapse (idempotent downstream).
 *
 * ⚠️ Everything added in P-8 Phase 7 is **optional**. A candidate raised by a stateless rule carries
 * none of it, and that is correct rather than incomplete: there is no identity to name, no duration
 * to report and no timeline to draw. Defaulting those to `''`, `0` and `[]` would make every simple
 * candidate look like a dwell candidate that had gone wrong.
 */
export const IncidentCandidate = z.object({
  id: Uuid,
  tenantId: TenantId,
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  ruleName: z.string(),
  severity: EventPriority,
  title: z.string(),
  category: EventCategory,
  triggeredBy: z.object({
    eventId: Uuid,
    eventType: EventType,
    cameraId: z.string().optional(),
    zoneId: z.string().optional(),
    occurredAt: IsoDateTime,
  }),
  /** How many matching events satisfied the (windowed) rule — 1 for a stateless rule. */
  matchedCount: z.number().int().min(1),
  correlationId: z.string().optional(),
  dedupKey: z.string(),
  at: IsoDateTime,

  // --- P-8 Phase 7 (all additive, all optional) -------------------------------------------------

  /** Lifecycle slot. Always `candidate` in this milestone — see `IncidentCandidateStatus`. */
  status: IncidentCandidateStatus.default('candidate'),
  /**
   * The subject, hoisted out of the explanation so it can be **indexed and filtered** without
   * unpacking a nested document. "Show me every candidate for this person today" is the first thing
   * an operator asks and it must not require a scan.
   */
  identityId: z.string().optional(),
  /** Observed dwell in seconds, hoisted for the same reason: it is the primary sort on a list. */
  durationSeconds: z.number().nonnegative().optional(),
  /** Structured evidence for why this exists (Architect rec 4). */
  explanation: CandidateExplanation.optional(),
  /** Ordered, bounded story of the subject's visit (Architect rec 5). */
  timeline: CandidateTimeline.optional(),
  /** Where the pixels are. References only — never bytes (Architect rec 4 of the main brief). */
  evidence: z.array(CandidateEvidenceRef).max(16).default([]),
  /** Mean detection confidence over the contributing observations. `null` when unmeasurable. */
  confidence: Confidence.nullable().optional(),
  /**
   * True when the rule was in **dry run**: everything was evaluated and nothing was raised.
   *
   * ⚠️ Present on a candidate that, by definition, was never published. It exists because the
   * dry-run *report* is built from the same function that builds a real candidate — one code path,
   * so what a dry run shows you is exactly what you would have got. A candidate carrying `true` must
   * never reach the incident promoter, and the engine's publish path is what guarantees that.
   */
  dryRun: z.boolean().default(false),
});
export type IncidentCandidate = z.infer<typeof IncidentCandidate>;

/** The `rule.matched` payload — a lightweight audit signal emitted on every match. */
export const RuleMatch = z.object({
  tenantId: TenantId,
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  ruleName: z.string(),
  eventId: Uuid,
  eventType: EventType,
  raisedIncident: z.boolean(),
  at: IsoDateTime,
});
export type RuleMatch = z.infer<typeof RuleMatch>;

/** Dry-run a rule against a sample event — no side effects, no state mutation. */
export const RuleDryRunInput = z.object({ event: EventEnvelope });
export type RuleDryRunInput = z.infer<typeof RuleDryRunInput>;

export const RuleDryRunResult = z.object({
  matched: z.boolean(),
  /** Step-by-step outcome for authoring feedback. Superseded by `explanation`; kept for consumers. */
  evaluation: z.object({
    prefilterPassed: z.boolean(),
    conditionPassed: z.boolean(),
    windowPassed: z.boolean(),
  }),
  /** The full trace: which stage decided, and which leaf failed with what value (P-4). */
  explanation: RuleExplanation.optional(),
  /** The candidate that WOULD be raised (never emitted during a dry-run). */
  candidate: IncidentCandidate.optional(),
});
export type RuleDryRunResult = z.infer<typeof RuleDryRunResult>;

// ---------------------------------------------------------------------------------------------
// P-4.1 — rule operations: identity, dependencies, budgets, statistics, audit, portability.
//
// Everything below is **diagnostic, operational or derived**. Nothing here is read while deciding
// whether a rule fires, and nothing here may become so: the moment a hash or a counter influences
// evaluation, the engine stops being a function of the rule and starts being a function of the node
// it happens to be running on.
// ---------------------------------------------------------------------------------------------

/**
 * A stable content fingerprint (P-4.1, Architect recs 1 + 14).
 *
 * Lower-case hex SHA-256 over a canonical serialisation, so the **same rule version produces the same
 * hash on every node, in every process, forever**. That is the entire value: two replicas can be
 * compared without comparing rules, a support conversation can name a version unambiguously, and a
 * deployment can be verified against what was signed off.
 */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lower-case sha256 hex');
export type ContentHash = z.infer<typeof ContentHash>;

/**
 * Immutable identity of a compiled rule version (Architect recs 1 + 14).
 *
 * **Derived, never stored.** A hash persisted next to the thing it describes can disagree with it —
 * after a migration, a partial write, a restore — and a fingerprint that can lie is worse than none.
 * Recomputing is a few microseconds at compile time, and the recomputation *is* the verification
 * ([Foundation Principle 2](../../../docs/project/FOUNDATION_PRINCIPLES.md): persist measurements,
 * derive conclusions).
 *
 * `compiledAt` is the one field that is not a function of the rule, and it is therefore excluded from
 * every hash — otherwise nothing would ever match anything.
 */
export const RuleCompilation = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  /** Bumped when the compiler's own output shape changes, so old hashes are not compared to new. */
  compilerVersion: SemVer,
  /** Bumped when evaluation semantics change — the same rule may then decide differently. */
  engineVersion: SemVer,
  /** Everything that affects evaluation: prefilter, condition, window, actions, severity, scope. */
  compiledHash: ContentHash,
  /** The authored scope and its resolved expansion. Changes when the estate under a node changes. */
  scopeHash: ContentHash,
  /** Every external reference the rule makes. Changes only when the rule points somewhere new. */
  dependencyHash: ContentHash,
  /** The validation verdict, excluding when it was taken. Equal hashes = the same verdict. */
  validationHash: ContentHash.optional(),
  /** When this compilation happened. Diagnostic only — never part of a hash, never compared. */
  compiledAt: IsoDateTime,
});
export type RuleCompilation = z.infer<typeof RuleCompilation>;

/**
 * One external thing a rule points at (Architect rec 2).
 *
 * Named by `kind` + `ref` so the answer to _"what breaks if I delete this zone?"_ is a lookup rather
 * than an inspection of every rule body. The kinds are the frozen `RuleReferenceKind` set, which is
 * why that set was declared ahead of the checks that use it.
 */
/**
 * Whether a dependency is actually there (P-4.2, Architect rec 4).
 *
 * `unknown` is the load-bearing value and the one an implementation is tempted to skip. When the
 * context that owns a referenced thing cannot be reached, the honest answer is not `resolved` — the
 * same rule as `RuleValidationReport.verified`, applied to a graph instead of a report.
 *
 * `deprecated` is **reserved**: nothing in the platform marks a location, camera or event type as
 * deprecated yet, so it is declared and never emitted. Declared now for the reason
 * `RuleReferenceKind` was — adding a value to a published enum is not purely additive for a strict
 * parser.
 */
export const DependencyStatus = z.enum([
  'resolved',
  'missing',
  'archived',
  'deprecated',
  'unknown',
]);
export type DependencyStatus = z.infer<typeof DependencyStatus>;

export const RuleDependency = z.object({
  kind: RuleReferenceKind,
  ref: z.string().min(1).max(200),
  /**
   * True when the rule names this directly (the author typed it), false when it was derived — a zone
   * covered because an ancestor was scoped is a real dependency, but deleting it is not the same
   * event as deleting something an author named.
   */
  direct: z.boolean().default(true),
  /**
   * Whether it is there (P-4.2). Absent when the graph was built without a health check — which is
   * the default, because building the graph is pure and checking it is not.
   */
  status: DependencyStatus.optional(),
});
export type RuleDependency = z.infer<typeof RuleDependency>;

/**
 * Everything one rule version depends on (Architect rec 2).
 *
 * Tenant-scoped, like every other rule read: a dependency graph that crossed tenants would be an
 * information leak wearing an operations hat.
 */
export const RuleDependencyGraph = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  dependencies: z.array(RuleDependency).default([]),
  /** The same value as `RuleCompilation.dependencyHash`, so the two are comparable in isolation. */
  dependencyHash: ContentHash,
  /**
   * True when every dependency carries a `status` (P-4.2). False means the graph is structural only —
   * which is a different thing from "everything resolved", and conflating them is how an upgrade
   * check reports all-clear because it never ran.
   */
  statusChecked: z.boolean().default(false),
});
export type RuleDependencyGraph = z.infer<typeof RuleDependencyGraph>;

/** Rules that depend on one thing — the answer to "is this safe to delete?" (Architect rec 2). */
export const RuleDependents = z.object({
  kind: RuleReferenceKind,
  ref: z.string().min(1),
  rules: z
    .array(
      z.object({
        ruleId: z.string().min(1),
        ruleName: z.string(),
        lifecycle: RuleLifecycleState,
        direct: z.boolean(),
      }),
    )
    .default([]),
});
export type RuleDependents = z.infer<typeof RuleDependents>;

/**
 * Deployment limits on a single rule (Architect rec 4).
 *
 * The engine evaluates every enabled rule against every event, so one pathological rule is not one
 * customer's problem — it is a tenant-wide latency change, and on a shared node a neighbour's. The
 * ceilings that matter are the ones with no natural bound: a condition tree is recursive, and
 * `RuleScope`'s array caps say nothing about how deep or how wide the predicate underneath is.
 *
 * Enforced at **validation**, so a rule that exceeds them cannot be activated. Never enforced during
 * evaluation: refusing to evaluate a rule that is already live would take a configuration problem and
 * turn it into a silent outage.
 */
export const RuleLimits = z.object({
  /** Total nodes in the condition tree — leaves and composites together. */
  maxConditionNodes: z.number().int().positive(),
  /** How deeply composites may nest. Bounds the interpreter's recursion. */
  maxConditionDepth: z.number().int().positive(),
  maxEventTypes: z.number().int().positive(),
  maxCategories: z.number().int().positive(),
  maxActions: z.number().int().positive(),
  maxScopeNodes: z.number().int().positive(),
  maxScopeCameras: z.number().int().positive(),
  /** How many zones one rule's scope may expand to. A whole-org scope on a big estate hits this. */
  maxResolvedZones: z.number().int().positive(),
  /** Camera groups one rule may name (P-8 Phase 7). Each is expanded at validation. */
  maxScopeGroups: z.number().int().positive(),
  /** Detection zones one rule may name (P-8 Phase 7). */
  maxScopeDetectionZones: z.number().int().positive(),
});
export type RuleLimits = z.infer<typeof RuleLimits>;

/**
 * The default deployment limits.
 *
 * Chosen to be **far above any rule a person would write by hand** and far below anything that could
 * hurt: 200 condition nodes is an unreadable rule, and 20 levels of nesting is one nobody has ever
 * needed. A limit that legitimate work runs into is a limit that gets raised in a hurry by whoever is
 * on call, so these are set where they only ever catch mistakes and generated input.
 */
export const DEFAULT_RULE_LIMITS: RuleLimits = {
  maxConditionNodes: 200,
  maxConditionDepth: 20,
  maxEventTypes: 100,
  maxCategories: 20,
  maxActions: 20,
  maxScopeNodes: 200,
  maxScopeCameras: 500,
  maxResolvedZones: 10_000,
  maxScopeGroups: 100,
  maxScopeDetectionZones: 500,
};

/** What a rule actually costs, measured (Architect rec 4). Compared against `RuleLimits`. */
export const RuleComplexity = z.object({
  conditionNodes: z.number().int().nonnegative(),
  conditionDepth: z.number().int().nonnegative(),
  eventTypes: z.number().int().nonnegative(),
  categories: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  scopeNodes: z.number().int().nonnegative(),
  scopeCameras: z.number().int().nonnegative(),
  resolvedZones: z.number().int().nonnegative(),
  /** P-8 Phase 7. Default `0` so a rule measured before these existed still parses as unchanged. */
  scopeGroups: z.number().int().nonnegative().default(0),
  scopeDetectionZones: z.number().int().nonnegative().default(0),
});
export type RuleComplexity = z.infer<typeof RuleComplexity>;

/**
 * Live statistics for one rule (Architect rec 3).
 *
 * **Per process, not per cluster.** A node knows what it evaluated; it does not know what its
 * neighbours evaluated, and pretending otherwise by summing across a load balancer would produce a
 * number that is wrong in a way nobody could detect. Cluster totals are what the Prometheus counters
 * are for; this is what an operator looks at when asking _is this rule doing anything?_ — a question
 * best answered by a node that can answer it honestly.
 *
 * Operational only. Nothing in evaluation reads these.
 */
export const RuleRuntimeStats = z.object({
  ruleId: z.string().min(1),
  ruleName: z.string(),
  ruleVersion: z.number().int().min(1),
  /** Times this rule was considered — including events its scope rejected. */
  evaluations: z.number().int().nonnegative(),
  /** Times its condition matched. */
  matches: z.number().int().nonnegative(),
  /** Times evaluating it threw. A non-zero value here is a defect, not a tuning signal. */
  failures: z.number().int().nonnegative(),
  lastEvaluatedAt: IsoDateTime.optional(),
  lastMatchedAt: IsoDateTime.optional(),
  /** Microseconds, over the evaluations that got past the scope check. */
  avgEvaluationMicros: z.number().nonnegative(),
  maxEvaluationMicros: z.number().nonnegative(),
});
export type RuleRuntimeStats = z.infer<typeof RuleRuntimeStats>;

/** Compiled-rule-set cache health for this process (Architect rec 8). */
export const RuleCacheStats = z.object({
  /** Tenants currently compiled on this node. */
  tenants: z.number().int().nonnegative(),
  /** Compiled rules held for the requesting tenant. */
  rules: z.number().int().nonnegative(),
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  /** Misses that arrived while a compilation was already in flight and were served by it. */
  coalesced: z.number().int().nonnegative(),
  compilations: z.number().int().nonnegative(),
  evictions: z.number().int().nonnegative(),
  /** Hits ÷ lookups. `0` when nothing has been looked up — never a fabricated `1`. */
  hitRatio: z.number().min(0).max(1),
  avgCompileMicros: z.number().nonnegative(),
  maxCompileMicros: z.number().nonnegative(),
  lastCompiledAt: IsoDateTime.optional(),
});
export type RuleCacheStats = z.infer<typeof RuleCacheStats>;

/** The operational picture for a tenant on one node (Architect recs 3 + 8). */
export const RuleStatsReport = z.object({
  tenantId: TenantId,
  /** Which node answered. Stats differ per node, so the answer must say which one it is. */
  node: z.string().min(1),
  /** How long this process has been collecting. Counters mean nothing without it. */
  uptimeSeconds: z.number().nonnegative(),
  cache: RuleCacheStats,
  rules: z.array(RuleRuntimeStats).default([]),
  at: IsoDateTime,
});
export type RuleStatsReport = z.infer<typeof RuleStatsReport>;

/**
 * What happened to a rule, in operational words (Architect rec 12).
 *
 * **Derived from the version history, not a second trail.** Every one of these is already implied by
 * the immutable `RuleVersionRecord`s: a version whose snapshot is enabled and whose predecessor was
 * not is an activation. Writing a parallel audit collection would create two records of one truth,
 * which eventually disagree — and this way the narrative works retroactively, on rules authored long
 * before anyone thought to record it.
 *
 * `rolled-back` is derived the same way: a version whose content hash equals an earlier version's is
 * a return to that version, which is what a rollback *is* regardless of which endpoint produced it.
 */
export const RuleAuditAction = z.enum([
  'created',
  'updated',
  'enabled',
  'disabled',
  'archived',
  'restored',
  'rolled-back',
  'deleted',
]);
export type RuleAuditAction = z.infer<typeof RuleAuditAction>;

export const RuleAuditEntry = z.object({
  ruleId: z.string().min(1),
  version: z.number().int().min(1),
  action: RuleAuditAction,
  /** One line naming what changed, for a timeline that reads without opening each version. */
  summary: z.string().min(1).max(400),
  /** Which top-level fields differ from the previous version. Empty for a lifecycle-only change. */
  changedFields: z.array(z.string()).default([]),
  /** For `rolled-back`: the earlier version whose content this one restored. */
  restoredFrom: z.number().int().min(1).optional(),
  actor: z.string().optional(),
  at: IsoDateTime,
  contentHash: ContentHash,
});
export type RuleAuditEntry = z.infer<typeof RuleAuditEntry>;

/** Restore an earlier version's content as a new version (Architect rec 7). History is never rewritten. */
export const RuleRollbackInput = z.object({
  /** The version to restore. Must exist in this rule's history. */
  version: z.number().int().min(1),
});
export type RuleRollbackInput = z.infer<typeof RuleRollbackInput>;

/**
 * Run a rule against events without side effects (Architect rec 9).
 *
 * Two variants, and the contract is frozen for both now so neither becomes a breaking change later:
 *
 * - `events` — a supplied batch. Implemented: it is a dry-run over a list, and there is no reason to
 *   stub something already achievable.
 * - `range` — replay over the events the platform actually stored. **Not implemented** (`501`): the
 *   event history belongs to another context, and reaching into it is a decision that deserves its
 *   own design rather than being smuggled in under a rule feature.
 */
export const RuleSimulationInput = z.object({
  events: z.array(EventEnvelope).max(1000).optional(),
  range: z.object({ from: IsoDateTime, to: IsoDateTime }).optional(),
});
export type RuleSimulationInput = z.infer<typeof RuleSimulationInput>;

export const RuleSimulationResult = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  evaluated: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  /** Per-event outcomes, in input order. Capped by the input's own limit. */
  outcomes: z
    .array(z.object({ eventId: Uuid, matched: z.boolean(), explanation: RuleExplanation }))
    .default([]),
  /**
   * How many times each stage was the one that rejected an event — where a rule that is not firing is
   * actually losing its events, which is the question a simulation is usually run to answer.
   */
  decidedBy: z.record(z.string(), z.number().int().nonnegative()).default({}),
  at: IsoDateTime,
});
export type RuleSimulationResult = z.infer<typeof RuleSimulationResult>;

/**
 * A portable set of rules (Architect recs 10 + 14).
 *
 * A package carries **authored content only** — no ids, no tenant, no resolved scope, no timestamps.
 * What it does carry is each rule's `dependencies`, because that is the part that does not travel: a
 * node id means one place in the tenant it came from and nothing at all in the tenant it lands in.
 * Naming the references explicitly turns a silent mis-import into a validation report.
 */
export const RulePackage = z.object({
  /** Format version of the package itself, so an old export stays readable. */
  packageVersion: SemVer,
  compilerVersion: SemVer,
  /**
   * The versions the package was produced against (P-4.2, Architect recs 5 + 11).
   *
   * Checked on import and **rejected on a major mismatch**. A package is a file that can arrive from
   * any vintage of the platform, and a rule silently reinterpreted by a newer engine is the worst
   * shape of failure available here: it imports cleanly, validates cleanly, and does something other
   * than what it did where it came from.
   */
  engineVersion: SemVer.optional(),
  /** The `Rule` contract shape this package was written against. */
  schemaVersion: SemVer.optional(),
  exportedAt: IsoDateTime,
  /** Where it came from — provenance for support, never used to authorise anything on import. */
  source: z.object({ tenantId: TenantId, node: z.string().optional() }),
  rules: z
    .array(
      z.object({
        /** The id in the source tenant. Kept for traceability; a fresh id is assigned on import. */
        sourceRuleId: z.string().min(1),
        sourceVersion: z.number().int().min(1),
        rule: CreateRuleInput,
        dependencies: z.array(RuleDependency).default([]),
        compiledHash: ContentHash,
        /** Diagnostic only (rec 5) — the same values `RuleCompilation` reports for this version. */
        scopeHash: ContentHash.optional(),
        dependencyHash: ContentHash.optional(),
      }),
    )
    .default([]),
});
export type RulePackage = z.infer<typeof RulePackage>;

/** How an import should treat a rule whose name already exists in the target tenant (P-4.2, rec 8). */
export const RuleImportConflictPolicy = z.enum(['skip', 'import-anyway']);
export type RuleImportConflictPolicy = z.infer<typeof RuleImportConflictPolicy>;

/**
 * Import a package (P-4.2, Architect rec 8).
 *
 * `onConflict` defaults to **skip**, so re-importing a package a second time does nothing rather than
 * silently doubling a tenant's rule set. Duplicating configuration is the kind of mistake that is
 * invisible until an operator wonders why every incident arrives twice.
 */
export const RuleImportInput = z.object({
  package: RulePackage,
  onConflict: RuleImportConflictPolicy.default('skip'),
});
export type RuleImportInput = z.infer<typeof RuleImportInput>;

/** What happened to one rule in an import (P-4.2). */
export const RuleImportOutcome = z.enum(['imported', 'skipped', 'rejected']);
export type RuleImportOutcome = z.infer<typeof RuleImportOutcome>;

/**
 * What an import did (Architect rec 10).
 *
 * Imported rules land as **drafts**, always. A package is a file, a file arrives from somewhere, and
 * activating rules that arrived from somewhere is how an estate starts alerting on a configuration
 * nobody in the room chose. The validation report comes back with each one so the operator can see
 * which references did not survive the journey before deciding.
 */
export const RuleImportResult = z.object({
  imported: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  /** Rules not imported because a rule of that name already exists here (P-4.2). */
  skipped: z.number().int().nonnegative().default(0),
  /**
   * Package-level problems that stopped anything from being imported (P-4.2, rec 11) — an
   * incompatible engine or schema version, most of all. Present and non-empty means nothing was
   * written.
   */
  incompatible: z.array(z.string()).default([]),
  results: z
    .array(
      z.object({
        sourceRuleId: z.string().min(1),
        /** Absent when the rule was rejected or skipped. */
        ruleId: z.string().optional(),
        /** True when the rule was created (always as a draft). */
        created: z.boolean(),
        /** What happened, in one word (P-4.2). */
        outcome: RuleImportOutcome.default('imported'),
        /** Why it was rejected, or what is wrong with what was created. */
        validation: RuleValidationReport.optional(),
        /** References the package named that do not resolve in this tenant (P-4.2). */
        unresolvedDependencies: z.array(RuleDependency).default([]),
        /** The existing rule this one conflicted with, when it was skipped. */
        conflictsWith: z.string().optional(),
        error: z.string().optional(),
      }),
    )
    .default([]),
  /** Counts an operator reads before opening anything: how much of this needs attention (P-4.2). */
  summary: z
    .object({
      withErrors: z.number().int().nonnegative(),
      withWarnings: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
    })
    .default({ withErrors: 0, withWarnings: 0, unverified: 0 }),
  at: IsoDateTime,
});
export type RuleImportResult = z.infer<typeof RuleImportResult>;

// ---------------------------------------------------------------------------------------------
// P-4.2 — the support surface: one artifact, one health verdict, one diff, one trend.
//
// Same rule as everything in P-4.1: derived, operational, and never read while deciding whether a
// rule fires. What P-4.2 adds is **composition** — the pieces existed and had to be gathered by hand
// from six endpoints, which is exactly the work nobody does at 2 a.m.
// ---------------------------------------------------------------------------------------------

/**
 * How much rule there is (P-4.2, Architect rec 3).
 *
 * Bands rather than a raw number, because the number is only meaningful against limits an operator
 * does not carry in their head. The classification is a **function of `RuleComplexity` and the
 * deployment's `RuleLimits`** — so it moves when the ceilings move, which is the honest behaviour: a
 * rule is complex relative to what the deployment allows, not in the abstract.
 */
export const RuleComplexityClass = z.enum(['simple', 'moderate', 'complex', 'very-complex']);
export type RuleComplexityClass = z.infer<typeof RuleComplexityClass>;

export const RuleComplexityReport = z.object({
  measured: RuleComplexity,
  class: RuleComplexityClass,
  /** 0–100, where 100 is at the deployment ceiling on its worst dimension. */
  utilization: z.number().min(0).max(100),
  /** Which dimensions put it in this band, worst first — what to simplify, if anything. */
  drivers: z
    .array(z.object({ dimension: z.string(), used: z.number(), limit: z.number() }))
    .default([]),
});
export type RuleComplexityReport = z.infer<typeof RuleComplexityReport>;

/**
 * Whether a rule is in good shape (P-4.2, Architect rec 2).
 *
 * **The score is never the answer on its own.** Every point deducted is listed as a finding with its
 * own deduction, so the number can be reconstructed from the reasons — a health score nobody can
 * take apart is a number people learn to ignore, and then a real problem hides behind a 78.
 *
 * `unknown` rather than a confident score when the checks could not run. A health verdict computed
 * from checks that did not run is the same mistake as `verified` — see `RuleValidationReport`.
 *
 * Operational metadata only. Nothing in evaluation reads it.
 */
export const RuleHealthStatus = z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']);
export type RuleHealthStatus = z.infer<typeof RuleHealthStatus>;

export const RuleHealthFinding = z.object({
  code: z.string().min(1).max(60),
  severity: RuleIssueSeverity,
  message: z.string().min(1).max(400),
  /** Points this finding removed from 100. Sums to `100 - score`. */
  deduction: z.number().int().min(0).max(100),
});
export type RuleHealthFinding = z.infer<typeof RuleHealthFinding>;

export const RuleHealth = z.object({
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  status: RuleHealthStatus,
  /** 0–100. Meaningless without `findings`, which is why they travel together. */
  score: z.number().int().min(0).max(100),
  findings: z.array(RuleHealthFinding).default([]),
  assessedAt: IsoDateTime,
});
export type RuleHealth = z.infer<typeof RuleHealth>;

/**
 * What changed between two versions of a rule (P-4.2, Architect rec 6).
 *
 * "Version changed" is not a review; this says which condition was added, which zone left the scope,
 * which action was swapped. Derived from the two immutable snapshots, so it works for any pair in the
 * history — including two versions from before this existed.
 */
export const RuleDiffArea = z.enum([
  'identity',
  'lifecycle',
  'prefilter',
  'condition',
  'window',
  'scope',
  'actions',
  'severity',
  'priority',
  /** P-8 Phase 7 — the dwell block, and the dry-run switch. */
  'dwell',
  'dry-run',
]);
export type RuleDiffArea = z.infer<typeof RuleDiffArea>;

export const RuleDiffChange = z.object({
  area: RuleDiffArea,
  kind: z.enum(['added', 'removed', 'changed']),
  /** A dotted path into the rule, precise enough to point at in an editor. */
  path: z.string().min(1).max(200),
  /** One line a reviewer can read without opening either version. */
  summary: z.string().min(1).max(400),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type RuleDiffChange = z.infer<typeof RuleDiffChange>;

export const RuleDiff = z.object({
  ruleId: z.string().min(1),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  /** True when nothing that affects evaluation differs — the content hashes are equal. */
  behaviourUnchanged: z.boolean(),
  changes: z.array(RuleDiffChange).default([]),
});
export type RuleDiff = z.infer<typeof RuleDiff>;

/**
 * One bucket of a rule's activity (P-4.2, Architect rec 7).
 *
 * ⚠️ **In-process, bounded, and lost on restart.** This is not a time-series database and must not be
 * used as one — it answers _"has this rule gone quiet since lunchtime?"_, which is a question about
 * one node over one shift. Capacity planning and anything spanning replicas comes from the Prometheus
 * pipeline, which stores history properly. Per-rule labels are deliberately not exported there:
 * cardinality is the reason, and a bounded ring here is the cheaper honest answer.
 */
export const RuleStatsBucket = z.object({
  /** Start of the bucket. */
  from: IsoDateTime,
  to: IsoDateTime,
  evaluations: z.number().int().nonnegative(),
  matches: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  avgEvaluationMicros: z.number().nonnegative(),
});
export type RuleStatsBucket = z.infer<typeof RuleStatsBucket>;

export const RuleStatsHistory = z.object({
  ruleId: z.string().min(1),
  /** How long each bucket covers. */
  bucketSeconds: z.number().int().positive(),
  /** Oldest first. At most `retainedBuckets` of them. */
  buckets: z.array(RuleStatsBucket).default([]),
  /** How far back this node can see. Shorter than expected means it restarted. */
  coversSeconds: z.number().nonnegative(),
});
export type RuleStatsHistory = z.infer<typeof RuleStatsHistory>;

/**
 * **The support artifact** (P-4.2, Architect recs 1 + 14).
 *
 * Everything about one rule, gathered once: what it is now, every version it has been, what it points
 * at, whether those things exist, how complex it is, how it is doing, and what this node has seen it
 * do. One download instead of six endpoints and a note-taking app.
 *
 * Immutable in the sense that matters: every part is either an immutable record (the versions) or a
 * pure function of one (everything else), so the same rule at the same version produces the same
 * package — apart from the runtime statistics and the timestamp, which are explicitly the parts that
 * describe *this node right now* and are labelled as such.
 *
 * **No explanation trace.** An explanation is per-event, and a rule has no event. The package carries
 * the condition *structure*; `POST /rules/:id/simulate` produces a trace when an event is supplied.
 * Including an invented one would be the most misleading thing this artifact could contain.
 */
export const RuleDiagnosticPackage = z.object({
  /** Bumped when the artifact's own shape changes, so an old download stays readable. */
  packageVersion: SemVer,
  ruleId: z.string().min(1),
  tenantId: TenantId,
  /** Which node produced it, and when. The runtime statistics below are that node's. */
  node: z.string().min(1),
  generatedAt: IsoDateTime,

  /** The rule as it stands. */
  rule: Rule,
  compilation: RuleCompilation,
  validation: RuleValidationReport,
  complexity: RuleComplexityReport,
  health: RuleHealth,
  dependencies: RuleDependencyGraph,
  /** Every version, newest first — the whole history, not a window (rec 14). */
  versions: z.array(RuleVersionRecord).default([]),
  audit: z.array(RuleAuditEntry).default([]),
  /** Absent when this node does not evaluate — never zeroes standing in for measurements. */
  runtime: RuleRuntimeStats.optional(),
  history: RuleStatsHistory.optional(),
  /** Absent when this node does not evaluate. */
  cache: RuleCacheStats.optional(),
});
export type RuleDiagnosticPackage = z.infer<typeof RuleDiagnosticPackage>;

/**
 * **The contract Incident Management consumes** (P-4.2, Architect recs 12 + 15).
 *
 * Frozen ahead of P-5 so that building the investigation workspace requires no change to the Rule
 * Designer. It is a *projection*, not a new store: every field is already reachable through an
 * existing route, and this exists so P-5 makes one call instead of five and depends on one shape
 * instead of five.
 *
 * ⚠️ **What is deliberately absent: an explanation for the incident.** Explanations are derived from
 * an event, and an incident candidate carries the triggering event's **id**, not the event. Producing
 * one means fetching from the Events context, which is a P-5 decision about how the workspace reaches
 * other contexts — not something the Rule Designer should reach across a boundary to fake. The
 * condition structure and the scope snapshot are here; the trace is a `simulate` call away once P-5
 * has the event.
 */
export const RuleIncidentContext = z.object({
  ruleId: z.string().min(1),
  /** The version the incident was raised by — **not** necessarily the current one. */
  ruleVersion: z.number().int().min(1),
  ruleName: z.string(),
  severity: EventPriority,
  lifecycle: RuleLifecycleState,
  /** True when the rule has been edited since this version raised the incident. */
  supersededByCurrentVersion: z.boolean(),

  /** What the rule looked like then — the immutable snapshot, not today's rule. */
  snapshot: Rule,
  /** The zones and cameras that version covered, as recorded on it. */
  scope: ResolvedRuleScope.optional(),
  /** The condition tree as authored. A per-event trace needs the event — see the note above. */
  condition: RuleCondition.optional(),

  compilation: RuleCompilation,
  dependencies: RuleDependencyGraph,
  validation: RuleValidationReport,
  audit: z.array(RuleAuditEntry).default([]),
  /** This node's counters for the rule, when it evaluates. */
  runtime: RuleRuntimeStats.optional(),
  at: IsoDateTime,
});
export type RuleIncidentContext = z.infer<typeof RuleIncidentContext>;

/**
 * One rule, reduced to what an operator scans a list for (P-4.2, Architect rec 13).
 *
 * The row behind diagnostic search: enough to decide which rule to open, and nothing more. Building
 * the full package for every rule in a tenant to render a list would be the obvious mistake.
 */
export const RuleDiagnosticRow = z.object({
  ruleId: z.string().min(1),
  ruleName: z.string(),
  ruleVersion: z.number().int().min(1),
  lifecycle: RuleLifecycleState,
  health: RuleHealthStatus,
  healthScore: z.number().int().min(0).max(100),
  complexity: RuleComplexityClass,
  /** Dependencies that are missing, archived or unknown. `0` with `statusChecked: false` means nothing was checked. */
  unresolvedDependencies: z.number().int().nonnegative(),
  statusChecked: z.boolean(),
  evaluations: z.number().int().nonnegative(),
  matches: z.number().int().nonnegative(),
  lastMatchedAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime,
});
export type RuleDiagnosticRow = z.infer<typeof RuleDiagnosticRow>;

/**
 * Filters for diagnostic search (P-4.2, Architect rec 13).
 *
 * Every filter is optional and they combine with AND. `kind` + `ref` together answer "show me
 * everything touching this zone", which is the enterprise question this exists for.
 */
export const RuleDiagnosticQuery = z.object({
  /** Restrict to rules depending on this kind of thing — requires `ref`. */
  kind: RuleReferenceKind.optional(),
  ref: z.string().min(1).max(200).optional(),
  lifecycle: RuleLifecycleState.optional(),
  health: RuleHealthStatus.optional(),
  complexity: RuleComplexityClass.optional(),
  /** Rules changed at or after this instant. */
  updatedSince: IsoDateTime.optional(),
  /** Free-text match on the rule name, case-insensitive. */
  name: z.string().min(1).max(200).optional(),
});
export type RuleDiagnosticQuery = z.infer<typeof RuleDiagnosticQuery>;

export const RuleDiagnosticSearchResult = z.object({
  rows: z.array(RuleDiagnosticRow).default([]),
  /** How many rules were considered, before filtering. */
  scanned: z.number().int().nonnegative(),
  /**
   * True when dependency status could be checked. False means `unresolvedDependencies` on every row
   * is `0` because nothing was looked at, not because everything resolves.
   */
  statusChecked: z.boolean(),
  at: IsoDateTime,
});
export type RuleDiagnosticSearchResult = z.infer<typeof RuleDiagnosticSearchResult>;

// ---------------------------------------------------------------------------------------------
// P-8 Phase 7 — Live Rule Status (§Operator UI; Architect recs 3 + 6).
//
// What the engine is doing **right now**, on the node you asked. Everything here is a live gauge or
// a rate, and every one of them obeys ADR-0039: a number that has not been measured is `null`, never
// `0`. Nothing in evaluation reads any of it.
// ---------------------------------------------------------------------------------------------

/**
 * One dwell clock that is currently running (Architect recs 3 + 6).
 *
 * ⚠️ **This is the loiter timer.** It is what the browser renders beside a live camera, and it is the
 * only place in the platform where an operator can watch a threshold approach rather than learn about
 * it afterwards. It exists for verification and demonstration, and it is read-only: nothing about a
 * rule's behaviour depends on anyone looking at it.
 */
export const LiveDwellTimer = z.object({
  ruleId: z.string().min(1),
  ruleName: z.string(),
  /** The subject key the visit is filed under — an identityId or a trackId. */
  subject: z.string().min(1),
  subjectKind: DwellGroupBy,
  cameraId: z.string().optional(),
  zoneId: z.string().optional(),
  zoneName: z.string().optional(),
  firstObservedAt: IsoDateTime,
  lastObservedAt: IsoDateTime,
  /** Observed duration so far. The number that grows on screen. */
  elapsedSeconds: z.number().nonnegative(),
  thresholdSeconds: z.number().nonnegative(),
  observations: z.number().int().nonnegative(),
  trackFragments: z.number().int().nonnegative(),
  longestGapSeconds: z.number().nonnegative(),
  /**
   * Where this visit stands.
   *
   * `accumulating` — below the threshold, clock running.
   * `met`          — at or past it; the next observation raises (or would, in dry run).
   * `cooling-down` — past it, but suppressed by the rule's cool-down.
   */
  state: z.enum(['accumulating', 'met', 'cooling-down']),
  cooldownRemainingSeconds: z.number().nonnegative().nullable(),
  /** True when the owning rule is in dry run — this timer will never raise anything. */
  dryRun: z.boolean(),
});
export type LiveDwellTimer = z.infer<typeof LiveDwellTimer>;

/**
 * The engine's live picture for one tenant on one node (Architect rec 3).
 *
 * ⚠️ **Per process, like `RuleStatsReport`, and for the same reason.** A node knows what it
 * evaluated; summing across a load balancer would produce a number that is wrong in a way nobody
 * could detect. `node` is carried so the answer says who gave it.
 */
export const LiveRuleStatus = z.object({
  tenantId: TenantId,
  node: z.string().min(1),
  /** How long this process has been collecting. Every rate below is meaningless without it. */
  uptimeSeconds: z.number().nonnegative(),

  /** Rules in `enabled` lifecycle for this tenant, as compiled on this node. */
  activeRules: z.number().int().nonnegative(),
  /** Of those, how many carry a dwell block. */
  dwellRules: z.number().int().nonnegative(),
  /** Of those, how many are in dry run — evaluating and deliberately raising nothing. */
  dryRunRules: z.number().int().nonnegative(),
  /**
   * Distinct detection zones named across this tenant's enabled rules.
   *
   * ⚠️ Zones a **rule** watches, not zones that **exist**. A tenant with forty zones and one rule
   * scoped to two reports 2 — which is the number that predicts evaluation cost and the number an
   * operator asking "what is being watched?" means.
   */
  activeZones: z.number().int().nonnegative(),

  /**
   * Rule evaluations per second, over this node's recent window.
   *
   * ⚠️ `null` until a window has elapsed. `0.0/s` and "nothing has been measured yet" look identical
   * and mean opposite things — the first is an idle estate, the second is a node that just started
   * (ADR-0039).
   */
  evaluationsPerSecond: z.number().nonnegative().nullable(),
  /** Incident candidates published per second. `null` before a window has elapsed. */
  candidatesPerSecond: z.number().nonnegative().nullable(),
  /** Events consumed per second. `null` before a window has elapsed. */
  eventsPerSecond: z.number().nonnegative().nullable(),

  /** Dwell clocks running right now. A live gauge, legitimately `0` on a quiet site. */
  activeDwellTimers: z.number().int().nonnegative(),
  /**
   * The running clocks themselves, newest-first by elapsed time, bounded.
   *
   * ⚠️ Bounded because a busy site could have hundreds and this is a status endpoint, not a data
   * feed. `activeDwellTimers` above is the true count; this is the sample a screen can render.
   */
  timers: z.array(LiveDwellTimer).max(50).default([]),

  /**
   * ⚠️ Dwell evaluations skipped because the event carried no identity.
   *
   * A non-zero value here means a dwell rule is receiving events it can never accumulate — the rule
   * looks enabled and healthy and will never fire. It is on the status page rather than only in
   * Prometheus because it is the one number that distinguishes "nothing is happening" from "this is
   * broken", and those are indistinguishable from every other field.
   */
  dwellWithoutIdentity: z.number().int().nonnegative(),
  /** Visits the dwell store is holding, and the ceiling before it evicts. */
  dwellStateEntries: z.number().int().nonnegative(),
  dwellStateCapacity: z.number().int().nonnegative(),
  /** ⚠️ Non-zero means a visit was silently forgotten and its rule will not fire for that subject. */
  dwellStateEvicted: z.number().int().nonnegative(),
  at: IsoDateTime,
});
export type LiveRuleStatus = z.infer<typeof LiveRuleStatus>;

/**
 * Is a dwell's longest gap **unusual**, or just this deployment's sampling interval?
 *
 * ⚠️ Exported from contracts so the rule engine's summary, the incident panel and the live view all
 * ask the same question of the same numbers. Three implementations of "was that gap suspicious?"
 * would disagree the first time any of them was tuned, and the disagreement would be invisible —
 * the summary would qualify a duration the panel presented as clean.
 *
 * Both halves are needed. A ratio alone flags a 0.2 s gap against a 0.1 s typical; an absolute alone
 * flags every incident on a deployment whose event dedup window is ten seconds, which is what the
 * first version of this did.
 */
export function gapIsUnusual(
  longestGapSeconds: number,
  typicalGapSeconds: number | null | undefined,
): boolean {
  if (longestGapSeconds < 2) return false;
  if (typicalGapSeconds === null || typicalGapSeconds === undefined || typicalGapSeconds <= 0) {
    return longestGapSeconds >= 2;
  }
  return longestGapSeconds > typicalGapSeconds * 2;
}
