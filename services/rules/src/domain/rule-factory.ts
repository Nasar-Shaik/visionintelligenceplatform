/**
 * Domain: pure construction + versioning of rules (shared by the Mongo and in-memory stores). A
 * create yields version 1; every content change bumps the version and produces an immutable audit
 * snapshot (`RuleVersionRecord`). A change that touches ONLY the lifecycle is recorded as
 * `lifecycle-changed` (vs `updated`) so the audit trail distinguishes operational transitions from
 * content edits (P1-7 rec 3). No I/O here — the store persists what this returns.
 */
import type {
  CreateRuleInput,
  ResolvedRuleScope,
  Rule,
  RuleVersionRecord,
  UpdateRuleInput,
} from '@vip/contracts';

export interface FactoryDeps {
  now: () => Date;
  newId: () => string;
}

/** Build a fresh version-1 rule from validated input. */
export function newRule(
  tenantId: string,
  input: CreateRuleInput,
  deps: FactoryDeps,
  actor?: string,
): { rule: Rule; version: RuleVersionRecord } {
  const at = deps.now().toISOString();
  const rule: Rule = {
    id: deps.newId(),
    tenantId,
    name: input.name,
    lifecycle: input.lifecycle,
    priority: input.priority,
    version: 1,
    eventTypes: input.eventTypes,
    categories: input.categories,
    severity: input.severity,
    actions: input.actions,
    scope: input.scope,
    createdAt: at,
    updatedAt: at,
  };
  if (input.description !== undefined) rule.description = input.description;
  if (input.condition !== undefined) rule.condition = input.condition;
  if (input.window !== undefined) rule.window = input.window;
  if (actor !== undefined) rule.createdBy = actor;
  return { rule, version: versionRecord(rule, 'created', actor, at) };
}

/** Apply a partial update, bump the version, and produce the audit record. */
export function applyUpdate(
  existing: Rule,
  patch: UpdateRuleInput,
  deps: FactoryDeps,
  actor?: string,
  /**
   * The scope expansion computed for this update, when there is one.
   *
   * Applied **in the same version bump** as the content it belongs to, so the immutable snapshot
   * records the rule and the zones it covered together. Attaching it afterwards would leave a version
   * in the audit trail whose stored expansion belonged to a different edit.
   */
  resolution?: ResolvedRuleScope,
): { rule: Rule; version: RuleVersionRecord } {
  const at = deps.now().toISOString();
  const rule: Rule = { ...existing, version: existing.version + 1, updatedAt: at };
  if (patch.name !== undefined) rule.name = patch.name;
  if (patch.description !== undefined) rule.description = patch.description;
  if (patch.lifecycle !== undefined) rule.lifecycle = patch.lifecycle;
  if (patch.priority !== undefined) rule.priority = patch.priority;
  if (patch.eventTypes !== undefined) rule.eventTypes = patch.eventTypes;
  if (patch.categories !== undefined) rule.categories = patch.categories;
  if (patch.condition !== undefined) rule.condition = patch.condition;
  if (patch.window !== undefined) rule.window = patch.window;
  /*
   * Re-scoping invalidates the resolution: the stored expansion belongs to the *previous* scope, and
   * carrying it forward would leave the engine matching zones the author just removed. Dropped here
   * rather than recomputed, because expanding needs the hierarchy and this module is pure — the rule
   * simply becomes unresolved until it is validated again, which is also what blocks re-enabling it.
   */
  if (patch.scope !== undefined) {
    rule.scope = patch.scope;
    delete rule.resolvedScope;
  }
  if (resolution !== undefined) rule.resolvedScope = resolution;
  if (patch.severity !== undefined) rule.severity = patch.severity;
  if (patch.actions !== undefined) rule.actions = patch.actions;

  const onlyLifecycle = patch.lifecycle !== undefined && Object.keys(patch).length === 1;
  return {
    rule,
    version: versionRecord(rule, onlyLifecycle ? 'lifecycle-changed' : 'updated', actor, at),
  };
}

export function versionRecord(
  rule: Rule,
  changeKind: RuleVersionRecord['changeKind'],
  actor: string | undefined,
  changedAt: string,
): RuleVersionRecord {
  const record: RuleVersionRecord = {
    tenantId: rule.tenantId,
    ruleId: rule.id,
    version: rule.version,
    changeKind,
    changedAt,
    snapshot: rule,
  };
  if (actor !== undefined) record.changedBy = actor;
  return record;
}
