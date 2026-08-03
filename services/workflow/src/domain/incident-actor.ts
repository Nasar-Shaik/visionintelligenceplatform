/**
 * Domain: **who did this** (P-5.1, finding F-2). Pure.
 *
 * Two jobs, and the second is the interesting one:
 *
 * 1. **Classify a new action** at the moment it happens, from what the caller actually is. A route
 *    knows whether it was reached by a human principal or by the promotion consumer, so the type is
 *    recorded rather than inferred later.
 * 2. **Read an old record honestly.** Every incident raised before P-5.1 carries a bare `by` string.
 *    `"priya"` is probably an operator and `"system"` is probably the platform — but *probably* is
 *    the whole problem. A reader cannot distinguish a person named system from the platform, and a
 *    timeline that confidently attributes a state change to "the platform" when a human made it is
 *    worse than one that says it does not know.
 *
 * So legacy strings resolve to `unknown`, always, with the original string preserved as `id`. This
 * is the same rule as `RuleValidationReport.verified` and `RuleHealthStatus.unknown`, one context
 * over: a classification that could not be made is not a classification that succeeded
 * (CONSTRAINTS §44, §52).
 */
import type { IncidentActorKind, IncidentActorRef } from '@vip/contracts';

/** The actor the promotion consumer records — the platform acting on a rule candidate. */
export const SYSTEM_ACTOR: IncidentActorRef = { kind: 'system', id: 'system' };

/** Build a typed actor for a human principal reaching a route through the gateway. */
export function operatorActor(principalId: string, displayName?: string): IncidentActorRef {
  const actor: IncidentActorRef = { kind: 'operator', id: principalId };
  if (displayName !== undefined && displayName !== '') actor.displayName = displayName;
  return actor;
}

/** Build a typed actor of an explicit kind — for the promoter, automations and integrations. */
export function actorOf(kind: IncidentActorKind, id: string): IncidentActorRef {
  return { kind, id };
}

/**
 * Resolve the actor for a record that may predate typing.
 *
 * ⚠️ **Never guesses.** When `actor` is absent the answer is `unknown`, carrying whatever string
 * the record had so an operator can still see it and decide for themselves. When there is no string
 * either, the id is the literal `'unknown'` — an unattributed action is a fact worth showing, not a
 * blank to hide.
 */
export function resolveActor(
  actor: IncidentActorRef | undefined,
  by: string | undefined,
): IncidentActorRef {
  if (actor) return actor;
  return { kind: 'unknown', id: by !== undefined && by !== '' ? by : 'unknown' };
}

/** Did a human do this? The question `by: string` could not answer, and the reason F-2 exists. */
export function isHuman(actor: IncidentActorRef): boolean {
  return actor.kind === 'operator';
}

/**
 * ⚠️ The AI boundary, asserted in the domain as well as in the permission catalog.
 *
 * An `ai-advisor` may appear beside a recommendation and nowhere else. The permission catalog is
 * the enforcement point — no role grants a machine principal a write permission — and this is the
 * belt to that braces: if an AI actor ever reaches a state-changing path, it fails here rather than
 * being written into an immutable audit trail.
 */
export function assertMayMutate(actor: IncidentActorRef): void {
  if (actor.kind === 'ai-advisor') {
    throw new Error(
      `an ai-advisor may not change incident state — recommendations only (actor: ${actor.id})`,
    );
  }
}
