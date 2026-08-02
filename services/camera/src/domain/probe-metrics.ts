/**
 * Domain: probe performance, per camera and per fleet (P-2.2, Architect P-2.2 rec 7).
 *
 * **Computed from the retained reports on every read, never accumulated into stored counters.** A
 * stored average cannot be recomputed when the window changes, cannot be audited against the
 * evidence it came from, and drifts silently the first time a write path forgets to update it.
 * Deriving it means the number and the reports behind it can never disagree — and the reports are
 * immutable, so the derivation is stable.
 *
 * The fleet aggregate is the same computation over more records, deliberately: a dashboard whose
 * number disagrees with the camera detail page underneath it is worse than no dashboard, and two
 * implementations of one metric is how that happens.
 *
 * Pure and deterministic.
 */
import type {
  CameraProbeMetrics,
  CameraProbeRecord,
  CameraTimelineEntry,
  DistributionEntry,
  FailureDistributionEntry,
  FleetProbeMetrics,
  HealthTrendWindow,
  ProbeStageMetric,
  StreamProbeCheckName,
  StreamProbeFailureCode,
} from '@vip/contracts';
import { isHardwareEvidence } from '@vip/contracts';

/** The stage order the runtime reports in — metrics keep it so a table reads like the probe does. */
const STAGE_ORDER: readonly StreamProbeCheckName[] = [
  'dns',
  'tcp',
  'authentication',
  'rtsp-negotiation',
  'stream-open',
  'first-frame',
  'frames-received',
  'codec',
  'resolution',
  'fps',
  'stream-profile',
  'latency',
  'jitter',
];

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
}

/**
 * Mean cost of each stage across a set of reports.
 *
 * Only stages that actually *ran* contribute. A `skipped` stage has no duration and a `not-executed`
 * one was never reached; averaging either as a zero would make a fleet of HTTP cameras look like it
 * had instant RTSP negotiation, which is the kind of number that ends up on a slide.
 */
export function stageMetrics(records: readonly CameraProbeRecord[]): ProbeStageMetric[] {
  const samples = new Map<StreamProbeCheckName, number[]>();
  for (const record of records) {
    for (const check of record.result?.checks ?? []) {
      if (check.durationMs === undefined) continue;
      if (check.status === 'skipped' || check.status === 'not-executed') continue;
      const bucket = samples.get(check.name) ?? [];
      bucket.push(check.durationMs);
      samples.set(check.name, bucket);
    }
  }
  const out: ProbeStageMetric[] = [];
  for (const stage of STAGE_ORDER) {
    const bucket = samples.get(stage);
    if (!bucket || bucket.length === 0) continue;
    out.push({ stage, averageMs: mean(bucket) as number, samples: bucket.length });
  }
  return out;
}

/** Mean cost of a capability refresh, read off the timeline entries that recorded one. */
export function capabilityRefreshAverage(
  timeline: readonly CameraTimelineEntry[],
  windowStart: Date,
  windowEnd: Date,
): number | undefined {
  const durations = timeline
    .filter(
      (entry) =>
        entry.kind === 'capability-refreshed' &&
        entry.durationMs !== undefined &&
        inWindow(entry.at, windowStart, windowEnd),
    )
    .map((entry) => entry.durationMs as number);
  return mean(durations);
}

export function inWindow(at: string, start: Date, end: Date): boolean {
  const t = Date.parse(at);
  return t >= start.getTime() && t <= end.getTime();
}

export interface MetricsInput {
  cameraId: string;
  window: HealthTrendWindow;
  windowStart: Date;
  windowEnd: Date;
  records: readonly CameraProbeRecord[];
  timeline: readonly CameraTimelineEntry[];
}

