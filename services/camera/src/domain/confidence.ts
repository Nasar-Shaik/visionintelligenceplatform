/**
 * Domain: operational confidence (P-2.2, Architect P-2.2 rec 4).
 *
 * **This is not AI confidence and must never be presented as one.** AI confidence is a model's
 * certainty about what it saw in a frame. This is a reliability score for a *device*, computed from
 * measured history. The two answer different questions for different people, and a dashboard that
 * puts them in one column will eventually have someone dismiss a real detection because "the camera
 * was only 72% confident".
 *
 * **It is never computed from a single probe.** One probe is a moment; confidence is a claim about
 * behaviour over time, and a camera that has been tested once is a camera nobody knows anything
 * about yet. Below the floors below, the band is `insufficient-evidence` and there is **no score at
 * all** — a percentage derived from two data points is arithmetic wearing a uniform.
 *
 * Six inputs, each answering something the others cannot (the Architect's list):
 *
 * | Input                | What it catches                                              |
 * | -------------------- | ------------------------------------------------------------ |
 * | Availability         | how much of the window the camera actually worked             |
 * | Failure frequency    | flapping — eight blips and one outage look identical by time  |
 * | Probe success        | whether deliberate tests pass, not just whether it stayed up  |
 * | Capability stability | a device being reconfigured underneath the platform           |
 * | Identity stability   | a camera that keeps becoming a different camera               |
 * | Recent recovery      | whether the trouble is current or already behind it           |
 *
 * Pure and deterministic.
 */
import type {
  CameraProbeRecord,
  ConfidencePoint,
  ConfidenceTrend,
  HealthTrendWindow,
  OperationalConfidence,
  OperationalConfidenceBand,
} from '@vip/contracts';
import { isHardwareEvidence } from '@vip/contracts';

/**
 * The floors below which no score is issued.
 *
 * Two separate floors because there are two ways a camera accumulates measured evidence, and one
 * probe satisfies neither. A probe produces both a report *and* the lifecycle transition it caused,
 * so counting observations alone would let a single probe look like two independent facts — which is
 * precisely the "do not base confidence on a single probe" failure this is guarding.
 *
 * Three measured state changes is the smallest number that can distinguish "working", "broken" and
 * "recovered"; two can only ever show a difference, not a pattern.
 */
export const MIN_CONFIDENCE_PROBES = 2;
export const MIN_CONFIDENCE_OBSERVATIONS = 3;

/** Score at or above which a camera is called stable. */
export const STABLE_SCORE = 85;
/** Score below which a camera is called failing. */
export const FAILING_SCORE = 60;

export interface ConfidenceInput {
  /** Share of the window spent healthy, when the health summary could compute one. */
  availabilityPercent?: number;
  /** Times the camera dropped in the window. */
  offlineCount: number;
  /** Times credentials were rejected in the window. */
  credentialFailures: number;
  /**
   * **Measured** lifecycle state changes in the window. Declared ones (onboarding, an operator
   * edit) prove intent, not behaviour, and letting them count would give a camera nobody has ever
   * tested a confidence score for having been configured.
   */
  stateObservations: number;
  /** Probe records inside the window, most recent first. */
  probes: readonly CameraProbeRecord[];
  /** Capability changes in the window that drift classification flagged `unexpected`. */
  unexpectedCapabilityChanges: number;
  /** Identity changes in the window. */
  identityChanges: number;
}

function clampPenalty(count: number, each: number, cap: number): number {
  return Math.min(count * each, cap);
}

/**
 * Compute a camera's operational confidence.
 *
 * The score starts from what the camera *did* — availability and probe success, blended when both
 * are known, because they fail independently: a camera can stay nominally online and fail every
 * deliberate probe, and a camera can pass every probe and still have dropped for six hours
 * overnight. Penalties then subtract for instability the base cannot see.
 *
 * Only **hardware** probes count. A simulated probe exercised the platform, and letting it raise a
 * device's reliability score is the same error as certifying hardware from a simulation.
 */
