/**
 * **Offline Video Investigation** — analysing a recording a customer uploaded (P-8 Phase 8).
 *
 * The customer's question is _"here is yesterday's footage — tell me what happened in it"_, and the
 * answer is produced by **exactly the pipeline a live camera uses**: decode → `/infer` → tracking →
 * `capability.output` → events → rules → incident → evidence. Nothing here describes a second
 * inference path, a second tracker or a second rule engine, and if a future change makes it look as
 * though it does, the change is wrong.
 *
 * ### The two records, and why there are two
 *
 * | Record               | Owns                            | Mutable | Answers                                  |
 * | -------------------- | ------------------------------- | ------- | ---------------------------------------- |
 * | **`VideoAnalysis`**  | the **bytes** and their binding | a label | "what footage is this, and whose camera?" |
 * | **`AnalysisSession`** | one **execution**              | ⛔ no   | "what did run number 2 actually do?"      |
 *
 * ⭐ **The session is the unit of investigation, rerun, audit and report.** One upload can be
 * analysed more than once — after a rule is tuned, after a zone is redrawn, after the model is
 * replaced — and each run is a different answer to the same question. Folding them into one record
 * would mean the second run silently overwrote the first, which is the shape of defect this platform
 * keeps finding: a number that changed and nothing recorded that it had.
 *
 * ⚠️ **"Session" is used elsewhere in this platform and this is NOT that.** The AI runtime's
 * `POST /sessions` starts a **live** pipeline against a camera. An `AnalysisSession` is a bounded
 * execution over stored media, owned by the Media context, and the two never appear in the same id
 * space. Two words, two meanings, stated here rather than discovered — the discipline
 * [ADR-0044](../../../../docs/adr/ADR-0044-one-word-two-zones.md) records for `zone`.
 *
 * ### ⚠️ Three clocks, and conflating any two of them makes an investigation wrong
 *
 * | Clock            | Value                                    | Used for                                    |
 * | ---------------- | ---------------------------------------- | ------------------------------------------- |
 * | **Footage time** | `footageStartedAt + mediaOffsetSeconds`  | ⭐ every rule stage, via `occurredAt`       |
 * | **Wall time**    | when the session ran                     | job progress, audit, `Incident.raisedAt`    |
 * | **Media offset** | seconds from the first frame of the file | the timeline, clip ranges, playback seeking |
 *
 * The whole downstream chain is keyed on **event time**: the events service's dedup window, the rule
 * engine's `window` stage, `dwell`, and every cool-down. `services/events` contains no wall clock at
 * all and `dwell.ts` states outright that _"time comes from the event, not from the node"_. So a
 * frame carrying the right `occurredAt` produces the same answer offline as it does live, **at any
 * replay speed** — and a frame carrying `Date.now()` produces an answer wrong by the ratio between
 * replay speed and real time, silently, with no error anywhere.
 *
 * ⚠️ `footageStartedAt` is **the operator's answer**, defaulted from the container's own metadata and
 * never guessed. An incident stamped "today" for footage from last Tuesday is a report that is
 * confidently wrong about when something happened — the same class of defect as TD-20.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

// ---------------------------------------------------------------------------------------------
// The asset — what was uploaded, and what the platform can do with it
// ---------------------------------------------------------------------------------------------

/**
 * Where an analysis's media came from.
 *
 * ⚠️ **Declared now, one implemented now.** `upload` is the P-8 Phase 8 path. The others are named so
 * that adding them later is an adapter behind the same session lifecycle rather than a second
 * ingestion design — the seam that `AnalysisSource` exists to hold open.
 *
 * ⭐ `camera-recording` is the cheapest of them and needs **no upload at all**: the platform already
 * writes segments for every recorded camera, so "analyse this camera between 14:00 and 15:00" is a
 * key range in a bucket the media service already owns.
 */
