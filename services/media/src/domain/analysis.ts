/**
 * Domain: pure construction and projection for offline video investigation (P-8 Phase 8).
 *
 * Framework- and I/O-free. Everything here is a total function over values, which is what lets the
 * ⭐ **footage-time derivation** — the one piece of arithmetic this milestone turns on — be tested
 * without ffmpeg, a runtime, a database or a clock.
 */
import {
  ANALYSIS_CONTENT_TYPES,
  ANALYSIS_LIMITS,
  ANALYSIS_PIPELINE_VERSION,
  EMPTY_ANALYSIS_COUNTS,
  isDecodableContainer,
  type AnalysisAsset,
  type AnalysisContainer,
  type AnalysisFinding,
  type AnalysisSession,
  type AnalysisSessionState,
  type FootageStartSource,
  type VideoAnalysis,
  type VideoAnalysisState,
} from '@vip/contracts';
import type { TenantScoped } from '@vip/tenancy';

/**
 * What the uploader **declared**, held only until the object is measured.
 *
 * ⚠️ Deliberately not part of `AnalysisAsset` and deliberately not in the public contract. Every
 * field here is a claim: the name a browser sent, the type it said it would write, the size it said
 * it would be. `AnalysisAsset` is what `ffprobe` and the object store measured. Keeping them in
 * separate shapes is what stops a claim being read later as a measurement — and the key is here
 * because it is the one thing the *platform* decided, so confirm knows where to look.
 */
export interface PendingUpload {
  key: string;
  originalName: string;
  contentType: string;
  container: AnalysisContainer;
  declaredBytes: number;
}

