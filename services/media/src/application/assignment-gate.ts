/**
 * Application: the **assignment gate** — the enforcement point's decision function (P-8 Phase 6).
 * Pure, framework-free, deterministic. No clock, no network, no I/O.
 *
 * ### ⚠️ Where this sits, and why that placement is the milestone's central guarantee
 *
 * It is consulted from `FrameSink.push()`, which is **downstream of the decoder and downstream of the
 * segment writer**. Recording happens in `StreamSupervisor.#record`, reached from the decoder's
 * `onSegment` callback, and nothing on that path reads anything in this file. So "disabling AI never
 * interrupts recording" is not a behaviour that has to be preserved by care — it is a consequence of
 * the two paths not touching.
 *
 * ### ⚠️ Absence from the plan means RELEASE
 *
 * The plan carries only cameras that should be processed or held. Anything else is simply not in it,
 * and a camera the gate no longer sees is released. One rule instead of two means a lost plan entry
 * and a deliberate stop behave identically — and the failure mode of this system is therefore "AI
 * stopped", never "AI kept running on a camera nobody authorised".
 *
 * ### ⚠️ The session epoch, and the defect it exists to prevent
 *
 * P-8 Phase 5 measured a re-enabled camera publishing 0 events and dropping 32: a restarted stream
 * begins its frame sequence at 1, and a publisher still holding `lastSeq` from the previous session
 * treats every new frame as stale. `applyPlan` returns the cameras whose epoch changed, and the sink
 * releases their publisher and queue state before another frame is sent. Nothing depends on timing.
 */
import type {
  AssignmentPlan,
  AssignmentPlanEntry,
  CameraObservation,
  CameraObservationState,
} from '@vip/contracts';

/** What the gate says about one frame. */
export type GateDecision =
  | {
      /** Send it. */
      deliver: true;
      runtimeUrl: string;
      capabilityId: string;
      runtimeId: string;
      profileId: string;
    }
  | {
      deliver: false;
      /**
       * ⚠️ Why, in the vocabulary the counters use. `unassigned` and `held` are **policy**, not loss —
       * they are counted separately from a dropped frame, because a queue drop is a symptom and a
       * skipped frame is a decision somebody made.
       */
      reason: 'unassigned' | 'held';
    };

interface Held {
  entry: AssignmentPlanEntry;
  /** The epoch this camera's per-camera state belongs to. */
  epoch: number;
  /** Frames delivered since the last report — how `active` is distinguished from `idle`. */
  delivered: number;
  /** Set when the last delivery to this camera's runtime failed. */
  failedAt: number | null;
  lastError: string | null;
}

export interface ApplyPlanResult {
  /** Cameras whose per-camera state must be dropped before anything else happens. */
  release: { tenantId: string; cameraId: string }[];
  /** True when the plan differed from the one already held. */
  changed: boolean;
}

const KEY = (tenantId: string, cameraId: string): string => `${tenantId} ${cameraId}`;

export class AssignmentGate {
  readonly #held = new Map<string, Held>();
  #planVersion: number | null = null;
  /** Cameras released since the last report, so `stopping → stopped` can be confirmed. */
  #released = new Set<string>();
  /** Every runtime the control plane has registered — see `runtimes()`. */
  #declaredRuntimes: { runtimeId: string; url: string }[] = [];

  /**
   * Adopt a new plan and say what must be released.
   *
   * ⚠️ Deliberately returns the release list rather than performing it. The gate is pure; the sink
   * owns the queues and the publisher. A pure decision function that reached into a queue would be
   * untestable without one.
   */
  applyPlan(plan: AssignmentPlan): ApplyPlanResult {
    const release: { tenantId: string; cameraId: string }[] = [];
    const seen = new Set<string>();
    let changed = plan.version !== this.#planVersion;

    for (const entry of plan.entries) {
      const key = KEY(entry.tenantId, entry.cameraId);
      seen.add(key);
      const existing = this.#held.get(key);

      /*
       * ⚠️ `release` intent and a changed epoch are two different reasons to drop state, and both
       * have to be honoured. The first is an operator stopping a camera; the second is a camera being
       * restarted or moved to another runtime, where the previous session's ordering gate would
       * silently swallow every event from the new one.
       */
      if (entry.intent === 'release') {
        if (existing !== undefined) {
          release.push({ tenantId: entry.tenantId, cameraId: entry.cameraId });
          this.#held.delete(key);
          this.#released.add(key);
          changed = true;
        }
        continue;
      }

      if (existing === undefined) {
        this.#held.set(key, {
          entry,
          epoch: entry.sessionEpoch,
          delivered: 0,
          failedAt: null,
          lastError: null,
        });
        changed = true;
        continue;
      }

