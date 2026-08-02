/**
 * Domain: why the platform did what it did (P-2.3, Architect rec 8).
 *
 * **Explainability only. Nothing here changes what the platform does.** No decision is consulted by
 * any code path; these are *reconstructions*, produced so an operator can ask the questions they
 * actually ask — _why was this camera degraded? why was this probe marked failed? why did confidence
 * drop? why was this firmware marked unsupported?_ — and receive the rule that ran and the evidence
 * it ran on, rather than a plausible story assembled after the fact.
 *
 * **Derived, never persisted** (rec 4). Every input is already in the archive, and a stored decision
 * would be a second copy of a conclusion that could drift from the evidence it was drawn from —
 * exactly the failure this evidence layer exists to prevent. It also means an explanation improves
 * retroactively when the explanation improves, rather than leaving old rows phrased in the words of
 * whatever version happened to write them.
 *
 * Each decision points at evidence ids that resolve in the unified timeline, so "why" is one click
 * from "on what". A decision with no supporting evidence is an opinion, and the platform does not
 * issue those.
 *
 * Pure and deterministic.
 */
import type {
  CameraDecisionLog,
  CameraProbeRecord,
  CameraTimelineEntry,
  CompatibilityRecord,
  OperationalConfidence,
  OperationalDecision,
} from '@vip/contracts';
import { isHardwareEvidence } from '@vip/contracts';
import { isDeviceSideFailure } from './compatibility.js';

/** Matches the `CameraDecisionLog` bound. */
export const DECISION_LIMIT = 200;

/**
 * Why a probe got the outcome it got.
 *
 * The rule is `outcomeOf`: frames read **and** no failure code. Stating both halves matters — a
 * device that delivered frames and then dropped the stream is a failure with frames in it, and an
 * explanation that only mentioned the frame count would read as a contradiction.
 */
function probeOutcomeDecision(record: CameraProbeRecord): OperationalDecision {
  const frames = record.result?.framesRead ?? 0;
  const reason =
    record.outcome === 'succeeded'
      ? `${frames} frame${frames === 1 ? '' : 's'} were decoded and no stage failed`
      : record.outcome === 'unavailable'
        ? 'no stream validator was reachable, so nothing about the camera was measured'
        : record.failureCode
          ? `the ${record.provider} pipeline stopped at ${record.failureCode}` +
            (frames > 0 ? `, after ${frames} frames had already arrived` : '')
          : 'no frame was decoded';
  return {
    kind: 'probe-outcome',
    at: record.at,
    // The runtime classified it. Recording the camera service as the actor would misattribute a
    // judgement it did not make.
    actor: record.outcome === 'unavailable' ? 'camera-service' : 'runtime',
    decision: record.outcome,
    reason,
    supportingEvidence: [`probe:${record.probeId}`],
    evidenceClass: record.evidenceClass,
  };
}

/**
 * Why a lifecycle state changed — or, just as importantly, why it did not.
 *
 * The second case is the one worth explaining. A flawless probe of a simulated source moves nothing,
 * and without an explanation that looks exactly like a bug to whoever is watching the state stay put.
 */
function lifecycleDecisions(
  timeline: readonly CameraTimelineEntry[],
  probes: readonly CameraProbeRecord[],
): OperationalDecision[] {
  const out: OperationalDecision[] = [];

  for (const [index, entry] of timeline.entries()) {
    if (entry.kind !== 'state-changed' || !entry.to) continue;
    out.push({
      kind: 'lifecycle-state',
      at: entry.at,
      actor: entry.evidence === 'administrative' ? 'operator' : 'camera-service',
      decision: entry.to,
      reason:
        entry.evidence === 'measured'
          ? `a probe of the physical device reported: ${entry.detail}`
          : entry.evidence === 'administrative'
            ? `an operator decided: ${entry.detail}`
            : entry.detail,
      reasonCode: entry.reasonCode,
      supportingEvidence: [
        `tl:${index}:${entry.kind}`,
        ...(entry.probeId ? [`probe:${entry.probeId}`] : []),
      ],
    });
  }

  for (const record of probes) {
    if (isHardwareEvidence(record.evidenceClass)) continue;
    // The negative control, made legible. See CONSTRAINTS §25.
    out.push({
      kind: 'lifecycle-state',
      at: record.at,
      actor: 'camera-service',
      decision: 'unchanged',
      reason:
        `this probe measured a ${record.evidenceClass} source, not the camera. States that describe ` +
        'a physical device may only be entered from hardware evidence, so nothing moved',
      reasonCode: 'derived',
      supportingEvidence: [`probe:${record.probeId}`],
      evidenceClass: record.evidenceClass,
    });
  }

  return out;
}

