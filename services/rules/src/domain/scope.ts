/**
 * Domain: **where a rule applies** (P-4).
 *
 * A rule is authored against the Location Hierarchy — "everything under the London site" — and
 * evaluated against a **pre-expanded set of leaf ids**. The expansion happens once, at validation;
 * this module only does the membership test.
 *
 * That split is the whole design. The engine sees every event in the tenant and evaluates every
 * enabled rule against it, so anything in this path that is not O(1) is a per-event cost multiplied
 * by rules multiplied by events. A hierarchy lookup here would be a query per rule per event
 * (Architect P-4 rec 12); a `path.includes()` here would require the event to carry an ancestry it
 * does not have. A `Set.has` is neither.
 *
 * Pure and total. No store, no clock, no hierarchy knowledge — this module could not query if it
 * wanted to.
 */
import type { EventEnvelope, ResolvedRuleScope, RuleScope } from '@vip/contracts';

const EMPTY_SCOPE: RuleScope = { nodeIds: [], cameraIds: [], groupIds: [], zoneIds: [] };

/**
 * A rule's authored scope, defaulted.
 *
 * A rule written before P-4 carries no `scope` at all, and a reader must default rather than assume
 * — that is what additive means in a **store** as opposed to in a schema
 * ([Foundation Principle 11](../../../../docs/project/FOUNDATION_PRINCIPLES.md)). Tenant-wide is the
 * right default because it is what those rules already did.
 */
export function scopeOf(rule: { scope?: RuleScope | undefined }): RuleScope {
  return rule.scope ?? EMPTY_SCOPE;
}

/**
 * An authored scope that names nothing applies everywhere in the tenant.
 *
 * ⚠️ Reads the arrays defensively (`?.length`) rather than trusting the type. A rule stored before
 * P-8 Phase 7 has no `groupIds` or `zoneIds` at all, and this function is called on documents that
 * came out of Mongo rather than through a parser — which is exactly the additive-in-a-store case
 * Foundation Principle 11 is about. `undefined.length` here would throw on every legacy rule, on the
 * per-event path, for every event.
 */
export function isTenantWide(scope: RuleScope | undefined): boolean {
  if (!scope) return true;
  return (
    (scope.nodeIds?.length ?? 0) === 0 &&
    (scope.cameraIds?.length ?? 0) === 0 &&
    (scope.groupIds?.length ?? 0) === 0 &&
    (scope.zoneIds?.length ?? 0) === 0
  );
}

/**
 * A resolved scope prepared for evaluation: sets instead of arrays.
 *
 * Built once when the rule set is compiled, not per event. For a rule covering forty zones this turns
 * forty comparisons into one hash lookup, and the difference is only visible at the scale where it
 * matters.
 */
