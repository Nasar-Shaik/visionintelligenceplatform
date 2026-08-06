/**
 * Domain: **runtime placement** (P-8 Phase 6 §3, Architect rec 7) — which runtime a camera goes on.
 * Pure, deterministic, and the only implementation of the decision.
 *
 * ### ⚠️ Behind an interface, so a future scheduler needs no contract change (rec 7)
 *
 * The Architect asked explicitly for no auto-balancing and for the seam that makes it possible later.
 * `PlacementStrategy` is that seam: it takes the world (runtimes, current load, the capability
 * required) and returns a runtime or a refusal. `LeastLoadedPlacement` is the one implementation.
 * A future balancer replaces the strategy — it does not touch `CameraAssignment`, the plan, the
 * routes, or the enforcement point.
 *
 * ### ⚠️ The capacity endpoint and real placement run the SAME function
 *
 * "Suggested Placement" (rec 6) is produced by calling this with `dryRun` semantics — literally the
 * same code path, not a read-only reimplementation. Two implementations of one decision diverge the
 * first time either changes, and nobody notices, because both keep returning something plausible.
 *
 * ### Deterministic tie-breaking
 *
 * Least loaded first, then **runtime id**. Never insertion order, never a map iteration order: a
 * placement that depends on which document Mongo returned first is a placement that cannot be
 * reproduced from a bug report, and the benchmark ladder would show a different distribution on
 * every run for no reason anybody could name.
 */
import type { PlacementFailure } from '@vip/contracts';
import { advertises, placeable, type RuntimeDoc } from './runtime-registry.js';

/** One runtime's current occupancy, counted from the assignments rather than stored. */
export interface RuntimeLoad {
  runtimeId: string;
  assignedCameras: number;
}

export interface PlacementRequest {
  /** The capability the camera's profile requires. */
  capabilityId: string;
  /** Pin a runtime. When set, placement validates it instead of choosing. */
  pinnedRuntimeId?: string | undefined;
  /**
   * The runtime this camera currently sits on, if any.
   *
   * ⚠️ Load-bearing for **hot assignment** (rec 3): when the current runtime is still valid, it is
   * returned unchanged. A placement that reshuffled a running camera because another runtime happened
   * to be one camera lighter would restart processing for no operator-visible reason, which is
   * exactly what "healthy runtimes must never restart unnecessarily" forbids.
   */
  currentRuntimeId?: string | null | undefined;
}

export type PlacementResult =
  | { placed: true; runtimeId: string; moved: boolean }
  | { placed: false; failure: PlacementFailure };

export interface PlacementStrategy {
  place(
    request: PlacementRequest,
    runtimes: readonly RuntimeDoc[],
    load: ReadonlyMap<string, number>,
    now: Date,
  ): PlacementResult;
}

/** Free slots on a runtime, or `null` when it declares no capacity. */
export function remainingCapacity(doc: RuntimeDoc, used: number): number | null {
  if (doc.maxCameras === 0) return null;
  return doc.maxCameras - used;
}

/**
 * Least-loaded placement with capability matching and a stable tie-break.
 *
 * ⚠️ **Not a balancer.** It never moves a camera that is already validly placed, so the distribution
 * it produces depends on the order cameras were assigned, and that is correct for this milestone:
 * rebalancing a live estate is a scheduling decision with its own failure modes, and the Architect
 * explicitly deferred it.
 */
export class LeastLoadedPlacement implements PlacementStrategy {
  place(
    request: PlacementRequest,
    runtimes: readonly RuntimeDoc[],
    load: ReadonlyMap<string, number>,
    now: Date,
  ): PlacementResult {
    if (runtimes.length === 0) return { placed: false, failure: 'no-runtime-registered' };

    /* --- pinned: validate rather than choose ------------------------------------------------- */
    if (request.pinnedRuntimeId !== undefined) {
      const pinned = runtimes.find((r) => r._id === request.pinnedRuntimeId);
      if (pinned === undefined) return { placed: false, failure: 'runtime-not-found' };
      if (!pinned.enabled) return { placed: false, failure: 'runtime-disabled' };
      if (!placeable(pinned, now)) return { placed: false, failure: 'no-healthy-runtime' };
      if (!advertises(pinned, request.capabilityId)) {
        return { placed: false, failure: 'capability-unavailable' };
      }
      /*
       * ⚠️ The camera already on this runtime does not consume a slot it is about to re-occupy.
       * Without this, re-pinning a camera to the runtime it is already on fails once the runtime is
       * full — an operation that changes nothing would be refused for lack of room.
       */
      const used = (load.get(pinned._id) ?? 0) - (request.currentRuntimeId === pinned._id ? 1 : 0);
      const remaining = remainingCapacity(pinned, used);
      if (remaining !== null && remaining <= 0) {
        return { placed: false, failure: 'capacity-exceeded' };
      }
      return {
        placed: true,
        runtimeId: pinned._id,
        moved: request.currentRuntimeId !== pinned._id,
      };
    }

    /* --- hot assignment: keep a still-valid placement ----------------------------------------- */
    const current =
      request.currentRuntimeId == null
        ? undefined
        : runtimes.find((r) => r._id === request.currentRuntimeId);
    if (
      current !== undefined &&
      placeable(current, now) &&
      advertises(current, request.capabilityId)
    ) {
      const used = (load.get(current._id) ?? 0) - 1;
      const remaining = remainingCapacity(current, used);
      if (remaining === null || remaining > 0) {
        return { placed: true, runtimeId: current._id, moved: false };
      }
    }

    /* --- choose ------------------------------------------------------------------------------- */
    const eligible = runtimes.filter((r) => placeable(r, now));
    if (eligible.length === 0) {
      /* Distinguish "nothing is healthy" from "everything is switched off". */
      return {
        placed: false,
        failure: runtimes.some((r) => r.enabled) ? 'no-healthy-runtime' : 'runtime-disabled',
      };
    }
    const capable = eligible.filter((r) => advertises(r, request.capabilityId));
    if (capable.length === 0) return { placed: false, failure: 'capability-unavailable' };

    const withRoom = capable.filter((r) => {
      const remaining = remainingCapacity(r, load.get(r._id) ?? 0);
      return remaining === null || remaining > 0;
    });
    if (withRoom.length === 0) return { placed: false, failure: 'capacity-exceeded' };

    /* Least loaded, then id. ⚠️ Never map order — see the header. */
    const chosen = [...withRoom].sort((a, b) => {
      const la = load.get(a._id) ?? 0;
      const lb = load.get(b._id) ?? 0;
      return la === lb ? a._id.localeCompare(b._id) : la - lb;
    })[0] as RuntimeDoc;

    return {
      placed: true,
      runtimeId: chosen._id,
      moved: request.currentRuntimeId !== chosen._id,
    };
  }
}

/** Free slots across every placeable runtime, or `null` when none declares a capacity (§ rec 6). */
export function availableCapacity(
  runtimes: readonly RuntimeDoc[],
  load: ReadonlyMap<string, number>,
  now: Date,
): number | null {
  let total = 0;
  let declared = false;
  for (const runtime of runtimes) {
    if (!placeable(runtime, now)) continue;
    const remaining = remainingCapacity(runtime, load.get(runtime._id) ?? 0);
    if (remaining === null) continue;
    declared = true;
    total += Math.max(0, remaining);
  }
  /* ⚠️ `null`, not 0. "No headroom" and "nobody declared a capacity" are different answers. */
  return declared ? total : null;
}
