/**
 * Background job contracts (P-5.2.0, Architect rec 4) — **an abstraction, not a service**.
 *
 * The instruction: operations that should never block the UI (PDF generation, evidence export, ZIP
 * packaging, large reports, bulk exports, scheduled reports) execute as background jobs with
 * progress reporting.
 *
 * ### ⚠️ Where the work runs, given that no new service may be created
 *
 * A job is **owned by the context that produces its artefact**: the Workflow service builds
 * incident reports, the Evidence service packages evidence, the Media service materialises clips.
 * This contract is the shared vocabulary — the record shape, the states, the progress semantics —
 * and each service runs its own worker over its own collection. A central job service would need
 * read access to every context's data to do the work, which is the one thing bounded contexts
 * exist to prevent.
 *
 * ### ⚠️ Four failure modes this shape is designed against
 *
 * **1. The eternal spinner.** A worker that dies mid-job leaves `running` forever, and the console
 * shows progress that will never move. Every claimed job carries a **lease** with an expiry; an
 * expired lease is reclaimable, and a job whose lease lapsed is `failed` with a stated reason
 * rather than permanently in flight.
 *
 * **2. The stored signed URL.** `JobResult` holds a **storage key, never a URL**. A signed URL
 * written into a job record outlives its own expiry — it is a broken link at best, and at worst a
 * credential sitting in a queryable collection long after the download it authorised. The URL is
 * minted per request, short-lived, and its issue is an audited access.
 *
 * **3. The double-click that costs 400 MB.** Every submission carries a `requestKey`; a repeat
 * submission returns the existing job rather than starting a second export of the same thing.
 *
 * **4. Progress that reports zero when it means unknown.** `total` is optional, and a percentage is
 * derivable **only** when it is present. A job that cannot count its work reports what it has done
 * and says nothing about how much remains — CONSTRAINTS §53, on a progress bar.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId, Uuid } from '../common/primitives.js';

/**
 * What a job does. **Extends additively.** Each value names an artefact-producing operation that is
 * too slow to hold an HTTP request open.
 */
export const JobKind = z.enum([
  /** Render an investigation report from a `ReportModel` (PDF, HTML or JSON). */
  'report.render',
  /** Package one incident's evidence — manifests, media and custody log — as an archive. */
  'evidence.package',
  /** Export a bounded query's results as a file. */
  'export.bulk',
  /** Cut a standalone media file for a `Clip` that is currently a time-range reference. */
  'clip.materialise',
  // ---------------------------------------------------------------------------------------------
  // Reserved (P-5.2 rec 7). **No worker submits or handles these.** Reserving a job *kind* is safe
  // in a way that reserving a query filter is not (§58): an unsubmitted kind simply never appears,
  // whereas an unpopulated filter always matches nothing while looking like it works.
  // ---------------------------------------------------------------------------------------------
  /** Ingest an operator-supplied file or archive. ⚠️ Reserved — the upload path is TD-9 G-2. */
  'import.bulk',
  /** Run a capability over stored media out of band. ⚠️ Reserved — AI Runtime v1.0 is closed; this
   * submits work to the existing runtime and adds no new inference architecture. */
  'ai.analyse',
  /** Re-derive analytics over a historical window. ⚠️ Reserved. */
  'analysis.offline',
  /** Render media: transcode, stitch, burn in an overlay. ⚠️ Reserved — output is always a **new**
   * artefact; nothing here rewrites stored evidence. */
  'media.render',
]);
export type JobKind = z.infer<typeof JobKind>;

/** Which service runs it (see the header). Recorded so an operator can be told where it is stuck. */
export const JobOwner = z.enum(['workflow', 'evidence', 'media']);
export type JobOwner = z.infer<typeof JobOwner>;

/**
 * Job lifecycle.
 *
 * ⚠️ There is deliberately no `partial`. A half-finished export is a **failure** that may have
 * produced something — expressed as `failed` with a `result` present, not as a third success state.
 * "Partly succeeded" is where people put the archive that is missing four clips and hand it to a
 * regulator.
 */
export const JobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;

/** Terminal states — nothing may be appended after one is reached (CONSTRAINTS §57). */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.includes(state);
}

/**
 * How far along a job is.
 *
 * ⚠️ `total` is optional and `percent` is **not a field**. A percentage is a derivation from
 * `completed / total`, and storing it lets the two disagree; more importantly, a job that does not
 * know its total must not report `0%`, because an operator reads that as "nothing has happened".
 */
export const JobProgress = z.object({
  /** Units of work finished — files packaged, pages rendered. Monotonic. */
  completed: z.number().int().min(0),
  /** Total units, **when known**. Absent ⇒ indeterminate, and the UI shows an indeterminate bar. */
  total: z.number().int().min(0).optional(),
  /** What it is doing right now, in operator words. */
  message: z.string().max(300).optional(),
  updatedAt: IsoDateTime,
});
export type JobProgress = z.infer<typeof JobProgress>;

