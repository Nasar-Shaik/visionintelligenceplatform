/**
 * Types for `continuity.mjs`, so the regression suite in `tools/e2e` can hold the guard to its
 * contract. The implementation stays plain ESM because the validation tools run under bare `node`
 * with no build step.
 */

/** A stretch of wall-clock time during which the sampler produced nothing. */
export interface ContinuityGap {
  /** Timestamp of the last heartbeat before the gap. */
  afterAt: string;
  /** Timestamp of the first heartbeat after it. */
  untilAt: string;
  /** Gap length. Negative when the clock stepped backwards. */
  seconds: number;
}

/** The longest stretch the process was demonstrably awake for. */
export interface ContinuityWindow {
  fromIndex: number;
  toIndex: number;
  count: number;
  fromAt?: string;
  toAt?: string;
  seconds: number;
}

export interface Continuity {
  intervalMs: number;
  factor: number;
  thresholdSeconds: number;
  /** Samples carrying no parseable `at`. A sampler that stops dating its output is itself a fault. */
  undatedSamples: number;
  sampleCount: number;
  /** True when there were too few heartbeats to judge — never conflate with `intact`. */
  inconclusive: boolean;
  intact: boolean;
  totalSeconds: number;
  suspendedSeconds: number;
  suspensions: ContinuityGap[];
  backwardsSteps: ContinuityGap[];
  uninterrupted: ContinuityWindow;
}

export declare function analyseContinuity(input: {
  samples: readonly unknown[];
  intervalMs: number;
  factor?: number;
}): Continuity;

export declare function sliceUninterrupted<T>(input: {
  samples: readonly T[];
  intervalMs: number;
  factor?: number;
}): T[];

export declare function describeContinuity(c: Continuity): string;
