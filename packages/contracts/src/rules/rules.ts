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
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

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
  /** Step-by-step outcome for authoring feedback. */
  evaluation: z.object({
    prefilterPassed: z.boolean(),
    conditionPassed: z.boolean(),
    windowPassed: z.boolean(),
  }),
  /** The candidate that WOULD be raised (never emitted during a dry-run). */
  candidate: IncidentCandidate.optional(),
});
export type RuleDryRunResult = z.infer<typeof RuleDryRunResult>;