/** MongoDB-persisted analysis document. `_id` is the analysis id; `tenantId` scopes it (Law 5). */
export interface AnalysisDoc extends TenantScoped {
  _id: string;
  cameraId: string;
  cameraName?: string;
  label?: string;
  sourceKind: 'upload' | 'camera-recording' | 'device-export';
  state: VideoAnalysisState;
  /** Present from creation until the upload is confirmed. */
  pendingUpload?: PendingUpload;
  asset?: AnalysisAsset;
  footageStartedAt: string;
  footageStartSource: FootageStartSource;
  latestSessionId?: string;
  sessionCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** MongoDB-persisted session document. ⛔ Immutable once `state` is terminal. */
export interface AnalysisSessionDoc extends TenantScoped {
  _id: string;
  analysisId: string;
  cameraId: string;
  sequence: number;
  state: AnalysisSessionState;
  jobId?: string;
  analysisFrameRate: number;
  provenance: AnalysisSession['provenance'];
  ruleSet: AnalysisSession['ruleSet'];
  progress: AnalysisSession['progress'];
  counts: AnalysisSession['counts'];
  findings: AnalysisFinding[];
  error?: string;
  requestedBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * ⭐ **The frame's `occurredAt`, and the whole correctness of offline analysis.**
 *
 * A frame's event time is where in the *footage* it sits, never when the analysis happened to run.
 * Every downstream stage — the events service's dedup window, `window`, `dwell`, every cool-down —
 * is keyed on `occurredAt`, so this function is what makes a recording analysed at 8× produce the
 * same incidents as the same recording analysed at 1×.
 *
 * ⚠️ `seq` is 1-based, as the decoder emits it, so frame 1 sits at offset **0** — the first frame is
 * the start of the footage, not one interval into it. Getting that wrong shifts every incident in
 * the file by one frame interval, which is invisible at 2 fps and wrong at every rate.
 */
export function frameOffsetSeconds(seq: number, frameRate: number): number {
  if (!Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error(`frameRate must be positive, got ${String(frameRate)}`);
  }
  return Math.max(0, seq - 1) / frameRate;
}

/** Footage time for a decoded frame: where it sits in the recording, on the recording's clock. */
export function frameFootageTime(footageStartedAt: string, seq: number, frameRate: number): Date {
  const startMs = Date.parse(footageStartedAt);
  if (Number.isNaN(startMs)) throw new Error(`footageStartedAt is not a date: ${footageStartedAt}`);
  return new Date(startMs + frameOffsetSeconds(seq, frameRate) * 1000);
}

/**
 * Resolve an upload's declared content type to a container, or explain the refusal.
 *
 * ⚠️ Two different refusals, deliberately distinguished: a type the platform has never heard of, and
 * one it accepts in principle but has not proven it can decode. An operator who is told "we do not
 * support .mkv yet" behaves differently from one told "that is not a video".
 */
export type ContainerResolution =
  { ok: true; container: AnalysisContainer } | { ok: false; reason: string };

export function resolveContainer(contentType: string): ContainerResolution {
  const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const container = ANALYSIS_CONTENT_TYPES[normalized];
  if (container === undefined) {
    const accepted = Object.keys(ANALYSIS_CONTENT_TYPES).join(', ');
    return {
      ok: false,
      reason: `unsupported content type '${contentType}' — accepted: ${accepted}`,
    };
  }
  if (!isDecodableContainer(container)) {
    return {
      ok: false,
      reason:
        `'${container}' uploads are accepted by the contract but this deployment has not proven it ` +
        `can decode one, so it would produce an empty analysis rather than an error. Use mp4.`,
    };
  }
  return { ok: true, container };
}

/** The object key for an analysis's source media. ⭐ Generated — never derived from a filename. */
export function analysisSourceKey(analysisId: string, container: AnalysisContainer): string {
  return `analyses/${analysisId}/source.${container}`;
}

export interface NewAnalysisInput {
  id: string;
  tenantId: string;
  cameraId: string;
  cameraName?: string;
  label?: string;
  pendingUpload: PendingUpload;
  footageStartedAt: string;
  footageStartSource: FootageStartSource;
  createdBy: string;
  now: Date;
}

/** Build a `draft` analysis. ⚠️ No asset yet — the bytes do not exist until the upload lands. */
export function newAnalysis(input: NewAnalysisInput): AnalysisDoc {
  const iso = input.now.toISOString();
  return {
    _id: input.id,
    tenantId: input.tenantId,
    cameraId: input.cameraId,
    ...(input.cameraName === undefined ? {} : { cameraName: input.cameraName }),
    ...(input.label === undefined ? {} : { label: input.label }),
    sourceKind: 'upload',
    state: 'draft',
    pendingUpload: input.pendingUpload,
    footageStartedAt: input.footageStartedAt,
    footageStartSource: input.footageStartSource,
    sessionCount: 0,
    createdBy: input.createdBy,
    createdAt: iso,
    updatedAt: iso,
  };
}

export function toAnalysis(doc: AnalysisDoc): VideoAnalysis {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    cameraId: doc.cameraId,
    ...(doc.cameraName === undefined ? {} : { cameraName: doc.cameraName }),
    ...(doc.label === undefined ? {} : { label: doc.label }),
    sourceKind: doc.sourceKind,
    state: doc.state,
    ...(doc.asset === undefined ? {} : { asset: doc.asset }),
    footageStartedAt: doc.footageStartedAt,
    footageStartSource: doc.footageStartSource,
    ...(doc.latestSessionId === undefined ? {} : { latestSessionId: doc.latestSessionId }),
    sessionCount: doc.sessionCount,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export interface NewSessionInput {
  id: string;
  tenantId: string;
  analysisId: string;
  cameraId: string;
  sequence: number;
  analysisFrameRate: number;
  capabilityId: string;
  ruleSet: AnalysisSession['ruleSet'];
  findings: AnalysisFinding[];
  requestedBy: string;
  now: Date;
  durationSeconds?: number;
}

/**
 * Build a `queued` session.
 *
 * ⚠️ Provenance is captured **here**, when the run is committed to, rather than when it finishes.
 * The runtime can be redeployed mid-analysis; recording the version at the end would attribute a
 * result to software that produced none of it.
 */
export function newSession(input: NewSessionInput): AnalysisSessionDoc {
  const iso = input.now.toISOString();
  return {
    _id: input.id,
    tenantId: input.tenantId,
    analysisId: input.analysisId,
    cameraId: input.cameraId,
    sequence: input.sequence,
    state: 'queued',
    analysisFrameRate: input.analysisFrameRate,
    provenance: {
      capabilityId: input.capabilityId,
      pipelineVersion: ANALYSIS_PIPELINE_VERSION,
    },
    ruleSet: input.ruleSet,
    progress: {
      mediaOffsetSeconds: 0,
      ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
      updatedAt: iso,
    },
    counts: { ...EMPTY_ANALYSIS_COUNTS },
    findings: input.findings,
    requestedBy: input.requestedBy,
    createdAt: iso,
  };
}

export function toSession(doc: AnalysisSessionDoc): AnalysisSession {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    analysisId: doc.analysisId,
    cameraId: doc.cameraId,
    sequence: doc.sequence,
    state: doc.state,
    ...(doc.jobId === undefined ? {} : { jobId: doc.jobId }),
    analysisFrameRate: doc.analysisFrameRate,
    provenance: doc.provenance,
    ruleSet: doc.ruleSet,
    progress: doc.progress,
    counts: doc.counts,
    findings: doc.findings,
    ...(doc.error === undefined ? {} : { error: doc.error }),
    requestedBy: doc.requestedBy,
    createdAt: doc.createdAt,
    ...(doc.startedAt === undefined ? {} : { startedAt: doc.startedAt }),
    ...(doc.finishedAt === undefined ? {} : { finishedAt: doc.finishedAt }),
  };
}

/**
 * ⚠️ Findings the platform can determine about an **asset**, before a frame is decoded.
 *
 * Kept here rather than in the probe adapter so it is a pure function of the measured asset — the
 * thing a test can drive with a value instead of a file.
 */
export function assetFindings(
  asset: AnalysisAsset,
  startSource: FootageStartSource,
): AnalysisFinding[] {
  const out: AnalysisFinding[] = [];
  if (startSource !== 'operator') {
    out.push({
      kind: 'footage-start-assumed',
      detail:
        startSource === 'container-metadata'
          ? "the footage start time was taken from the file's own metadata and has not been confirmed by an operator; every incident time in this analysis depends on it"
          : 'the file carried no creation time, so the upload time was used as the footage start — incident times in this analysis are offsets from the upload, not real clock times',
    });
  }
  /*
   * ⛔ TD-29's procurement finding, applied to an upload. WebKit decodes `hvc1` and genuinely cannot
   * decode `hev1`, so a recording left on `hev1` analyses correctly here and plays back on nothing
   * an iPad user owns. The analysis is fine; the operator's ability to watch it is not.
   */
  if (asset.codec === 'hevc' && (asset.codecTag ?? '').toLowerCase().startsWith('hev1')) {
    out.push({
      kind: 'codec-playback-limited',
      detail:
        'this recording is HEVC tagged hev1. It analyses normally, but Safari and every browser on iOS cannot play it back — the timeline will work and the video will not.',
    });
  }
  return out;
}

/** ⚠️ Refusals a probed asset earns. Returns the reason, or `null` when the asset is acceptable. */
export function rejectAsset(asset: AnalysisAsset): string | null {
  if (asset.bytes > ANALYSIS_LIMITS.maxBytes) {
    return `the file is ${asset.bytes} bytes; the limit is ${ANALYSIS_LIMITS.maxBytes}`;
  }
  if (asset.durationSeconds > ANALYSIS_LIMITS.maxDurationSeconds) {
    return `the recording is ${Math.round(asset.durationSeconds)}s long; the limit is ${ANALYSIS_LIMITS.maxDurationSeconds}s`;
  }
  /*
   * ⚠️ A zero-duration or zero-dimension file probed as a video and has no frames. Refusing it here
   * is the difference between "we could not read that file" and an analysis that succeeds having
   * looked at nothing — the second is the answer this platform must never give.
   */
  if (asset.durationSeconds <= 0) return 'the file contains no playable video (duration is zero)';
  return null;
}