export function operationalConfidence(input: ConfidenceInput): OperationalConfidence {
  const measured = input.probes.filter((p) => isHardwareEvidence(p.evidenceClass));
  const observations = measured.length + input.stateObservations;
  const basis: string[] = [];

  if (
    measured.length < MIN_CONFIDENCE_PROBES &&
    input.stateObservations < MIN_CONFIDENCE_OBSERVATIONS
  ) {
    return {
      band: 'insufficient-evidence',
      observations,
      basis: [
        observations === 0
          ? 'nothing has measured this camera in this window'
          : `only ${observations} measured observation${observations === 1 ? '' : 's'} in this window — too few to score`,
      ],
    };
  }

  const successes = measured.filter((p) => p.outcome === 'succeeded').length;
  const probeSuccessPercent = measured.length > 0 ? (successes / measured.length) * 100 : undefined;

  const bases = [input.availabilityPercent, probeSuccessPercent].filter(
    (v): v is number => v !== undefined,
  );
  // Both known: average them. Neither can substitute for the other, and taking the worse of the two
  // would let one bad probe erase a month of uptime.
  let score = bases.length > 0 ? bases.reduce((a, b) => a + b, 0) / bases.length : 100;

  if (input.availabilityPercent !== undefined) {
    basis.push(`available ${input.availabilityPercent.toFixed(1)}% of the window`);
  }
  if (probeSuccessPercent !== undefined) {
    basis.push(`${successes} of ${measured.length} probes succeeded`);
  }

  const drops = clampPenalty(input.offlineCount, 4, 20);
  if (drops > 0) {
    basis.push(`dropped ${input.offlineCount} time${input.offlineCount === 1 ? '' : 's'}`);
  }
  const credentials = clampPenalty(input.credentialFailures, 8, 24);
  if (credentials > 0) {
    basis.push(
      `credentials rejected ${input.credentialFailures} time${input.credentialFailures === 1 ? '' : 's'}`,
    );
  }
  const capability = clampPenalty(input.unexpectedCapabilityChanges, 5, 15);
  if (capability > 0) {
    basis.push(
      `${input.unexpectedCapabilityChanges} unexplained capability change${input.unexpectedCapabilityChanges === 1 ? '' : 's'}`,
    );
  }
  const identity = clampPenalty(input.identityChanges, 6, 18);
  if (identity > 0) {
    basis.push(
      `identity changed ${input.identityChanges} time${input.identityChanges === 1 ? '' : 's'}`,
    );
  }
  score -= drops + credentials + capability + identity;

  // Recency. What a camera is doing *now* outweighs what it did on Tuesday — an operator deciding
  // whether to trust it this afternoon is asking about this afternoon.
  const latest = measured[0];
  if (latest) {
    if (latest.outcome === 'succeeded' && successes < measured.length) {
      score += 5;
      basis.push('recovered on the most recent probe');
    } else if (latest.outcome !== 'succeeded') {
      score -= 10;
      basis.push('the most recent probe failed');
    }
  }

  const bounded = Math.max(0, Math.min(100, Math.round(score * 10) / 10));
  const band: OperationalConfidenceBand =
    bounded >= STABLE_SCORE ? 'stable' : bounded >= FAILING_SCORE ? 'intermittent' : 'failing';

  return { band, score: bounded, observations, basis: basis.slice(0, 6) };
}

// ---------------------------------------------------------------------------------------------
// Confidence over time (P-2.3, Architect rec 4)
// ---------------------------------------------------------------------------------------------

/** How many buckets a trend is cut into. Twelve reads at a glance and survives a narrow column. */
export const TREND_BUCKETS = 12;

export interface TrendInput {
  cameraId: string;
  window: HealthTrendWindow;
  windowStart: Date;
  windowEnd: Date;
  /** Every probe in the window. Bucketed here rather than re-queried per bucket. */
  probes: readonly CameraProbeRecord[];
  /** Confidence over the whole window — what a single-number display shows. */
  current: OperationalConfidence;
  /** Per-bucket inputs the caller can supply; defaults treat the window as uniform. */
  offlineCount?: number;
  credentialFailures?: number;
}

/**
 * Cut a window into buckets and score each one (rec 4).
 *
 * **The latest confidence answers the wrong question.** A camera reading 92% right now looks
 * identical whether it has always been 92% or was 40% for three weeks and has just recovered — and
 * only the second is a reason to send somebody to site. A trend makes the difference visible.
 *
 * **A bucket with too little evidence gets no score and is left as a gap.** Interpolating one would
 * draw a confident line through a period nobody measured, which is the same lie as a lifetime
 * average — just prettier.
 */
export function confidenceTrend(input: TrendInput): ConfidenceTrend {
  const startMs = input.windowStart.getTime();
  const spanMs = Math.max(1, input.windowEnd.getTime() - startMs);
  const bucketMs = spanMs / TREND_BUCKETS;

  const buckets: CameraProbeRecord[][] = Array.from({ length: TREND_BUCKETS }, () => []);
  for (const probe of input.probes) {
    const offset = Date.parse(probe.at) - startMs;
    if (offset < 0 || offset > spanMs) continue;
    const index = Math.min(TREND_BUCKETS - 1, Math.floor(offset / bucketMs));
    (buckets[index] as CameraProbeRecord[]).push(probe);
  }

  const points: ConfidencePoint[] = buckets.map((probes, index) => {
    const at = new Date(startMs + (index + 1) * bucketMs).toISOString();
    const confidence = operationalConfidence({
      probes,
      // Per-bucket drop counts are not recoverable from the probe archive alone, so the bucket is
      // scored on what it can actually see. Attributing the window's total drops to every bucket
      // would make one bad hour look like a bad month.
      offlineCount: 0,
      credentialFailures: probes.filter((p) => p.failureCode === 'authentication-failure').length,
      stateObservations: 0,
      unexpectedCapabilityChanges: 0,
      identityChanges: 0,
    });
    return {
      at,
      band: confidence.band,
      ...(confidence.score !== undefined ? { score: confidence.score } : {}),
      observations: confidence.observations,
    };
  });

  return {
    cameraId: input.cameraId,
    window: input.window,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    points,
    current: input.current,
  };
}