export const AnalysisSourceKind = z.enum([
  /** An operator uploaded a file. ✅ Implemented. */
  'upload',
  /** ⚠️ Reserved — a time range of this platform's own recorded segments. */
  'camera-recording',
  /** ⚠️ Reserved — a recording exported from a customer's NVR/DVR (vendor containers, TD-27). */
  'device-export',
]);
export type AnalysisSourceKind = z.infer<typeof AnalysisSourceKind>;

/**
 * Containers the platform will **accept**, and what it can actually **decode**.
 *
 * ⚠️ Every value here is storable today. What differs is whether the decoder has been proven against
 * it, and that is stated per container rather than discovered by an operator whose upload silently
 * produced nothing. `ANALYSIS_CONTAINER_SUPPORT` below is the table; the service refuses a container
 * whose `decodable` is false, naming it.
 *
 * ⭐ This mirrors `ZONE_EVALUATION` exactly, and for the same reason: a future container becomes
 * supported by proving it and flipping one flag, with no contract, storage or lifecycle change.
 */
export const AnalysisContainer = z.enum(['mp4', 'mkv', 'mov', 'avi']);
export type AnalysisContainer = z.infer<typeof AnalysisContainer>;

export const ANALYSIS_CONTAINER_SUPPORT: Readonly<
  Record<AnalysisContainer, { decodable: boolean; contentTypes: readonly string[]; needs?: string }>
> = {
  mp4: { decodable: true, contentTypes: ['video/mp4'] },
  mkv: {
    decodable: false,
    contentTypes: ['video/x-matroska'],
    needs:
      'a decode verification against a real Matroska file. ffmpeg handles it; nothing here has proven it, and an unproven container is a silent empty analysis.',
  },
  mov: {
    decodable: false,
    contentTypes: ['video/quicktime'],
    needs:
      'the same verification as mkv. ⚠️ QuickTime carries codecs (ProRes) the runtime has never decoded.',
  },
  avi: {
    decodable: false,
    contentTypes: ['video/x-msvideo'],
    needs:
      'the same verification. ⚠️ AVI has no reliable container-level creation time, so footageStartedAt can never be defaulted for one.',
  },
};

export function isDecodableContainer(container: AnalysisContainer): boolean {
  return ANALYSIS_CONTAINER_SUPPORT[container].decodable;
}

/** Content type → container, for every declared container (accepting is not decoding). */
export const ANALYSIS_CONTENT_TYPES: Readonly<Record<string, AnalysisContainer>> = Object.freeze(
  Object.entries(ANALYSIS_CONTAINER_SUPPORT).reduce<Record<string, AnalysisContainer>>(
    (acc, [container, support]) => {
      for (const ct of support.contentTypes) acc[ct] = container as AnalysisContainer;
      return acc;
    },
    {},
  ),
);

/**
 * What probing the stored object found.
 *
 * ⚠️ Every field is **measured by `ffprobe`**, never taken from what the uploader said. The content
 * type on an upload is a claim; this is the check.
 */
