/**
 * Domain: the **licensing extension point** (P-8 Phase 6, Architect rec 3). Pure.
 *
 * ### ⚠️ No licensing is implemented here, and none should be inferred
 *
 * The Architect asked for the seam and explicitly not the feature. This is the seam: a single pure
 * check, called on the enable path today, that answers *"allowed — no limit configured"* on every
 * deployment. When a licensing subsystem exists it supplies the numbers and **nothing else changes** —
 * not the contract, not the routes, not the enforcement point.
 *
 * ### ⚠️ `null` means "no limit", and it has to
 *
 * A limits object that defaulted to `0` would switch every deployment's AI off the moment the check
 * was wired in — a feature nobody enabled, taking effect through a default. So `null` is the only
 * value the platform ships, and `checkAssignmentLimits` treats it as unlimited rather than as
 * unset-and-therefore-suspicious.
 *
 * The check is called even though it can only pass. A seam that is never executed is a seam that has
 * never been tested, and the first deployment with a real limit would be the first execution.
 */
import type { AssignmentLimits } from '@vip/contracts';
import { NO_ASSIGNMENT_LIMITS } from '@vip/contracts';

export type LimitedResource = 'ai-cameras' | 'active-runtimes' | 'processing-profiles';

export type LimitDecision =
  | { allowed: true; limit: number | null }
  | { allowed: false; limit: number; resource: LimitedResource; message: string };

const FIELD: Record<LimitedResource, keyof AssignmentLimits> = {
  'ai-cameras': 'maxAiCameras',
  'active-runtimes': 'maxActiveRuntimes',
  'processing-profiles': 'maxProcessingProfiles',
};

const NOUN: Record<LimitedResource, string> = {
  'ai-cameras': 'AI-enabled cameras',
  'active-runtimes': 'active runtimes',
  'processing-profiles': 'processing profiles',
};

/**
 * Would adding `adding` more of `resource` exceed the configured ceiling?
 *
 * `current` is the count **before** the operation. Returns `allowed: true` with `limit: null` when
 * nothing is configured — which is every deployment today.
 */
export function checkAssignmentLimits(
  resource: LimitedResource,
  current: number,
  adding: number,
  limits: AssignmentLimits = NO_ASSIGNMENT_LIMITS,
): LimitDecision {
  const limit = limits[FIELD[resource]];
  if (limit === null) return { allowed: true, limit: null };
  if (current + adding <= limit) return { allowed: true, limit };
  return {
    allowed: false,
    limit,
    resource,
    message: `licence permits ${limit} ${NOUN[resource]}; this would make ${current + adding}`,
  };
}