/** Why a capability refresh did or did not go back to the device, and how its changes were read. */
function capabilityDecisions(timeline: readonly CameraTimelineEntry[]): OperationalDecision[] {
  const out: OperationalDecision[] = [];
  for (const [index, entry] of timeline.entries()) {
    if (entry.kind !== 'capability-refreshed') continue;
    const unexpected = entry.detail.startsWith('unexpected');
    out.push({
      kind: 'capability-refresh',
      at: entry.at,
      actor: 'camera-service',
      decision: 'refreshed',
      reason: `the cache decision was ${entry.reasonCode}; the device reported: ${entry.detail}`,
      reasonCode: entry.reasonCode,
      supportingEvidence: [`tl:${index}:${entry.kind}`],
    });
    if (entry.detail === 'no capabilities changed') continue;
    out.push({
      kind: 'capability-drift',
      at: entry.at,
      actor: 'camera-service',
      decision: unexpected ? 'unexpected' : 'expected',
      reason: unexpected
        ? 'at least one change touches what analysis receives or costs, or nothing accounts for it'
        : 'every change is descriptive and is accounted for by an observed cause',
      reasonCode: entry.reasonCode,
      supportingEvidence: [`tl:${index}:${entry.kind}`],
    });
  }
  return out;
}

/** Why a firmware, codec or provider carries the compatibility status it carries. */
function compatibilityDecisions(rows: readonly CompatibilityRecord[]): OperationalDecision[] {
  return rows.map((row) => ({
    kind: 'compatibility-status' as const,
    at: row.lastSeenAt,
    actor: 'camera-service' as const,
    decision: row.status,
    reason:
      row.status === 'supported'
        ? `${row.successfulProbes} probe${row.successfulProbes === 1 ? '' : 's'} of the physical device read frames under ${row.dimension} ${row.value}`
        : row.status === 'unsupported'
          ? `the device failed on its own account under ${row.dimension} ${row.value}; network and credential failures are deliberately excluded from this judgement`
          : `nothing has measured this camera on hardware under ${row.dimension} ${row.value}, so no claim is made either way`,
    supportingEvidence: [
      `cmp:${row.dimension}:${row.value}`,
      ...(row.lastProbeId ? [`probe:${row.lastProbeId}`] : []),
    ],
    evidenceClass: row.evidenceClass,
  }));
}

/** Why confidence reads the way it does — the basis strings the model already produced. */
function confidenceDecision(
  confidence: OperationalConfidence,
  at: string,
  probes: readonly CameraProbeRecord[],
): OperationalDecision {
  return {
    kind: 'confidence',
    at,
    actor: 'camera-service',
    decision:
      confidence.score !== undefined ? `${confidence.band} (${confidence.score})` : confidence.band,
    reason: confidence.basis.join('; ') || 'no measured evidence in this window',
    supportingEvidence: probes.slice(0, 10).map((p) => `probe:${p.probeId}`),
  };
}

export interface DecisionInput {
  cameraId: string;
  from: Date;
  to: Date;
  timeline: readonly CameraTimelineEntry[];
  probes: readonly CameraProbeRecord[];
  compatibility: readonly CompatibilityRecord[];
  confidence: OperationalConfidence;
}

/** Reconstruct every explainable decision about a camera, most recent first. */
export function explainDecisions(input: DecisionInput): CameraDecisionLog {
  const startMs = input.from.getTime();
  const endMs = input.to.getTime();
  const within = (at: string) => {
    const t = Date.parse(at);
    return t >= startMs && t <= endMs;
  };

  const probes = input.probes.filter((p) => within(p.at));
  const decisions = [
    ...probes.map(probeOutcomeDecision),
    ...lifecycleDecisions(input.timeline, probes),
    ...capabilityDecisions(input.timeline),
    ...compatibilityDecisions(input.compatibility),
    confidenceDecision(input.confidence, input.to.toISOString(), probes),
  ]
    .filter((decision) => within(decision.at))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    cameraId: input.cameraId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    decisions: decisions.slice(0, DECISION_LIMIT),
  };
}

/** Re-exported so the failure taxonomy behind a compatibility decision has exactly one definition. */
export { isDeviceSideFailure };