export const AnalysisAsset = z.object({
  /** Storage key, relative to the tenant prefix. ⭐ Generated by the platform, never supplied. */
  key: z.string().min(1),
  /** The operator's file name. ⚠️ Display metadata only — it is never a path. */
  originalName: z.string().min(1).max(300),
  bytes: z.number().int().min(1),
  contentType: z.string().min(1).max(100),
  container: AnalysisContainer,
  /** Video codec as ffprobe names it, e.g. `h264`, `hevc`. */
  codec: z.string().min(1).max(40),
  /** ⚠️ `hev1` vs `hvc1` matters: WebKit decodes `hvc1` and genuinely cannot play `hev1` (TD-29). */
  codecTag: z.string().max(40).optional(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  /** The container's own frame rate, for reference. A session runs at its own `analysisFrameRate`. */
  sourceFrameRate: z.number().min(0),
  durationSeconds: z.number().min(0),
});
export type AnalysisAsset = z.infer<typeof AnalysisAsset>;

// ---------------------------------------------------------------------------------------------
// Findings — what the run could not do, said out loud
// ---------------------------------------------------------------------------------------------

/**
 * ⭐ **Something the session could not do, said out loud.**
 *
 * A session that returns no incidents and no findings is a claim that *nothing happened*. One that
 * returns no incidents **with** a finding is a claim that *we could not tell*. Those are different
 * answers to a customer's question and the platform must never collapse them — the rule ADR-0039
 * applies to a metric, applied one layer up to a whole investigation.
 */
export const AnalysisFindingKind = z.enum([
  /** Frames were shed because the runtime could not keep up. ⛔ The analysis is incomplete. */
  'frames-dropped',
  /** The runtime refused or was unreachable for some frames. */
  'runtime-unavailable',
  /** ⛔ The camera's AI assignment was not in place — nothing would have been analysed (L-54). */
  'assignment-missing',
  /** The codec is playable by the platform but not by every browser (TD-29). */
  'codec-playback-limited',
  /** A detection zone the rules reference is disabled, so it evaluated nothing. */
  'zone-disabled',
  /** ⚠️ No enabled rule covers this camera, so nothing could have been raised whatever happened. */
  'no-rule-covers-camera',
  /** The footage start time was defaulted rather than confirmed by an operator. */
  'footage-start-assumed',
  /** The run stopped at a configured ceiling rather than at the end of the file. */
  'bounded-by-limit',
  /** ⚠️ Dwell thresholds below the event dedup window are bounded by sampling, not by policy (L-57). */
  'dwell-below-dedup-window',
  /**
   * ⭐ **The container's own timestamps and the derived footage offsets disagree** (P-8 Phase 8, 3/9).
   *
   * Every event time in an offline analysis is derived as `(seq − 1) / analysisFrameRate`, which is
   * exactly right for constant-frame-rate footage and wrong for anything else — variable frame rate,
   * a recording with a gap where the NVR dropped out, a concatenated export. The decoder reads the
   * presentation timestamp ffmpeg reports and compares the two, so a divergence is **measured and
   * reported** rather than silently shifting every incident in the file.
   */
  'timestamps-diverged',
  /**
   * ⛔ **The run finished and some of what it saw did not reach durable storage** (Evidence
   * Integrity).
   *
   * When a run ends, the runtime is told so that the identities still in shot are closed and written.
   * This kind is raised when that call could not be made, or when it reported retiring more
   * identities than it managed to write — a full disk, an unwritable volume, a runtime that had
   * already gone.
   *
   * ⚠️ **Its own kind, never folded into `frames-dropped`.** A dropped frame means part of the
   * footage was not looked at; this means part of it *was* looked at and the answer was then lost.
   * An investigator reading a thin timeline has to be able to tell "nothing happened here" from
   * "something happened here and we no longer have it", and only one of those is worth re-running
   * the analysis for.
   */
  'evidence-not-preserved',
]);
export type AnalysisFindingKind = z.infer<typeof AnalysisFindingKind>;

export const AnalysisFinding = z.object({
  kind: AnalysisFindingKind,
  /** Operator-facing sentence. ⚠️ States what it means for the answer, not what the code did. */
  detail: z.string().min(1).max(500),
  /** Where in the footage it applies, when it is not the whole run. */
  atOffsetSeconds: z.number().min(0).optional(),
});
export type AnalysisFinding = z.infer<typeof AnalysisFinding>;

// ---------------------------------------------------------------------------------------------
// The analysis — the bytes and their binding
// ---------------------------------------------------------------------------------------------

/**
 * The **asset** lifecycle, which is not the run lifecycle.
 *
 * ⚠️ `draft` is not a mistake: an analysis exists before its bytes do, so a presigned upload can be
 * scoped to a key nobody else can claim. One that never receives its upload stays `draft` — a
 * different thing from one that failed, and an operator must be able to tell them apart.
 */
export const VideoAnalysisState = z.enum(['draft', 'ready', 'archived']);
export type VideoAnalysisState = z.infer<typeof VideoAnalysisState>;

/** How `footageStartedAt` was arrived at. ⚠️ A defaulted start is a finding, not a silent default. */
export const FootageStartSource = z.enum(['operator', 'container-metadata', 'upload-time']);
export type FootageStartSource = z.infer<typeof FootageStartSource>;

/** A stored investigation: one piece of footage, bound to one camera. */
export const VideoAnalysis = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  /**
   * ⭐ **The camera is not a label.** It carries the detection zones and the rule scope, so an
   * analysis bound to the wrong camera is evaluated against the wrong polygons and the wrong policy.
   * Chosen at creation and immutable afterwards.
   */
  cameraId: z.string().min(1),
  /** Resolved at creation for display, so a report reads without a second lookup. */
  cameraName: z.string().max(200).optional(),
  label: z.string().min(1).max(200).optional(),
  sourceKind: AnalysisSourceKind,
  state: VideoAnalysisState,
  asset: AnalysisAsset.optional(),
  footageStartedAt: IsoDateTime,
  footageStartSource: FootageStartSource,
  /** The most recent session, for the list view. ⚠️ Presentation — sessions are the source of truth. */
  latestSessionId: z.string().min(1).optional(),
  sessionCount: z.number().int().min(0),
  createdBy: z.string().min(1).max(200),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type VideoAnalysis = z.infer<typeof VideoAnalysis>;

// ---------------------------------------------------------------------------------------------
// The session — one immutable execution
// ---------------------------------------------------------------------------------------------

/**
 * A session's lifecycle — richer than `JobState`, deliberately.
 *
 * ⚠️ **`JobState` is frozen at five values and is not extended.** A job is an execution primitive
 * ("is this unit of work outstanding?"); a session is what an operator watches for twenty minutes.
 * They need different vocabularies, so the session carries the operational states and **maps down**
 * to the job's five. Widening the frozen enum to serve one screen would change the meaning of every
 * job in the platform.
 *
 * ⚠️ There is deliberately no `partial`, for the reason `JobState` gives: a half-analysed recording
 * is a **failure that may have produced something**, not a third kind of success. A run that stopped
 * early is `failed` with its counts and a `bounded-by-limit` finding intact.
 */
export const AnalysisSessionState = z.enum([
  /** Recorded, waiting for a worker to claim it. */
  'queued',
  /** A worker holds the lease and is opening the source. ⚠️ No frame has been analysed yet. */
  'starting',
  /** Frames are flowing. */
  'running',
  /**
   * Deliberately halted, resumable from the last checkpoint.
   *
   * ⛔ **Pausing is not free and the contract says so.** The runtime releases a camera's tracking
   * state after an idle period (300 s by default), so a session paused for longer than that resumes
   * with **new identities**: a dwell spanning the pause is split into two shorter visits and may
   * stop crossing its threshold. The resume records a finding rather than pretending continuity.
   */
  'paused',
  /** A transient failure; the worker is backing off before another attempt. Attempts are bounded. */
  'retrying',
  'cancelled',
  'succeeded',
  'failed',
  /**
   * ⚠️ **The worker stopped heartbeating and its lease ran out.**
   *
   * Distinct from `failed`, which is a run that reached a conclusion. `expired` is a run nobody can
   * account for — the process died, the host went away, the container was rescheduled — and the
   * distinction matters because `failed` means "we tried and it did not work" while `expired` means
   * "we do not know what happened", which is the only honest thing to say about a vanished worker.
   */
  'expired',
]);
export type AnalysisSessionState = z.infer<typeof AnalysisSessionState>;

export const TERMINAL_SESSION_STATES: readonly AnalysisSessionState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
];

