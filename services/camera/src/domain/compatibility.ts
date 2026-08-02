/**
 * Domain: what this camera has been proven to work under (P-2.2, Architect P-2.2 rec 5).
 *
 * The support question is never "does this camera work?" — it is "what changed?". A camera that ran
 * fine for eight months and started failing has almost always moved along one of a small number of
 * axes: its firmware, the runtime probing it, the codec it serves, the provider it is reached
 * through. Recording a status **per axis value** is what turns "camera broken" into "camera broke on
 * V5.8.0", which is a vendor conversation instead of a site visit.
 *
 * Two rules keep the register honest:
 *
 * 1. **Older rows are never overwritten or removed.** A firmware the camera moved off two upgrades
 *    ago keeps its row and its counters exactly as they were left. That row is the evidence that the
 *    problem arrived with the upgrade.
 * 2. **`unsupported` is earned narrowly.** Only a *device-side* failure under hardware evidence can
 *    claim it. A DNS failure, a dead switch port or a wrong password say nothing whatsoever about a
 *    firmware or a codec, and letting them mark one unsupported would blame a vendor for a typo.
 *
 * Pure and deterministic.
 */
import type {
  CompatibilityDimension,
  CompatibilityRecord,
  CompatibilityStatus,
  StreamProbeFailureCode,
} from '@vip/contracts';
import { isHardwareEvidence } from '@vip/contracts';
import type { CameraProbeRecord } from '@vip/contracts';

/** Matches the `CameraCompatibilityHistory` contract bound. */
export const COMPATIBILITY_LIMIT = 60;

/**
 * Failure codes that are the *device's* doing.
 *
 * The excluded ones are the whole point: `dns-failure`, `tcp-failure` and `authentication-failure`
 * are network and credential problems. A camera unreachable because someone unplugged a switch has
 * not demonstrated anything about its firmware, and a register that counted it would eventually
 * mark a perfectly good firmware unsupported across an entire estate after one bad afternoon.
 */
const DEVICE_SIDE_FAILURES: ReadonlySet<StreamProbeFailureCode> = new Set([
  'rtsp-negotiation-failure',
  'codec-unsupported',
  'no-first-frame',
  'stream-interrupted',
  'timeout',
]);

export function isDeviceSideFailure(code: StreamProbeFailureCode | undefined): boolean {
  return code !== undefined && DEVICE_SIDE_FAILURES.has(code);
}

/** One (dimension, value) pair observed by a probe. */
export interface CompatibilityObservation {
  dimension: CompatibilityDimension;
  value: string;
}

/**
 * The axes a single probe record speaks to.
 *
 * Read off the record rather than the camera's current state, so a probe run two firmware versions
 * ago is attributed to the firmware it actually ran under.
 */
export function observationsFrom(record: CameraProbeRecord): CompatibilityObservation[] {
  const out: CompatibilityObservation[] = [];
  const push = (dimension: CompatibilityDimension, value: string | undefined) => {
    if (value) out.push({ dimension, value: value.slice(0, 120) });
  };
  push('firmware', record.configuration.firmware);
  push('runtime-version', record.runtimeVersion);
  push('provider', record.provider);
  push('codec', record.result?.codec ?? record.configuration.captureCodec);
  return out;
}

/**
 * The status one observation's evidence justifies — and `pending-validation` whenever it justifies
 * nothing.
 *
 * A successful probe on simulated or recorded evidence stays `pending-validation`. It proves the
 * platform can read that source; it proves nothing about a device running that firmware. This is the
 * AI-5e rule (CONSTRAINTS §18) applied to compatibility instead of certification, and it is the
 * reason a demo environment cannot mark an entire vendor's firmware supported.
 */
export function statusFor(record: CameraProbeRecord): CompatibilityStatus {
  if (!isHardwareEvidence(record.evidenceClass)) return 'pending-validation';
  if (record.outcome === 'succeeded') return 'supported';
  if (isDeviceSideFailure(record.failureCode)) return 'unsupported';
  return 'pending-validation';
}

/**
 * Fold a probe record into the compatibility register.
 *
 * Returns a **new** array; existing rows are copied with their counters advanced and their
 * `firstSeenAt` untouched. A row's status can move in either direction — a firmware that failed once
 * and has worked ever since should not be branded unsupported forever — but it can only be *claimed*
 * on hardware evidence, and a row that has ever succeeded on hardware is never demoted below
 * `pending-validation` by a subsequent unmeasured probe.
 */
export function recordCompatibility(
  history: readonly CompatibilityRecord[],
  record: CameraProbeRecord,
): CompatibilityRecord[] {
  const observations = observationsFrom(record);
  if (observations.length === 0) return [...history];

  const status = statusFor(record);
  const hardware = isHardwareEvidence(record.evidenceClass);
  const succeeded = hardware && record.outcome === 'succeeded';
  const failedOnDevice = hardware && isDeviceSideFailure(record.failureCode);

  const next = history.map((row) => ({ ...row }));
  for (const observation of observations) {
    const existing = next.find(
      (row) => row.dimension === observation.dimension && row.value === observation.value,
    );
    if (!existing) {
      next.push({
        dimension: observation.dimension,
        value: observation.value,
        status,
        firstSeenAt: record.at,
        lastSeenAt: record.at,
        evidenceClass: record.evidenceClass,
        successfulProbes: succeeded ? 1 : 0,
        failedProbes: failedOnDevice ? 1 : 0,
        lastProbeId: record.probeId,
      });
      continue;
    }
    existing.lastSeenAt = record.at;
    existing.lastProbeId = record.probeId;
    if (succeeded) existing.successfulProbes += 1;
    if (failedOnDevice) existing.failedProbes += 1;
    // Only hardware may move a status. An unmeasured probe updates when the row was last seen and
    // nothing else — otherwise a simulated run could quietly demote a firmware the platform has
    // genuinely certified.
    if (hardware) {
      existing.evidenceClass = record.evidenceClass;
      existing.status = status;
    }
  }

  // Oldest first, capped. The cap drops the *oldest* rows rather than the least interesting ones:
  // choosing which evidence to keep on the basis of how boring it looks is how a register starts
  // agreeing with whoever last defined "interesting".
  next.sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt));
  return next.slice(Math.max(0, next.length - COMPATIBILITY_LIMIT));
}

/** The current row for one axis value, if the camera has ever run under it. */
export function compatibilityFor(
  history: readonly CompatibilityRecord[],
  dimension: CompatibilityDimension,
  value: string,
): CompatibilityRecord | undefined {
  return history.find((row) => row.dimension === dimension && row.value === value);
}
