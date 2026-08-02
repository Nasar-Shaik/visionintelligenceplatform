/**
 * Domain: the immutable probe archive (P-2.2, Architect P-2.2 rec 2 + rec 6).
 *
 * Before this, every probe overwrote `Camera.operational` and the previous measurement ceased to
 * exist. That makes the most common operational question unanswerable: *was it always like this?* A
 * camera taking four seconds to first frame is unremarkable if it always did and is an incident if
 * it took 300 ms last week — and only one of those two readings is available if last week's report
 * was overwritten.
 *
 * Three properties, all enforced here rather than trusted to callers:
 *
 * 1. **Records are written once and never modified.** There is no update function in this module and
 *    the service never issues one against the archive. A correction is a new record, not an edit.
 * 2. **Every record carries what it needs to be read alone** — provider, probe version, runtime
 *    version, evidence class, the configuration it ran against and the identity it ran against. A
 *    report that has to be joined against the camera's *current* state to be understood is a report
 *    that silently changes meaning every time the camera is reconfigured.
 * 3. **Replay is a pure function over a stored record.** It cannot become a live measurement because
 *    it has no access to a camera, a network or a clock beyond the one passed in.
 *
 * Pure and deterministic — no clock, no I/O, no driver.
 */
import type {
  CameraDeviceIdentity,
  CameraLifecycleState,
  CameraProbeRecord,
  ProbeComparison,
  ProbeConfigurationSnapshot,
  ProbeOutcome,
  ProbeReplay,
  ProbeStageChange,
  StreamProbeCheck,
  StreamProbeCheckName,
  StreamProbeResult,
  ValidationProvider,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';
import type { CameraDoc } from './camera.js';

/**
 * How many reports are retained per camera.
 *
 * Bounded because a camera probed every five minutes produces a hundred thousand reports a year, and
 * an unbounded per-camera archive is a storage commitment nobody agreed to. **Nothing is ever
 * overwritten** — the oldest records are dropped whole, the count of what was dropped is reported
 * (`CameraProbeHistory.evicted`), and the platform never presents a trimmed archive as a complete
 * one. Long-term retention beyond this is an evidence-store decision, not a camera-service one.
 */
export const PROBE_RETENTION = 200;

/** A persisted probe record. `_id` is the probe id; `tenantId` scopes it (Law 5). */
export interface ProbeRecordDoc extends TenantScoped, Omit<CameraProbeRecord, 'probeId'> {
  _id: string;
}

export function toProbeRecord(doc: ProbeRecordDoc): CameraProbeRecord {
  // `tenantId` is storage scoping, not evidence — it is deliberately dropped on the way out.
  const { _id, tenantId, ...rest } = doc;
  void tenantId;
  return { probeId: _id, ...rest };
}

/**
 * The configuration a probe ran against, snapshotted (rec 2).
 *
 * Taken from the camera at probe time and **never back-filled from its current state**: a stored
 * report that silently re-reads today's configuration would rewrite its own history every time
 * somebody edited the camera, and the comparison it exists to support would be against a stream URL
 * that was not the one measured.
 */
export function configurationSnapshot(
  doc: CameraDoc,
  provider: ValidationProvider,
): ProbeConfigurationSnapshot {
  return {
    protocol: doc.protocol,
    streamUrl: doc.streamUrl,
    provider,
    credentialsSupplied: doc.credentialCipher !== null,
    ...(doc.capture.codec ? { captureCodec: doc.capture.codec } : {}),
    ...(doc.capture.resolution ? { captureResolution: doc.capture.resolution } : {}),
    ...(doc.capture.fps !== undefined ? { captureFps: doc.capture.fps } : {}),
    ...(doc.capabilityCache?.cacheVersion !== undefined
      ? { capabilityCacheVersion: doc.capabilityCache.cacheVersion }
      : {}),
    ...(doc.capabilityCache?.firmware ? { firmware: doc.capabilityCache.firmware } : {}),
  };
}

/** The outcome a probe result represents. `unavailable` is the no-result case. */
export function outcomeOf(result: StreamProbeResult | null): ProbeOutcome {
  if (!result) return 'unavailable';
  return result.framesRead > 0 && result.failureCode === undefined ? 'succeeded' : 'failed';
}

export interface BuildProbeRecordInput {
  probeId: string;
  cameraId: string;
  at: Date;
  doc: CameraDoc;
  result: StreamProbeResult | null;
  lifecycleBefore: CameraLifecycleState;
  lifecycleAfter: CameraLifecycleState;
  /** This camera's probe ordinal. Supplies the total order a timestamp cannot. */
  sequence: number;
  /** The record immediately before this one, when the camera has been probed before. */
  previous?: CameraProbeRecord | null;
  /** Correlation id when the caller supplied one and the probe returned no result to carry it. */
  correlationId?: string;
}

/**
 * Assemble one immutable record.
 *
 * The correlation fields (rec 2) are a **backward pointer only**: the previous record is not
 * rewritten to point forward at this one, because that would be a modification of stored evidence
 * for the sake of a convenience the reader can get by sorting. Following the chain back to the last
 * `succeeded` is how "when did this start failing?" gets answered.
 */
export function buildProbeRecord(input: BuildProbeRecordInput): CameraProbeRecord {
  const { doc, result, previous } = input;
  const provider: ValidationProvider = result?.provider ?? 'unknown';
  const identity: CameraDeviceIdentity | undefined = doc.identity;
  const lastIdentityChange = doc.identityHistory?.[doc.identityHistory.length - 1]?.at;
  const correlationId = result?.correlationId ?? input.correlationId;

  return {
    probeId: input.probeId,
    cameraId: input.cameraId,
    at: result?.probedAt ?? input.at.toISOString(),
    sequence: input.sequence,
    outcome: outcomeOf(result),
    // The archive's evidence class is the result's, and `simulated` when there was no result at all:
    // a probe that could not run measured nothing, and claiming hardware for it would be inventing
    // the strongest possible evidence out of the total absence of any.
    evidenceClass: result?.evidenceClass ?? 'simulated',
    probeVersion: result?.probeVersion ?? '0',
    ...(result?.runtimeVersion ? { runtimeVersion: result.runtimeVersion } : {}),
    provider,
    ...(correlationId ? { correlationId } : {}),
    ...(result?.failureCode ? { failureCode: result.failureCode } : {}),
    ...(identity ? { identity } : {}),
    configuration: configurationSnapshot(doc, provider),
    ...(result ? { result } : {}),
    lifecycleBefore: input.lifecycleBefore,
    lifecycleAfter: input.lifecycleAfter,
    ...(previous
      ? {
          previousProbeId: previous.probeId,
          previousProbeAt: previous.at,
          previousOutcome: previous.outcome,
          ...(previous.failureCode ? { previousFailureCode: previous.failureCode } : {}),
        }
      : {}),
    ...(doc.capabilityCache?.lastRefreshedAt
      ? { capabilitySnapshotAt: doc.capabilityCache.lastRefreshedAt }
      : {}),
    ...(lastIdentityChange ? { identitySnapshotAt: lastIdentityChange } : {}),
  };
}

/** Index a report's checks by stage name. */
function stageStatuses(
  result: StreamProbeResult | undefined,
): Map<StreamProbeCheckName, StreamProbeCheck['status']> {
  const map = new Map<StreamProbeCheckName, StreamProbeCheck['status']>();
  for (const check of result?.checks ?? []) map.set(check.name, check.status);
  return map;
}

/**
 * Compare two probes (rec 2).
 *
 * **The comparison is the diagnosis.** One failing probe says a camera is broken; the same probe set
 * beside its predecessor says *authentication used to pass and now does not*, which names the change
 * and usually the person who made it. `configurationChanged` leads because it is the confound: a
 * camera that was re-pointed at its main stream did not get slower, it got asked for more.
 */
export function compareProbes(
  current: CameraProbeRecord,
  previous: CameraProbeRecord,
): ProbeComparison {
  const before = stageStatuses(previous.result);
  const after = stageStatuses(current.result);
  const stageChanges: ProbeStageChange[] = [];
  for (const [name, to] of after) {
    const from = before.get(name);
    if (from !== undefined && from !== to) stageChanges.push({ name, from, to });
  }

  const delta = (a: number | undefined, b: number | undefined): number | undefined =>
    a !== undefined && b !== undefined ? Math.round((a - b) * 1000) / 1000 : undefined;

  const totalMsDelta = delta(current.result?.totalMs, previous.result?.totalMs);
  const firstFrameMsDelta = delta(current.result?.firstFrameMs, previous.result?.firstFrameMs);

  return {
    previousProbeId: previous.probeId,
    previousAt: previous.at,
    outcomeChanged: current.outcome !== previous.outcome,
    previousOutcome: previous.outcome,
    ...(previous.failureCode ? { previousFailureCode: previous.failureCode } : {}),
    ...(totalMsDelta !== undefined ? { totalMsDelta } : {}),
    ...(firstFrameMsDelta !== undefined ? { firstFrameMsDelta } : {}),
    stageChanges: stageChanges.slice(0, 13),
    configurationChanged:
      JSON.stringify(current.configuration) !== JSON.stringify(previous.configuration),
  };
}

/**
 * Reconstruct a stored probe **without contacting the camera** (rec 6).
 *
 * Support work happens hours or days after a failure, usually from a different building, and often
 * for a camera that has since been power-cycled into working again. Re-running the probe at that
 * point measures a different moment and answers a different question — usually "it works now",
 * which closes the ticket without explaining anything.
 *
 * This function has no network, no camera and no probe port in scope. It *cannot* become a live
 * measurement, which is a stronger guarantee than a comment asking it not to.
 */
export function replayProbe(
  record: CameraProbeRecord,
  replayedAt: Date,
  previous?: CameraProbeRecord | null,
): ProbeReplay {
  const failedStage = record.result?.checks.find((check) => check.status === 'fail')?.name;
  return {
    probeId: record.probeId,
    cameraId: record.cameraId,
    recordedAt: record.at,
    replayedAt: replayedAt.toISOString(),
    evidenceClass: record.evidenceClass,
    probeVersion: record.probeVersion,
    ...(record.runtimeVersion ? { runtimeVersion: record.runtimeVersion } : {}),
    provider: record.provider,
    outcome: record.outcome,
    ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    ...(failedStage ? { failedStage } : {}),
    configuration: record.configuration,
    ...(record.identity ? { identity: record.identity } : {}),
    // Exactly as recorded, in the order recorded. The runtime sorted these into stage order when it
    // measured them; re-sorting here would risk a replay that reads differently from the original.
    stages: record.result?.checks ?? [],
    ...(record.result?.totalMs !== undefined ? { totalMs: record.result.totalMs } : {}),
    warnings: record.result?.warnings ?? [],
    ...(previous ? { comparison: compareProbes(record, previous) } : {}),
  };
}