/** States in which a worker may legitimately hold this session. */
export const CLAIMABLE_SESSION_STATES: readonly AnalysisSessionState[] = ['queued', 'retrying'];

/** States a worker actively owns — the ones a lease expiry must reclaim. */
export const LEASED_SESSION_STATES: readonly AnalysisSessionState[] = [
  'starting',
  'running',
  'paused',
];

/**
 * ⭐ **The session's state, expressed in the frozen job vocabulary.**
 *
 * The mapping is deliberately lossy in one direction only: several session states collapse to
 * `running`, and none of the five job states is unreachable. Keeping it as one function means the
 * two can never drift into disagreeing about whether a job is finished — the failure `verdict_for`
 * exists to prevent one layer down in the certification registry.
 */
export function sessionStateToJobState(
  state: AnalysisSessionState,
): 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'starting':
    case 'running':
    case 'paused':
    case 'retrying':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'expired':
      return 'failed';
  }
}

export function isTerminalSessionState(state: AnalysisSessionState): boolean {
  return TERMINAL_SESSION_STATES.includes(state);
}

/**
 * ⭐ **What produced this answer** — captured when the session starts, never recomputed.
 *
 * A session's incidents are only interpretable against the software that made them. Six months later
 * "why did this run find three and the rerun find one?" is answerable from these fields and from
 * nothing else, because every one of them can change underneath a stored result.
 */
