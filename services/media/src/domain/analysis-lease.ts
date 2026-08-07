/**
 * Domain: the worker lease (P-8 Phase 8, slice 2). Pure decisions about who may hold a session.
 *
 * ⭐ **The lease is what makes "at most one worker per session" true — not the claim check.** Slice 1
 * learned this the expensive way: deciding a session's sequence with a read-then-write let two
 * simultaneous starts both claim run 1, and only a unique index actually stopped it. Claiming has
 * exactly the same shape, so the store performs a **conditional write** against the state and the
 * lease, and everything here is the pure part of that decision.
 */
import { ANALYSIS_LIMITS, type AnalysisLease, type AnalysisSessionState } from '@vip/contracts';

/** Sessions a worker may take: never started, or backing off after a transient failure. */
const CLAIMABLE: readonly AnalysisSessionState[] = ['queued', 'retrying'];

/** Sessions a worker is holding — the ones whose lease must be watched. */
const LEASED: readonly AnalysisSessionState[] = ['starting', 'running', 'paused'];

export function isClaimable(
  state: AnalysisSessionState,
  lease: AnalysisLease | undefined,
  now: Date,
): boolean {
  if (CLAIMABLE.includes(state)) return true;
  /*
   * ⚠️ A leased session becomes claimable only once its lease has genuinely lapsed. Reclaiming a
   * live worker's session runs the analysis twice — two workers pushing the same footage through
   * the same camera's tracker, producing duplicate identities and duplicate incidents.
   */
  return (
    LEASED.includes(state) && lease !== undefined && Date.parse(lease.expiresAt) <= now.getTime()
  );
}

/** Whether a worker still holds this session, from the record alone. */
export function leaseHeld(lease: AnalysisLease | undefined, workerId: string, now: Date): boolean {
  return (
    lease !== undefined &&
    lease.workerId === workerId &&
    Date.parse(lease.expiresAt) > now.getTime()
  );
}

/** A fresh lease for `workerId`, starting or renewing at `now`. */
export function grantLease(workerId: string, attempt: number, now: Date): AnalysisLease {
  return {
    workerId,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ANALYSIS_LIMITS.leaseSeconds * 1000).toISOString(),
    attempt,
  };
}

export function renewLease(lease: AnalysisLease, now: Date): AnalysisLease {
  return {
    ...lease,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ANALYSIS_LIMITS.leaseSeconds * 1000).toISOString(),
  };
}

/**
 * ⭐ **What happens to a session whose worker vanished**, and the distinction is not cosmetic.
 *
 * `failed` means the platform tried and reached a conclusion. `expired` means nobody can account for
 * what happened — the process died, the host went away, the container was rescheduled. Reporting the
 * second as the first would attribute a hosting event to the customer's recording.
 *
 * ⚠️ It becomes `retrying` while attempts remain, so an ordinary deploy during a long analysis costs
 * a chunk rather than the run; and `expired` once they are exhausted, because a session that has
 * lost three workers is not a session with a transient problem.
 */
export function stateAfterLeaseLapse(
  attempt: number,
  maxAttempts: number = ANALYSIS_LIMITS.maxAttempts,
): { state: AnalysisSessionState; reason: string } {
  if (attempt < maxAttempts) {
    return {
      state: 'retrying',
      reason: `the worker holding this run stopped responding (attempt ${String(attempt)} of ${String(maxAttempts)}); it will be picked up again from its last checkpoint`,
    };
  }
  return {
    state: 'expired',
    reason: `the worker holding this run stopped responding on every one of ${String(maxAttempts)} attempts — the platform cannot say what happened to it, which is why this is not recorded as a failed analysis`,
  };
}

/**
 * Whether a transient failure should be retried.
 *
 * ⛔ Bounded on purpose. An unbounded retry against a recording that cannot be decoded is a worker
 * that never does anything else, and from the outside it is indistinguishable from a busy queue.
 */
export function stateAfterFailure(
  attempt: number,
  transient: boolean,
  maxAttempts: number = ANALYSIS_LIMITS.maxAttempts,
): AnalysisSessionState {
  if (!transient) return 'failed';
  return attempt < maxAttempts ? 'retrying' : 'failed';
}
