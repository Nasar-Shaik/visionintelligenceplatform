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
import { EventType, IsoDateTime, SemVer, TenantId, Uuid } from '../common/primitives.js';
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
  /** Every zone id the scope covers, expanded from the authored nodes. Empty = tenant-wide. */
  zoneIds: z.array(z.string().min(1)).default([]),
  /** Camera ids the scope covers directly. */
  cameraIds: z.array(z.string().min(1)).default([]),
  /** True when the authored scope was empty — the rule applies everywhere in the tenant. */
  tenantWide: z.boolean().default(true),
  /** When the expansion was computed. A hierarchy change after this is not reflected. */
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
  /** Fast pre-filter by event type (empty = any type). */
  eventTypes: z.array(EventType).default([]),
  /** Fast pre-filter by category (empty = any category). */
  categories: z.array(EventCategory).default([]),
  /** Detailed predicate over the envelope (absent = always true given the pre-filter). */
  condition: RuleCondition.optional(),
  /** Optional windowed threshold (stateful). */
  window: RuleWindow.optional(),
  /** Severity carried onto the incident candidate. */
  severity: EventPriority.default('medium'),
  actions: z.array(RuleAction).min(1),
  /** Where this rule applies (P-4). Absent/empty = tenant-wide. */
  scope: RuleScope.default({ nodeIds: [], cameraIds: [] }),
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
  severity: EventPriority.default('medium'),
  actions: z.array(RuleAction).min(1),
  scope: RuleScope.default({ nodeIds: [], cameraIds: [] }),
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

/** The stages of evaluation, in the order the engine applies them. */
export const RuleStage = z.enum(['lifecycle', 'scope', 'prefilter', 'condition', 'window']);
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
  decidedBy: z.enum(['lifecycle', 'scope', 'prefilter', 'condition', 'window', 'matched']),
  /** One line an operator can read without knowing the rule's internals. */
  summary: z.string().min(1).max(400),
  stages: z.object({
    lifecyclePassed: z.boolean(),
    scopePassed: z.boolean(),
    prefilterPassed: z.boolean(),
    conditionPassed: z.boolean(),
    windowPassed: z.boolean(),
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

/**
 * The `incident.candidate` payload — a rule match proposing an incident. Domain-neutral; the alert /
 * workflow engine (P1-8) promotes it to a raised incident. Carries provenance back to the rule + the
 * triggering event, and a `dedupKey` so repeat matches collapse (idempotent downstream).
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
export const RuleDependency = z.object({
  kind: RuleReferenceKind,
  ref: z.string().min(1).max(200),
  /**
   * True when the rule names this directly (the author typed it), false when it was derived — a zone
   * covered because an ancestor was scoped is a real dependency, but deleting it is not the same
   * event as deleting something an author named.
   */
  direct: z.boolean().default(true),
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
      }),
    )
    .default([]),
});
export type RulePackage = z.infer<typeof RulePackage>;

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
  results: z
    .array(
      z.object({
        sourceRuleId: z.string().min(1),
        /** Absent when the rule was rejected. */
        ruleId: z.string().optional(),
        /** True when the rule was created (always as a draft). */
        created: z.boolean(),
        /** Why it was rejected, or what is wrong with what was created. */
        validation: RuleValidationReport.optional(),
        error: z.string().optional(),
      }),
    )
    .default([]),
  at: IsoDateTime,
});
export type RuleImportResult = z.infer<typeof RuleImportResult>;