export const AnalysisProvenance = z.object({
  /** The AI runtime's reported version. */
  runtimeVersion: z.string().max(60).optional(),
  /** The capability the frames were sent to, e.g. `perception.person-detection`. */
  capabilityId: z.string().min(1).max(120),
  /** The model the runtime said it ran. ⚠️ Its clock and its answer, not ours. */
  modelId: z.string().max(120).optional(),
  executionProvider: z.string().max(60).optional(),
  /**
   * The media service's own pipeline revision. ⚠️ Bumped when the **decode or timestamping**
   * behaviour changes — the two things that would alter a result without any other field moving.
   */
  pipelineVersion: z.string().min(1).max(40),
});
export type AnalysisProvenance = z.infer<typeof AnalysisProvenance>;

/**
 * ⭐ **The rules that were in force**, snapshotted when the session started.
 *
 * ⚠️ **This is a record, not a selection.** The rule engine evaluates the tenant's enabled rules; it
 * does not take a per-analysis rule list, and giving it one would mean the engine had to know that
 * offline analysis exists — a coupling this milestone deliberately does not create. So the session
 * records **what would have applied**, which is what makes a result reproducible and a report
 * defensible, and the console's "choose your rules" step is the existing rule lifecycle
 * (enable/disable/dry-run) rather than a second one.
 *
 * ⚠️ Selecting a different rule set for a rerun is the reserved `analysis.offline` job kind. It needs
 * a scoped evaluation the engine cannot express today, and it is named here rather than implied.
 */
export const AnalysisRuleSnapshot = z.object({
  ruleId: z.string().min(1),
  ruleName: z.string().min(1).max(200),
  /** The version that was live. An incident from this session cites the same number. */
  version: z.number().int().min(1),
  /** ⚠️ A dry-run rule evaluates fully and raises nothing — the result must say which it was. */
  dryRun: z.boolean(),
  /** Detection zones this rule covered on this camera, for the report. */
  zoneIds: z.array(z.string().min(1)).max(64).default([]),
});
export type AnalysisRuleSnapshot = z.infer<typeof AnalysisRuleSnapshot>;

/** What the run counted. ⚠️ `framesDecoded ≥ framesAnalysed + framesDropped` is the invariant. */
export const AnalysisCounts = z.object({
  framesDecoded: z.number().int().min(0),
  framesAnalysed: z.number().int().min(0),
  /** Frames the sink shed. ⭐ Non-zero means the analysis is **incomplete**, and it is a finding. */
  framesDropped: z.number().int().min(0),
  detections: z.number().int().min(0),
  events: z.number().int().min(0),
  incidents: z.number().int().min(0),
});
export type AnalysisCounts = z.infer<typeof AnalysisCounts>;

export const EMPTY_ANALYSIS_COUNTS: AnalysisCounts = {
  framesDecoded: 0,
  framesAnalysed: 0,
  framesDropped: 0,
  detections: 0,
  events: 0,
  incidents: 0,
};

/**
 * How far through the footage the session is.
 *
 * ⚠️ **`percent` is not a field**, for the reason `JobProgress` gives: a percentage is a derivation
 * and storing it lets the two disagree. `mediaOffsetSeconds` against the asset's duration is the
 * whole of it, and a session that does not yet know its duration reports no progress rather than 0 %.
 */