/** Probe performance for one camera over a window. */
export function probeMetrics(input: MetricsInput): CameraProbeMetrics {
  const records = input.records.filter((r) => inWindow(r.at, input.windowStart, input.windowEnd));
  const successes = records.filter((r) => r.outcome === 'succeeded').length;
  const failures = records.filter((r) => r.outcome === 'failed').length;
  const totals = records.map((r) => r.result?.totalMs).filter((v): v is number => v !== undefined);
  const firstFrames = records
    .map((r) => r.result?.firstFrameMs)
    .filter((v): v is number => v !== undefined);
  const refresh = capabilityRefreshAverage(input.timeline, input.windowStart, input.windowEnd);
  const averageTotalMs = mean(totals);
  const averageFirstFrameMs = mean(firstFrames);

  return {
    cameraId: input.cameraId,
    window: input.window,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    probes: records.length,
    successes,
    failures,
    // Absent rather than 0 when nothing ran: "0% success" and "never probed" are different claims,
    // and only one of them is a reason to send somebody to site.
    ...(records.length > 0
      ? { successRatePercent: Math.round((successes / records.length) * 1000) / 10 }
      : {}),
    ...(averageTotalMs !== undefined ? { averageTotalMs } : {}),
    ...(averageFirstFrameMs !== undefined ? { averageFirstFrameMs } : {}),
    stages: stageMetrics(records),
    ...(refresh !== undefined ? { averageCapabilityRefreshMs: refresh } : {}),
    hardwareProbes: records.filter((r) => isHardwareEvidence(r.evidenceClass)).length,
  };
}

function distribution(values: readonly string[], limit: number): DistributionEntry[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

export interface FleetMetricsInput {
  window: HealthTrendWindow;
  windowStart: Date;
  windowEnd: Date;
  /** Every camera in scope — including the ones nothing has ever probed. */
  cameras: readonly { cameraId: string; firmware?: string; compatibilityStatuses: string[] }[];
  records: readonly CameraProbeRecord[];
  /** Confidence scores for the cameras that had enough evidence to be given one. */
  confidenceScores: readonly number[];
}

/**
 * Probe performance across a whole tenant.
 *
 * `camerasNeverProbed` is the field that keeps this honest. "98% probe success" computed over the
 * four cameras anyone has ever tested, in an estate of three hundred, is a green number describing a
 * sample nobody chose — and it is exactly the number a fleet dashboard will otherwise show.
 */
export function fleetMetrics(input: FleetMetricsInput): FleetProbeMetrics {
  const records = input.records.filter((r) => inWindow(r.at, input.windowStart, input.windowEnd));
  const successes = records.filter((r) => r.outcome === 'succeeded').length;
  const failures = records.filter((r) => r.outcome === 'failed').length;
  const probedCameras = new Set(records.map((r) => r.cameraId));

  const failureCounts = new Map<StreamProbeFailureCode, number>();
  for (const record of records) {
    if (!record.failureCode) continue;
    failureCounts.set(record.failureCode, (failureCounts.get(record.failureCode) ?? 0) + 1);
  }
  const failureBreakdown: FailureDistributionEntry[] = [...failureCounts.entries()]
    .map(([failureCode, count]) => ({ failureCode, count }))
    .sort((a, b) => b.count - a.count || a.failureCode.localeCompare(b.failureCode));

  const totals = records.map((r) => r.result?.totalMs).filter((v): v is number => v !== undefined);
  const averageTotalMs = mean(totals);
  const averageConfidence = mean(input.confidenceScores);

  return {
    window: input.window,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    cameras: input.cameras.length,
    camerasProbed: probedCameras.size,
    camerasNeverProbed: input.cameras.filter((c) => !probedCameras.has(c.cameraId)).length,
    probes: records.length,
    successes,
    failures,
    ...(records.length > 0
      ? { successRatePercent: Math.round((successes / records.length) * 1000) / 10 }
      : {}),
    ...(averageTotalMs !== undefined ? { averageTotalMs } : {}),
    stages: stageMetrics(records),
    ...(failureBreakdown[0] ? { mostCommonFailure: failureBreakdown[0] } : {}),
    failureBreakdown: failureBreakdown.slice(0, 9),
    firmwareDistribution: distribution(
      input.cameras.map((c) => c.firmware).filter((v): v is string => Boolean(v)),
      20,
    ),
    providerDistribution: distribution(
      records.map((r) => r.provider),
      16,
    ),
    compatibilityDistribution: distribution(
      input.cameras.flatMap((c) => c.compatibilityStatuses),
      3,
    ),
    ...(averageConfidence !== undefined ? { averageConfidence } : {}),
    confidenceSamples: input.confidenceScores.length,
  };
}
