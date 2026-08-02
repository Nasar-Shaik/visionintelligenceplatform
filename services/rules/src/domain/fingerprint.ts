/**
 * Domain: **stable identity for a rule version** (P-4.1, Architect recs 1 + 14).
 *
 * The question this answers is not interesting until the day it is the only question: _is the rule
 * running on that node the rule we signed off?_ Comparing rule bodies across replicas, environments
 * and a support ticket is not something anyone does reliably; comparing sixty-four characters is.
 *
 * Three properties, and each one is load-bearing:
 *
 * - **Deterministic.** The same rule version hashes identically in every process, forever. That means
 *   canonical serialisation — object keys sorted, `undefined` dropped rather than serialised — and it
 *   means no clock, no id generator, no environment.
 * - **Derived, never stored.** A hash persisted beside the thing it describes can end up disagreeing
 *   with it after a migration or a restore, and a fingerprint that can lie is worse than none. It is
 *   recomputed on demand, and the recomputation is itself the verification.
 * - **Inert.** Nothing in evaluation reads a hash. The moment one did, the engine would stop being a
 *   function of the rule.
 */
import { createHash } from 'node:crypto';
import type { Rule, RuleValidationReport } from '@vip/contracts';
import type { RuleDependency } from '@vip/contracts';
import { scopeOf } from './scope.js';

/**
 * Bumped when **what goes into a hash** changes, so hashes from two compiler generations are never
 * mistaken for a difference in the rules themselves. A support engineer comparing `a1b2…` to `c3d4…`
 * needs to know whether they are looking at a changed rule or a changed compiler.
 */
export const COMPILER_VERSION = '1.0.0';

/**
 * Bumped when **evaluation semantics** change — a new operator, a changed matching rule. Distinct
 * from the compiler version on purpose: the same rule text can decide differently under a new engine,
 * and that is exactly the case an incident from six months ago has to be interpretable against.
 */
export const ENGINE_VERSION = '1.0.0';

/**
 * Canonical JSON: object keys sorted, `undefined` omitted, arrays left in their authored order.
 *
 * Array order is preserved rather than sorted because for a condition tree it is meaningful, and a
 * canonicaliser that treats `all: [a, b]` and `all: [b, a]` as one value while the interpreter walks
 * them in order would be quietly lying about the thing it exists to identify. Where order genuinely
 * carries no meaning — the dependency set — the caller sorts before hashing, deliberately and once.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 over the canonical form, lower-case hex. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Everything that determines **how** a rule fires.
 *
 * Deliberately **excludes** `name`, `description`, `createdAt`, `updatedAt`, `version` and `createdBy`.
 * Renaming a rule does not change what it does, and a fingerprint that moves when the label moves
 * cannot answer "did the behaviour change?" — which is the only reason anyone asks.
 *
 * It also excludes **`lifecycle`**, which is the less obvious call and the more important one.
 * Lifecycle is operational state, not content: a rule paused overnight and resumed in the morning is
 * the same rule, and folding the two together makes both questions unanswerable — you could no longer
 * ask "was this edited?" without a pause looking like an edit, nor recognise a genuine rollback,
 * because disable-then-enable would restore an earlier hash while changing nothing at all.
 */
export function contentHash(rule: Rule): string {
  return hashOf({
    priority: rule.priority,
    eventTypes: rule.eventTypes,
    categories: rule.categories,
    condition: rule.condition ?? null,
    window: rule.window ?? null,
    severity: rule.severity,
    actions: rule.actions,
    scope: scopeOf(rule),
  });
}

/**
 * The authored scope together with the expansion in force.
 *
 * `resolvedAt` is excluded: re-validating an unchanged rule against an unchanged estate must produce
 * the same scope hash, or the field is only good for detecting that time passed.
 */
export function scopeHash(rule: Rule): string {
  const resolved = rule.resolvedScope;
  return hashOf({
    authored: scopeOf(rule),
    resolved: resolved
      ? {
          tenantWide: resolved.tenantWide,
          zoneIds: [...resolved.zoneIds].sort(),
          cameraIds: [...resolved.cameraIds].sort(),
        }
      : null,
  });
}

/** The dependency set, order-independent — a set has no order and the hash must not invent one. */
export function dependencyHash(dependencies: readonly RuleDependency[]): string {
  const sorted = [...dependencies].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref),
  );
  return hashOf(sorted.map((d) => ({ kind: d.kind, ref: d.ref, direct: d.direct })));
}

/**
 * The validation **verdict**, excluding when it was taken.
 *
 * Two reports with the same hash say the same thing about the same rule, which is what makes "has
 * anything changed since the last check?" a comparison rather than a re-reading. `checkedAt` would
 * make every report unique and the hash useless.
 */
export function validationHash(report: RuleValidationReport): string {
  return hashOf({
    valid: report.valid,
    verified: report.verified,
    checked: [...report.checked].sort(),
    issues: [...report.issues]
      .map((i) => ({ code: i.code, severity: i.severity, kind: i.kind, ref: i.ref ?? null }))
      .sort((a, b) => a.code.localeCompare(b.code) || (a.ref ?? '').localeCompare(b.ref ?? '')),
  });
}