export const AnalysisProgress = z.object({
  /**
   * ⭐ How far into the footage the decoder has reached — **and the resume checkpoint.**
   *
   * It is one number because it has to be: a checkpoint that could disagree with the progress bar
   * is a resume that starts somewhere the operator was not told about.
   */
  mediaOffsetSeconds: z.number().min(0),
  /** The footage's total length, when known. */
  durationSeconds: z.number().min(0).optional(),
  /** Frames handed to perception so far, across every attempt of this session. */
  framesProcessed: z.number().int().min(0),
  /**
   * ⚠️ **Frames per second of WALL CLOCK — throughput, not the analysis rate.**
   *
   * `analysisFrameRate` is how densely the footage is sampled and is configuration; this is how fast
   * the platform is getting through it and is a measurement. Naming them both "fps" on one screen is
   * how an operator concludes the analysis is running at the wrong rate.
   *
   * ⛔ `null` until enough samples exist to mean anything — never `0`, which reads as "stalled".
   */
  throughputFps: z.number().min(0).nullable(),
  /**
   * ⭐ Footage-seconds analysed per wall-clock second. A live camera runs at 1.0 by definition; an
   * offline session above 1.0 is running faster than real time, which is the point of it.
   */
  speedFactor: z.number().min(0).nullable(),
  /**
   * Estimated seconds remaining.
   *
   * ⛔ **`null` with a reason, never a fabricated number** ([ADR-0039]). An ETA computed from three
   * frames is a guess wearing a number's clothes, and an operator plans around it. It stays absent
   * until the measurement window has filled and the duration is known — and `etaUnavailableReason`
   * says which of those is missing.
   */
  etaSeconds: z.number().min(0).nullable(),
  etaUnavailableReason: z.string().max(200).optional(),
  updatedAt: IsoDateTime,
});
export type AnalysisProgress = z.infer<typeof AnalysisProgress>;

/**
 * ⭐ **The lease a worker holds, and the whole of what makes multi-worker execution safe.**
 *
 * Claiming is a conditional write against `(state, leaseExpiresAt)`, so two workers racing for the
 * same session cannot both win. A worker that dies stops renewing; the lease lapses; a sweeper moves
 * the session to `expired` and it becomes claimable again.
 *
 * ⚠️ **The lease is what makes "at most one worker" true — not the claim check.** The same lesson
 * the session-sequence unique index taught: a read-then-write is not exclusion, and only a
 * conditional write or a unique constraint is.
 */
export const AnalysisLease = z.object({
  /** Which worker holds it. ⚠️ Stable per process, so a stale lease names what to go and look at. */
  workerId: z.string().min(1).max(120),
  /** Last time the worker said it was alive. */
  heartbeatAt: IsoDateTime,
  /** After this instant the lease may be taken. */
  expiresAt: IsoDateTime,
  /** Attempts made on this session, including the current one. Bounded — see `ANALYSIS_LIMITS`. */
  attempt: z.number().int().min(1),
});
export type AnalysisLease = z.infer<typeof AnalysisLease>;

/**
 * Replay speed, as a multiple of real time.
 *
 * ⚠️ Bounded at both ends for honest reasons rather than defensive ones. Below `0.1` a four-hour
 * recording takes forty hours and the session outlives any plausible lease; above `256` the number
 * stops describing anything, because no runtime on any hardware this platform targets can consume
 * frames that fast and the session would simply run unpaced while claiming a figure.
 */
export const ANALYSIS_SPEED = z.number().min(0.1).max(256);