/** Percent complete, or `undefined` when the job cannot know it. Never returns a fabricated 0. */
export function jobPercent(progress: JobProgress): number | undefined {
  if (progress.total === undefined || progress.total === 0) return undefined;
  return Math.min(100, Math.round((progress.completed / progress.total) * 100));
}

/**
 * What a finished job produced.
 *
 * ⚠️ **`storageKey`, never a URL** (failure mode 2). `expiresAt` is the artefact's own retention —
 * an export is a copy of regulated data and does not live forever by default.
 */
export const JobResult = z.object({
  /** Opaque tenant-relative object key. Resolve to a signed URL per download. */
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** SHA-256 of the artefact, so a downloaded export can be verified against what was produced. */
  sha256: z.string().min(1).optional(),
  /** When the artefact is purged. Absent ⇒ retained under the tenant's default policy. */
  expiresAt: IsoDateTime.optional(),
});
export type JobResult = z.infer<typeof JobResult>;

/** Why a job failed, in a form a support engineer can act on. */
export const JobError = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(1000),
  /** True when re-submitting is likely to work (a timeout, a transient upstream). */
  retryable: z.boolean(),
  at: IsoDateTime,
});
export type JobError = z.infer<typeof JobError>;

/**
 * One background job.
 *
 * `input` is opaque here on purpose: typing it as a union of every job's parameters would make this
 * contract depend on the report model, the evidence query and the clip range at once, and every new
 * job kind would edit a shared type. The owning service parses `input` against its own schema.
 */
export const Job = z.object({
  id: Uuid,
  tenantId: TenantId,
  kind: JobKind,
  owner: JobOwner,
  state: JobState,
  /**
   * ⚠️ The idempotency key (failure mode 3). Unique per tenant per kind: a second submission with
   * the same key returns the first job. Derived from the request's meaningful parameters, so the
   * caller cannot accidentally make two identical exports distinct.
   */
  requestKey: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  progress: JobProgress.optional(),
  result: JobResult.optional(),
  error: JobError.optional(),
  /** Who asked for it. A job is always attributable — exports especially. */
  requestedBy: z.string().min(1),
  /**
   * ⚠️ The lease (failure mode 1). Set when a worker claims the job; a `running` job whose
   * `leaseExpiresAt` has passed is reclaimable, and repeated reclaims fail it rather than looping.
   */
  leaseExpiresAt: IsoDateTime.optional(),
  attempts: z.number().int().min(0).default(0),
  queuedAt: IsoDateTime,
  startedAt: IsoDateTime.optional(),
  finishedAt: IsoDateTime.optional(),
  updatedAt: IsoDateTime,
});
export type Job = z.infer<typeof Job>;

/** Submit a job. The service derives `requestKey` when the caller does not supply one. */
export const SubmitJobInput = z.object({
  kind: JobKind,
  input: z.record(z.string(), z.unknown()).default({}),
  requestKey: z.string().min(1).max(200).optional(),
});
export type SubmitJobInput = z.infer<typeof SubmitJobInput>;

/** Tenant-scoped job query (newest-first). Every filter is index-backed before it is exposed (§40). */
export const JobQuery = z.object({
  kind: JobKind.optional(),
  state: JobState.optional(),
  requestedBy: z.string().min(1).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});
export type JobQuery = z.infer<typeof JobQuery>;

export const JobPage = z.object({
  items: z.array(Job).default([]),
  nextCursor: z.string().min(1).optional(),
});
export type JobPage = z.infer<typeof JobPage>;

/**
 * A recurring job definition (scheduled reports).
 *
 * ⚠️ **A schedule is not a job.** The recommendation listed "scheduled reports" beside the one-off
 * operations, and modelling them as one record produces something that is simultaneously a thing
 * that ran and a thing that will run — with a `state` that cannot answer either question. A
 * schedule *produces* jobs; each run is an ordinary `Job` carrying `scheduleId`.
 *
 * ⚠️ **Frozen, with no runner.** Nothing evaluates `cron` today. It is declared so the shape is
 * settled before something depends on it — not so it can be quietly switched on.
 */
export const JobSchedule = z.object({
  id: Uuid,
  tenantId: TenantId,
  name: z.string().min(1).max(120),
  kind: JobKind,
  input: z.record(z.string(), z.unknown()).default({}),
  /** Standard five-field cron. Evaluated in `timezone`, because "9am" is a local claim. */
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(80),
  enabled: z.boolean().default(false),
  /** Derived from the run history, never stored as a countdown that can drift. */
  lastRunAt: IsoDateTime.optional(),
  createdBy: z.string().min(1),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type JobSchedule = z.infer<typeof JobSchedule>;