export interface CompiledScope {
  readonly tenantWide: boolean;
  /**
   * **Location-hierarchy** zone ids, expanded from the authored nodes.
   *
   * ⚠️ Read the note on `detectionZoneIds`. Nothing in the platform has ever stamped a hierarchy id
   * onto an `EventEnvelope`, so this set has never matched a perception event — recorded as [L-55]
   * rather than quietly fixed here, because making it match is a change to what the *hierarchy* means
   * on the wire and belongs in its own milestone.
   */
  readonly zoneIds: ReadonlySet<string>;
  /**
   * **Detection** zone ids — polygons on a camera (P-8 Phase 7).
   *
   * ⚠️ A separate set from `zoneIds`, and this is the load-bearing part. From P-8 Phase 7 the
   * envelope's `zoneId` carries a *detection* zone, because that is the only zone the platform can
   * observe. Matching it against the hierarchy expansion would compare two unrelated id spaces: it
   * would silently match nothing today and, the day somebody wires the hierarchy up, silently match
   * something wrong. One word, two meanings, kept in two fields. See ADR-0044.
   */
  readonly detectionZoneIds: ReadonlySet<string>;
  readonly cameraIds: ReadonlySet<string>;
  /**
   * The rule names places but has no expansion — it has never been validated, or was re-scoped since.
   * Matches nothing, deliberately.
   */
  readonly unresolved: boolean;
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * Prepare a rule's scope for evaluation.
 *
 * The case worth care is a rule with an **authored scope but no expansion**. Treating that as
 * tenant-wide would make a rule scoped to one site fire across the whole estate — failing open, in
 * the direction of more alerts, silently, and against the one thing the customer explicitly
 * configured. So it matches **nothing** and says so.
 *
 * Both failure directions are bad; this one is at least visible. A rule that stops firing gets
 * noticed and its explanation names the cause, whereas a rule firing everywhere looks like the
 * product working. The activation gate resolves scope in the same version bump that enables a rule,
 * so this state should not occur in practice — it exists so that if it ever does, the blast radius
 * is one quiet rule rather than an estate-wide alert storm.
 */
export function compileScope(
  resolved: ResolvedRuleScope | undefined,
  authored?: RuleScope | undefined,
): CompiledScope {
  if (resolved) {
    if (resolved.tenantWide) {
      return {
        tenantWide: true,
        zoneIds: NOTHING,
        detectionZoneIds: NOTHING,
        cameraIds: NOTHING,
        unresolved: false,
      };
    }
    return {
      tenantWide: false,
      zoneIds: new Set(resolved.zoneIds ?? []),
      /* ⚠️ `?? []` — a rule resolved before P-8 Phase 7 has no `detectionZoneIds` field at all. */
      detectionZoneIds: new Set(resolved.detectionZoneIds ?? []),
      cameraIds: new Set(resolved.cameraIds ?? []),
      unresolved: false,
    };
  }

  if (isTenantWide(authored)) {
    return {
      tenantWide: true,
      zoneIds: NOTHING,
      detectionZoneIds: NOTHING,
      cameraIds: NOTHING,
      unresolved: false,
    };
  }
  return {
    tenantWide: false,
    zoneIds: NOTHING,
    detectionZoneIds: NOTHING,
    cameraIds: NOTHING,
    unresolved: true,
  };
}

/**
 * Does this event fall inside the rule's scope?
 *
 * A camera match wins on its own: a rule scoped to a specific camera covers that camera wherever it
 * physically sits, which is what an operator means when they name one.
 *
 * **An event with no location fails a narrowed scope.** A rule scoped to the London site must not
 * fire on an event that cannot say where it happened — treating "unknown" as "inside" is how a rule
 * for one site starts raising incidents for the whole estate, and it would fail silently, in the
 * direction of more alerts rather than fewer.
 */
export function matchesScope(scope: CompiledScope, envelope: EventEnvelope): boolean {
  if (scope.tenantWide) return true;
  /*
   * ⚠️ **Detection zone first, and it is the narrowing test that must win.** A rule scoped to one
   * camera AND one zone on it should fire only inside that zone; checking the camera first would
   * return true on every event from that camera and make the zone scope decorative. So when the rule
   * names detection zones at all, an event must be in one of them.
   */
  if (scope.detectionZoneIds.size > 0) {
    return envelope.zoneId !== undefined && scope.detectionZoneIds.has(envelope.zoneId);
  }
  if (envelope.cameraId && scope.cameraIds.has(envelope.cameraId)) return true;
  if (envelope.zoneId && scope.zoneIds.has(envelope.zoneId)) return true;
  return false;
}

/** Why the scope stage came out as it did, in words an operator can act on. */
export function explainScope(scope: CompiledScope, envelope: EventEnvelope): string {
  if (scope.unresolved) {
    return 'the rule names locations but has not been validated since — its scope is not resolved, so it matches nothing';
  }
  if (scope.tenantWide) return 'the rule applies tenant-wide';
  if (scope.detectionZoneIds.size > 0) {
    if (envelope.zoneId === undefined) {
      return `the rule watches ${scope.detectionZoneIds.size} detection zone(s), and this event was not inside any zone`;
    }
    return scope.detectionZoneIds.has(envelope.zoneId)
      ? `zone ${envelope.zoneId} is one of the ${scope.detectionZoneIds.size} the rule watches`
      : `zone ${envelope.zoneId} is not one of the ${scope.detectionZoneIds.size} the rule watches`;
  }
  if (envelope.cameraId && scope.cameraIds.has(envelope.cameraId)) {
    return `camera ${envelope.cameraId} is named in the rule's scope`;
  }
  if (envelope.zoneId && scope.zoneIds.has(envelope.zoneId)) {
    return `zone ${envelope.zoneId} is inside the rule's scope`;
  }
  if (!envelope.zoneId && !envelope.cameraId) {
    return 'the event carries no location, and the rule is scoped to specific places';
  }
  const where = envelope.zoneId ? `zone ${envelope.zoneId}` : `camera ${envelope.cameraId}`;
  return `${where} is outside the rule's scope (${scope.zoneIds.size} zone(s), ${scope.cameraIds.size} camera(s))`;
}