/** ⛔ **Immutable once terminal.** One execution of one analysis. */
export const AnalysisSession = z.object({
  id: z.string().min(1),
  tenantId: TenantId,
  analysisId: z.string().min(1),
  /** Denormalised so a session reads on its own in a report. Immutable, like the analysis's binding. */
  cameraId: z.string().min(1),
  /** Monotonic within an analysis: run 1, run 2, … ⭐ What a rerun is identified by. */
  sequence: z.number().int().min(1),
  state: AnalysisSessionState,
  /** The `ai.analyse` job that carries it. */
  jobId: z.string().min(1).optional(),
  /** Frames per second **of footage** handed to perception. */
  analysisFrameRate: z.number().min(0.1).max(30),
  /**
   * ⭐ **Footage seconds per wall-clock second, or `null` for as fast as the runtime allows.**
   *
   * ⚠️ **This changes when the answer arrives and never what the answer is**, and that is not a
   * hope — it is the milestone's central acceptance criterion. Every downstream decision (dedup,
   * `window`, `dwell`, every cool-down) is keyed on `occurredAt`, which is **footage** time derived
   * from the frame's position in the file. Wall clock reaches nothing that decides anything.
   *
   * ⛔ The verification that holds this true is a byte-for-byte comparison of two runs of the same
   * file at different speeds — detections, tracks, identities, dwell state, rule evaluations, events
   * and incidents. Any divergence is a defect in this platform, not a tolerance to be widened.
   *
   * `1` is real time, which is what Demonstration Mode watches; `null` is what an investigation
   * wants, because an operator waiting on four hours of footage does not want it to take four hours.
   */
  speed: ANALYSIS_SPEED.nullable(),
  provenance: AnalysisProvenance,
  ruleSet: z.array(AnalysisRuleSnapshot).max(200),
  progress: AnalysisProgress,
  counts: AnalysisCounts,
  /** Present while a worker holds this session, and left in place afterwards as the audit trail. */
  lease: AnalysisLease.optional(),
  findings: z.array(AnalysisFinding).max(50),
  /** Present when `state` is `failed` — the operator-facing reason. */
  error: z.string().max(500).optional(),
  requestedBy: z.string().min(1).max(200),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
});
export type AnalysisSession = z.infer<typeof AnalysisSession>;

// ---------------------------------------------------------------------------------------------
// Inputs and views
// ---------------------------------------------------------------------------------------------

/**
 * Create an analysis and claim an upload slot.
 *
 * ⚠️ The bytes are **not** in this request. A multi-gigabyte multipart POST through the edge and the
 * gateway would buffer a customer's video in three processes and hold a JWT-authorised connection
 * open for a quarter of an hour; the object store is signed for directly instead (ADR-0036 decided
 * the browser may talk to it, and the edge already serves it same-origin, so there is no CORS and no
 * second origin).
 */
export const CreateVideoAnalysisInput = z.object({
  cameraId: z.string().min(1),
  label: z.string().min(1).max(200).optional(),
  originalName: z.string().min(1).max(300),
  contentType: z.string().min(1).max(100),
  /** Declared size, checked against the ceiling **before** a byte is uploaded. */
  bytes: z.number().int().min(1),
  /** ⚠️ Omitted → defaulted from the container and reported as a finding. */
  footageStartedAt: IsoDateTime.optional(),
});
export type CreateVideoAnalysisInput = z.infer<typeof CreateVideoAnalysisInput>;

/** The analysis plus the one-shot, key-scoped, short-lived URL its bytes go to. */
export const VideoAnalysisUpload = z.object({
  analysis: VideoAnalysis,
  uploadUrl: z.string().min(1),
  /** ⚠️ The browser must send exactly this method and content type, or the signature will not match. */
  method: z.literal('PUT'),
  contentType: z.string().min(1),
  expiresAt: IsoDateTime,
});
export type VideoAnalysisUpload = z.infer<typeof VideoAnalysisUpload>;

/** Confirm the upload landed: the service probes the object and refuses what it cannot decode. */
export const ConfirmVideoAnalysisInput = z.object({
  /** Re-confirm the footage start once the operator has seen the file's own metadata. */
  footageStartedAt: IsoDateTime.optional(),
});
export type ConfirmVideoAnalysisInput = z.infer<typeof ConfirmVideoAnalysisInput>;

