/**
 * Domain: trends over a camera's timeline (P-2, Architect P-2 rec 6).
 *
 * Current status cannot answer the question operators actually ask. "Is this camera reliable?" and
 * "is this camera up right now?" have different answers, and a camera that is online at the moment
 * you look at it and dropped forty times yesterday is indistinguishable from one that has never
 * faltered — until someone computes the difference.
 *
 * **The discipline this module keeps is refusing to report a trend it cannot support.** An
 * availability percentage derived from two timeline entries is arithmetic, not evidence, and a
 * dashboard that renders it as a number invites a decision the data does not justify. So
 * `availabilityPercent` is omitted below a floor, and `observations` always travels with the summary
 * so the reader can weigh it.
 *
 * Pure and deterministic — the window is passed in.
 */
import type { CameraHealthSummary, CameraTimelineEntry } from '@vip/contracts';

/**
 * Below this many state observations, availability is not reported. Four is the smallest number that
 * can describe a cycle (up, down, up, down); anything less is a snapshot wearing a percentage sign.
 */
export const MIN_OBSERVATIONS_FOR_AVAILABILITY = 4;

/** States that count as the camera doing its job. */
const HEALTHY = new Set(['connected', 'monitoring']);
/** States that count as it not doing its job. */
const UNHEALTHY = new Set(['offline', 'degraded']);

export interface SummaryInput {
  cameraId: string;
  timeline: readonly CameraTimelineEntry[];
  windowStart: Date;
  windowEnd: Date;
  /** Latency samples observed in the window, when any were recorded. */
  latencySamples?: readonly number[];
}

/**
 * Summarize a camera's timeline over a window.
 *
 * Availability is computed from *time spent* in each state, not from a count of events — a camera
 * that dropped once for eight hours is far less available than one that blipped eight times for a
 * second each, and counting events would rank them the other way round.
 */
export function summarizeHealth(input: SummaryInput): CameraHealthSummary {
  const { cameraId, windowStart, windowEnd } = input;
  const startMs = windowStart.getTime();
  const endMs = windowEnd.getTime();

  const entries = input.timeline
    .filter((entry) => {
      const at = new Date(entry.at).getTime();
      return at >= startMs && at <= endMs;
    })
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  let reconnects = 0;
  let credentialFailures = 0;
  let capabilityRefreshes = 0;
  let firmwareChanges = 0;
  let offlineMs = 0;
  let healthyMs = 0;
  let stateObservations = 0;

  let openState: string | null = null;
  let openSince = startMs;

  const close = (until: number) => {
    if (openState === null) return;
    const span = Math.max(0, until - openSince);
    if (HEALTHY.has(openState)) healthyMs += span;
    else if (UNHEALTHY.has(openState)) offlineMs += span;
  };

  for (const entry of entries) {
    const at = new Date(entry.at).getTime();
    switch (entry.kind) {
      case 'state-changed': {
        stateObservations += 1;
        close(at);
        // A move from an unhealthy state back into a healthy one is a reconnect. Counting every
        // arrival at `connected` would also count the first one, which is an installation, not a
        // recovery — and an estate report where every camera "reconnected once" is noise.
        if (entry.from && UNHEALTHY.has(entry.from) && entry.to && HEALTHY.has(entry.to)) {
          reconnects += 1;
        }
        openState = entry.to ?? null;
        openSince = at;
        break;
      }
      case 'capability-refreshed':
        capabilityRefreshes += 1;
        break;
      case 'firmware-changed':
        firmwareChanges += 1;
        break;
      case 'probe-failed':
        // The detail is written by `probeConnection`, which marks credential rejections explicitly.
        if (/credential|authenticat/i.test(entry.detail)) credentialFailures += 1;
        break;
      default:
        break;
    }
  }
  close(endMs);

  const measuredMs = healthyMs + offlineMs;
  const enoughEvidence = stateObservations >= MIN_OBSERVATIONS_FOR_AVAILABILITY && measuredMs > 0;

  const latencies = input.latencySamples ?? [];
  const averageLatencyMs =
    latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : undefined;

  return {
    cameraId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    observations: entries.length,
    ...(enoughEvidence
      ? { availabilityPercent: Math.round((healthyMs / measuredMs) * 1000) / 10 }
      : {}),
    reconnects,
    credentialFailures,
    offlineSeconds: Math.round(offlineMs / 1000),
    ...(averageLatencyMs !== undefined ? { averageLatencyMs } : {}),
    capabilityRefreshes,
    firmwareChanges,
  };
}