      if (existing.epoch !== entry.sessionEpoch) {
        release.push({ tenantId: entry.tenantId, cameraId: entry.cameraId });
        this.#released.add(key);
        existing.epoch = entry.sessionEpoch;
        existing.delivered = 0;
        changed = true;
      }
      if (
        existing.entry.capabilityId !== entry.capabilityId ||
        existing.entry.runtimeUrl !== entry.runtimeUrl ||
        existing.entry.intent !== entry.intent ||
        existing.entry.assignmentVersion !== entry.assignmentVersion
      ) {
        changed = true;
      }
      existing.entry = entry;
    }

    /* ⚠️ Absent from the plan ⇒ release. See the header. */
    for (const [key, held] of this.#held) {
      if (seen.has(key)) continue;
      release.push({ tenantId: held.entry.tenantId, cameraId: held.entry.cameraId });
      this.#held.delete(key);
      this.#released.add(key);
      changed = true;
    }

    this.#declaredRuntimes = plan.runtimes ?? [];
    this.#planVersion = plan.version;
    return { release, changed };
  }

  /** The decision for one frame. Called on the hot path — no allocation beyond the result. */
  decide(tenantId: string, cameraId: string): GateDecision {
    const held = this.#held.get(KEY(tenantId, cameraId));
    if (held === undefined) return { deliver: false, reason: 'unassigned' };
    /* mutation: intent ignored */
    return {
      deliver: true,
      runtimeUrl: held.entry.runtimeUrl,
      capabilityId: held.entry.capabilityId,
      runtimeId: held.entry.runtimeId,
      profileId: held.entry.profileId,
    };
  }

  /** Record a successful delivery, so the next report can distinguish `active` from `idle`. */
  delivered(tenantId: string, cameraId: string): void {
    const held = this.#held.get(KEY(tenantId, cameraId));
    if (held !== undefined) held.delivered += 1;
  }

  /** Record a failed delivery. `at` is passed in so the gate stays clock-free. */
  failed(tenantId: string, cameraId: string, error: string, at: number): void {
    const held = this.#held.get(KEY(tenantId, cameraId));
    if (held === undefined) return;
    held.failedAt = at;
    held.lastError = error;
  }

  /**
   * What the health poller must probe.
   *
   * ⚠️ **Every registered runtime the plan declares**, not only the ones with cameras on them. The
   * first version derived this from the plan's entries, so a runtime with no cameras was never
   * measured — and since placement uses runtime health and profile support comes from the
   * capabilities a runtime advertises, a deployment with no assignments could never make its first
   * one on anything but a guess. The deployment showed it; no unit test could, because they all
   * assign a camera first.
   *
   * The entries are still folded in, so a plan from an older control plane (no `runtimes` field)
   * degrades to the previous behaviour rather than probing nothing at all.
   */
  runtimes(): { runtimeId: string; url: string }[] {
    const byId = new Map<string, string>();
    for (const runtime of this.#declaredRuntimes) byId.set(runtime.runtimeId, runtime.url);
    for (const held of this.#held.values()) {
      byId.set(held.entry.runtimeId, held.entry.runtimeUrl);
    }
    return [...byId].map(([runtimeId, url]) => ({ runtimeId, url }));
  }

  /** The plan version currently applied. `null` before the first plan lands. */
  get planVersion(): number | null {
    return this.#planVersion;
  }

  get size(): number {
    return this.#held.size;
  }

  /** The current entry for a camera, for the per-camera metrics view. */
  entry(tenantId: string, cameraId: string): AssignmentPlanEntry | undefined {
    return this.#held.get(KEY(tenantId, cameraId))?.entry;
  }

  /**
   * Build the observation report body and reset the window.
   *
   * ⚠️ `idle` is reported — not omitted — for a camera that is in the plan and has delivered nothing.
   * That is the case where the *stream* is down rather than the assignment, and it is the one the
   * control plane must not mistake for a processing failure: `actionForObservation('idle')` returns
   * null, so it moves no state machine.
   */
  observations(now: number, failureWindowMs = 30_000): CameraObservation[] {
    const out: CameraObservation[] = [];
    for (const key of this.#released) {
      const [tenantId = '', cameraId = ''] = key.split(' ');
      out.push({ tenantId, cameraId, state: 'released', runtimeId: null });
    }
    this.#released.clear();

    for (const held of this.#held.values()) {
      const { tenantId, cameraId, runtimeId } = held.entry;
      let state: CameraObservationState;
      if (held.failedAt !== null && now - held.failedAt < failureWindowMs) state = 'failed';
      else if (held.entry.intent === 'hold') state = 'paused';
      else if (held.delivered > 0) state = 'active';
      else state = 'idle';
      out.push({
        tenantId,
        cameraId,
        state,
        runtimeId,
        ...(state === 'failed' && held.lastError !== null ? { detail: held.lastError } : {}),
      });
      held.delivered = 0;
    }
    return out;
  }
}