/** Start a session. ⭐ Called again on the same analysis, this is a **rerun**. */
export const StartAnalysisSessionInput = z.object({
  /** Frames per second of footage. Omitted → the deployment's configured rate. */
  analysisFrameRate: z.number().min(0.1).max(30).optional(),
  /**
   * How fast to work through the footage. Omitted → as fast as the runtime allows.
   *
   * ⚠️ Sent as `null` for "unpaced" so the field can be set back to it explicitly; see
   * `AnalysisSession.speed` for why this changes **when** an answer arrives and never **what** it is.
   */
  speed: ANALYSIS_SPEED.nullable().optional(),
});
export type StartAnalysisSessionInput = z.infer<typeof StartAnalysisSessionInput>;

export const VideoAnalysisQuery = z.object({
  cameraId: z.string().min(1).optional(),
  state: VideoAnalysisState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type VideoAnalysisQuery = z.infer<typeof VideoAnalysisQuery>;

export const VideoAnalysisPage = z.object({
  items: z.array(VideoAnalysis),
  nextCursor: z.string().optional(),
});
export type VideoAnalysisPage = z.infer<typeof VideoAnalysisPage>;

/** An analysis with its sessions — the investigation detail view. */
export const VideoAnalysisDetail = z.object({
  analysis: VideoAnalysis,
  /** Newest first. */
  sessions: z.array(AnalysisSession),
});
export type VideoAnalysisDetail = z.infer<typeof VideoAnalysisDetail>;

/** A signed URL for the source recording, so the operator can watch what was analysed. */
export const VideoAnalysisPlayback = z.object({
  url: z.string().min(1),
  contentType: z.string().min(1),
  expiresAt: IsoDateTime,
  /** ⚠️ Present when the codec plays here but not everywhere — the operator is told which (TD-29). */
  playbackWarning: z.string().max(300).optional(),
});
export type VideoAnalysisPlayback = z.infer<typeof VideoAnalysisPlayback>;

/** Limits. ⚠️ **Stated rather than implicit**: a refusal must be able to name the number it broke. */
export const ANALYSIS_LIMITS = {
  /** Upload ceiling in bytes (2 GiB). Refused at create, before a byte moves. */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** Longest recording accepted, seconds (4 hours). */
  maxDurationSeconds: 4 * 60 * 60,
  /** Upload URL lifetime. Long enough for a slow connection, short enough to matter. */
  uploadTtlSeconds: 3600,
  /** Sessions retained per analysis before the oldest is refused rather than silently dropped. */
  maxSessionsPerAnalysis: 20,
  /**
   * How long a worker's claim survives without a heartbeat.
   *
   * ⚠️ Long enough that an ordinary GC pause or a slow chunk cannot lose a lease, short enough that
   * a dead worker's session does not sit unclaimable for minutes. Reclaiming a **live** worker's
   * session runs the analysis twice — two workers pushing the same footage through one camera's
   * tracker; never reclaiming a **dead** one's strands it for ever. The second is the failure an
   * operator actually meets, so the window errs short.
   */
  leaseSeconds: 60,
  /** Heartbeat interval. Divides `leaseSeconds` with room for a missed beat. */
  heartbeatSeconds: 15,
  /**
   * Attempts per session before it stops being retried.
   *
   * ⛔ Bounded on purpose. An unbounded retry against a recording that cannot be decoded is a worker
   * that never does anything else, and from outside it is indistinguishable from a busy queue.
   */
  maxAttempts: 3,
  /**
   * Footage seconds per chunk.
   *
   * ⭐ Chunking buys three things: progress that moves, cancellation that lands within a second
   * rather than at the end of a four-hour file, and a checkpoint to resume from. It costs one
   * decoder start per chunk, which is why it is minutes rather than seconds.
   */
  chunkSeconds: 120,
} as const;

/**
 * The media pipeline revision recorded on every session.
 *
 * ⚠️ **Bump this when decode or frame timestamping changes**, and only then. It exists so that a
 * result whose numbers moved can be traced to the change that moved them; bumping it for unrelated
 * edits makes it noise, and never bumping it makes it a lie.
 */
export const ANALYSIS_PIPELINE_VERSION = '1.0.0';
