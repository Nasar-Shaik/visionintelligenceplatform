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
import { EventType, IsoDateTime, TenantId, Uuid } from '../common/primitives.js';
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
