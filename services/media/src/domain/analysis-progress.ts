/**
 * Domain: progress, throughput and the estimate that refuses to be invented (P-8 Phase 8, slice 2).
 *
 * Pure and total. Every number an operator watches for twenty minutes is computed here, so each one
 * can be driven from values in a test rather than observed in a deployment and hoped about.
 */
import { ANALYSIS_LIMITS, type AnalysisProgress } from '@vip/contracts';

/**
 * ⚠️ **Below this many samples an ETA is a guess wearing a number's clothes.**
 *
 * The first chunk of any analysis is unrepresentative — the runtime is cold, the model may be
 * warming, the object store's first range request is the slowest one. An ETA computed from it is
 * confidently wrong in the direction that matters, because an operator plans around it.
 */
const MIN_SAMPLES_FOR_ETA = 2;

export interface ProgressInput {
  /** Footage offset reached. */
  offsetSeconds: number;
  /** Total footage length, when the container declared one. */
  durationSeconds?: number;
  framesProcessed: number;
  /** Wall-clock milliseconds this session has actually spent decoding, across attempts. */
  elapsedMs: number;
  /** Chunks completed. The sample count the ETA gate reads. */
  chunksCompleted: number;
  now: Date;
}

/**
 * Build the progress record.
 *
 * ⭐ The three refusals here are the point of the function:
 *
 * - **`throughputFps` is `null`, not `0`, before any work** — `0` reads as "stalled", and an
 *   operator who sees it on a healthy queued session reports a fault that does not exist.
 * - **`speedFactor` is `null` before any elapsed time**, for the same reason and because dividing by
 *   zero produces `Infinity`, which serialises as `null` anyway but by accident rather than on
 *   purpose.
 * - **`etaSeconds` is `null` with a stated reason** until there are enough samples *and* a known
 *   duration ([ADR-0039]). Absent is not zero, and "we do not know yet" is a real answer.
 */
export function computeProgress(input: ProgressInput): AnalysisProgress {
  const elapsedSeconds = input.elapsedMs / 1000;
  const hasElapsed = elapsedSeconds > 0;

  const throughputFps = hasElapsed ? input.framesProcessed / elapsedSeconds : null;
  const speedFactor = hasElapsed ? input.offsetSeconds / elapsedSeconds : null;

  const eta = estimateRemaining({
    offsetSeconds: input.offsetSeconds,
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    speedFactor,
    chunksCompleted: input.chunksCompleted,
  });

  return {
    mediaOffsetSeconds: input.offsetSeconds,
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    framesProcessed: input.framesProcessed,
    throughputFps,
    speedFactor,
    etaSeconds: eta.seconds,
    ...(eta.reason === undefined ? {} : { etaUnavailableReason: eta.reason }),
    updatedAt: input.now.toISOString(),
  };
}

/**
 * ⚠️ Separate and exported so the *refusal* is testable, not just the arithmetic. Every branch that
 * returns `null` names why, because an absent ETA with no explanation is indistinguishable on screen
 * from a bug.
 */
export function estimateRemaining(input: {
  offsetSeconds: number;
  durationSeconds?: number;
  speedFactor: number | null;
  chunksCompleted: number;
}): { seconds: number | null; reason?: string } {
  if (input.durationSeconds === undefined || input.durationSeconds <= 0) {
    return {
      seconds: null,
      reason: 'the recording does not declare a duration, so there is no total to count down from',
    };
  }
  if (input.chunksCompleted < MIN_SAMPLES_FOR_ETA) {
    return {
      seconds: null,
      reason: `not enough of the recording has been analysed yet to estimate honestly (${String(input.chunksCompleted)} of ${String(MIN_SAMPLES_FOR_ETA)} samples)`,
    };
  }
  if (input.speedFactor === null || input.speedFactor <= 0) {
    return { seconds: null, reason: 'no measurable progress yet' };
  }
  const remainingFootage = Math.max(0, input.durationSeconds - input.offsetSeconds);
  return { seconds: remainingFootage / input.speedFactor };
}

/**
 * Plan the next chunk.
 *
 * ⚠️ Returns `null` when there is nothing left to do **according to the declared duration** — but the
 * source's own `reachedEnd` is what actually ends an analysis. A container that over-declares its
 * length would otherwise leave a session spinning on empty chunks for ever.
 */
export function nextChunk(
  offsetSeconds: number,
  durationSeconds: number | undefined,
  chunkSeconds: number = ANALYSIS_LIMITS.chunkSeconds,
  frameRate?: number,
): { fromOffsetSeconds: number; durationSeconds: number } | null {
  if (durationSeconds !== undefined && durationSeconds > 0 && offsetSeconds >= durationSeconds) {
    return null;
  }
  /*
   * ⛔ **A tail too short to contain another sample is the END, not a chunk** — and getting this
   * wrong failed every real recording the platform was ever given.
   *
   * `offsetSeconds` is where the *last emitted frame* was, not where the footage ends. At 2 fps a
   * 19.07 s recording samples its last frame at 19.0, leaving 0.07 s — so `offset >= duration` is
   * false and the old code asked for one more chunk. `Math.max(1, …)` then widened that 0.07 s
   * request to a full second, ffmpeg seeked past the last frame, emitted **nothing**, and exited
   * 234 "Conversion failed!". The worker read a non-zero exit as a decode failure and retried three
   * times, so a run that had already analysed **every frame** and found what it was looking for
   * presented as `retrying` for ever.
   *
   * ⚠️ **Every fixture in the validation library is exactly 30.000 s**, an exact multiple of the
   * sample interval, so its final chunk always landed on a sample point and emitted one frame. The
   * defect was structurally invisible to the entire dataset and appeared on the first recording
   * with an ordinary duration. Reported by the Architect, 2026-08-08.
   */
  if (durationSeconds !== undefined && durationSeconds > 0 && frameRate !== undefined && frameRate > 0) {
    if (durationSeconds - offsetSeconds < 1 / frameRate) return null;
  }
  const remaining =
    durationSeconds === undefined || durationSeconds <= 0
      ? chunkSeconds
      : Math.min(chunkSeconds, durationSeconds - offsetSeconds);
  return { fromOffsetSeconds: offsetSeconds, durationSeconds: Math.max(1, remaining) };
}

/**
 * ⭐ **Whether a resume can claim continuity with what came before, and it usually cannot.**
 *
 * The runtime holds tracking identities per (tenant, camera) in memory and releases them after an
 * idle period. A session resumed after longer than that gets **new identities**, so a dwell spanning
 * the gap is split into two shorter visits and may stop crossing its threshold — the rule did not
 * change, the answer did.
 *
 * This is why a resume records a finding rather than quietly continuing. It is the same honesty
 * [L-59](../../../../docs/project/KNOWN_LIMITATIONS.md) applies to a rules restart, one layer up.
 */
export function resumeBreaksIdentity(gapSeconds: number, idleReleaseSeconds = 300): boolean {
  return gapSeconds >= idleReleaseSeconds;
}
