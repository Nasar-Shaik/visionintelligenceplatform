/**
 * Application: incident lifecycle use-cases — the single place lifecycle logic lives (both the
 * candidate promoter and the HTTP transition routes call through here). `promote` is idempotent
 * (a repeat candidate for the same dedupKey collapses into the already-raised incident, never a
 * duplicate). `acknowledge`/`resolve`/`close` validate the transition against the domain state
 * machine (illegal → 409), persist with optimistic concurrency, publish the lifecycle event, and
 * record a metric. Incidents are never created via the API — only promoted from a candidate.
 */
import type {
  AcknowledgeIncidentInput,
  IncidentActorRef,
  IncidentSlaPolicy,
  IncidentSlaStatus,
  IncidentTimeline,
  IncidentTimelineSource,
  AddIncidentNoteInput,
  AssignIncidentInput,
  CloseIncidentInput,
  EscalateIncidentInput,
  Incident,
  IncidentActivity,
  IncidentCandidate,
  IncidentPage,
  IncidentQuery,
  InvestigateIncidentInput,
  ResolveIncidentInput,
  EvidenceChain,
  CreatePlaybackBookmarkInput,
  PlaybackBookmark,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { canApply, isTerminal, type IncidentAction } from '../domain/incident-state.js';
import {
  appendNote,
  applyAssignment,
  applyTransition,
  promoteFromCandidate,
  type TransitionInput,
} from '../domain/incident-factory.js';
import { deriveActivity } from '../domain/incident-activity.js';
import {
  buildTimeline,
  MAX_ENTRIES_PER_SOURCE,
  UPSTREAM_TIMEOUT_MS,
  type RelatedEvidence,
  type TimelineInputs,
} from '../domain/incident-timeline.js';
import { buildChain, type ChainInputs } from '../domain/incident-chain.js';
import { deriveSla, policyFor } from '../domain/incident-sla.js';
import { assertMayMutate, operatorActor } from '../domain/incident-actor.js';
import { conflict, notFound } from './errors.js';
import {
  UnavailableTimelineSources,
  type IncidentStore,
  type TimelineCaller,
  type TimelineSources,
} from './ports.js';
import { NoopIncidentPublisher, type IncidentPublisher } from './incident-publisher.js';
import type { IncidentMetrics } from './metrics.js';
import type { BookmarkStore } from './bookmark-store.js';

export interface IncidentServiceDeps {
  store: IncidentStore;
  publisher?: IncidentPublisher;
  metrics?: IncidentMetrics;
  /** The timeline joins. Defaults to every source unavailable — a named gap, never a silent empty. */
  sources?: TimelineSources;
  /** Deployment-configured SLA targets. Empty is the honest default: no policy ⇒ `unknown`. */
  slaPolicies?: readonly IncidentSlaPolicy[];
  /** Investigation bookmarks (P-5.5). Absent ⇒ the surface reports `not-built` rather than empty. */
  bookmarks?: BookmarkStore;
  now?: () => Date;
  newId?: () => string;
}

export interface PromotionResult {
  incident: Incident;
  created: boolean;
}

/**
 * How many notes one incident may carry (P-5.0 G-2).
 *
 * Notes are embedded in the incident document, so this is a real ceiling, not a preference: at
 * 4,000 characters each, 500 notes is roughly 2 MB against MongoDB's 16 MB document limit, leaving
 * room for the transition and assignment streams. An incident that hits it is an incident that
 * should have been a case — which is the Workflow-engine feature this slice deliberately does not
 * build (TD-8). Exceeding it is a 409 with a clear message, not a silent truncation.
 */
export const MAX_NOTES = 500;

/**
 * Every write path takes `actor?: ActorArg` (P-5.1, F-2).
 *
 * A bare string is what every caller before P-5.1 passed, and it always meant "the principal id of
 * the human who made this request" — so it normalises to an `operator`, which is the one inference
 * that is not a guess. Anything else (the promoter, an automation, an integration) passes a typed
 * ref and says what it is.
 */
export type ActorArg = string | IncidentActorRef;

function normalizeActor(actor: ActorArg | undefined): IncidentActorRef | undefined {
  if (actor === undefined) return undefined;
  return typeof actor === 'string' ? operatorActor(actor) : actor;
}

export class IncidentService {
  private readonly store: IncidentStore;
  private readonly publisher: IncidentPublisher;
  private metrics: IncidentMetrics | undefined;
  private readonly sources: TimelineSources;
  private readonly slaPolicies: readonly IncidentSlaPolicy[];
  private readonly bookmarks: BookmarkStore | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: IncidentServiceDeps) {
    this.store = deps.store;
    this.publisher = deps.publisher ?? NoopIncidentPublisher;
    this.metrics = deps.metrics;
    this.sources = deps.sources ?? UnavailableTimelineSources;
    this.slaPolicies = deps.slaPolicies ?? [];
    this.bookmarks = deps.bookmarks;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Attach the metrics collaborator after construction — the Prometheus registry only exists once
   * the server is built, but the same service instance is shared by the HTTP routes and the promoter.
   */
  useMetrics(metrics: IncidentMetrics): void {
    this.metrics = metrics;
  }

  private get factoryDeps() {
    return { now: this.now, newId: this.newId };
  }

  /**
   * Idempotently promote a candidate into a raised incident. If an incident already exists for the
   * candidate's dedup key, it is returned unchanged (created=false) and `incident.raised` is NOT
   * re-published — the burst has already been raised once.
   */
  async promote(scope: TenantScope, candidate: IncidentCandidate): Promise<PromotionResult> {
    this.metrics?.candidatesConsumed.inc();
    const endTimer = this.metrics?.promotionDuration.startTimer();
    try {
      const existing = await this.store.getByDedupKey(scope, candidate.dedupKey);
      if (existing) {
        this.metrics?.candidatesDeduplicated.inc();
        return { incident: existing, created: false };
      }
      const incident = promoteFromCandidate(candidate, this.factoryDeps);
      try {
        await this.store.insert(scope, incident);
      } catch (err) {
        // Lost a race on the unique (tenant,dedupKey) index — treat as already promoted.
        const raced = await this.store.getByDedupKey(scope, candidate.dedupKey);
        if (raced) {
          this.metrics?.candidatesDeduplicated.inc();
          return { incident: raced, created: false };
        }
        throw err;
      }
      this.metrics?.incidentsRaised.inc({ severity: incident.severity });
      await this.publisher.publish(incident);
      return { incident, created: true };
    } finally {
      endTimer?.();
    }
  }

  get(scope: TenantScope, id: string): Promise<Incident | null> {
    return this.store.get(scope, id);
  }

  async getOrThrow(scope: TenantScope, id: string): Promise<Incident> {
    const incident = await this.store.get(scope, id);
    if (!incident) throw notFound(`incident ${id} not found`);
    return incident;
  }

  list(scope: TenantScope, query: IncidentQuery): Promise<IncidentPage> {
    return this.store.list(scope, query);
  }

  async acknowledge(
    scope: TenantScope,
    id: string,
    input: AcknowledgeIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    return this.transition(scope, id, 'acknowledge', { ...who(actor), note: input.note });
  }

  async resolve(
    scope: TenantScope,
    id: string,
    input: ResolveIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    return this.transition(scope, id, 'resolve', {
      ...who(actor),
      resolution: input.resolution,
    });
  }

  async close(
    scope: TenantScope,
    id: string,
    input: CloseIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    return this.transition(scope, id, 'close', { ...who(actor), note: input.note });
  }

  /** Begin investigating (P-5.0 G-1). */
  async investigate(
    scope: TenantScope,
    id: string,
    input: InvestigateIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    return this.transition(scope, id, 'investigate', { ...who(actor), note: input.note });
  }

  /** Escalate, recording who now owns the outcome (P-5.0 G-1). */
  async escalate(
    scope: TenantScope,
    id: string,
    input: EscalateIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    return this.transition(scope, id, 'escalate', {
      ...who(actor),
      note: input.note,
      escalateTo: input.to,
    });
  }

  /**
   * Assign or un-assign (P-5.0 G-2). **Not a lifecycle transition** — the status is untouched, so
   * assigning a raised incident leaves it raised and the two facts stay independent.
   */
  async assign(
    scope: TenantScope,
    id: string,
    input: AssignIncidentInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    this.refuseIfSealed(current, 'assign');
    const next = applyAssignment(
      current,
      { to: input.assignee ?? undefined, ...who(actor), note: input.note },
      this.factoryDeps,
    );
    await this.persist(scope, next, current.version);
    this.metrics?.assignments.inc({ kind: input.assignee === null ? 'unassign' : 'assign' });
    return next;
  }

  /**
   * Append an operator note (P-5.0 G-2). Immutable once written — there is no edit and no delete,
   * because an investigation record that can be rewritten is not a record.
   */
  async addNote(
    scope: TenantScope,
    id: string,
    input: AddIncidentNoteInput,
    actor?: ActorArg,
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    this.refuseIfSealed(current, 'comment on');
    if (current.notes.length >= MAX_NOTES) {
      throw conflict(`incident ${id} has reached the ${MAX_NOTES}-note limit`);
    }
    const next = appendNote(
      current,
      { body: input.body, ...who(actor), attachments: input.attachments },
      this.factoryDeps,
    );
    await this.persist(scope, next, current.version);
    this.metrics?.notesAdded.inc();
    return next;
  }

  // --- Investigation bookmarks (P-5.5) ----------------------------------------------------------

  /**
   * ⚠️ **Absent store ⇒ refuse, never an empty list.** A deployment with no bookmark collection
   * wired would otherwise return `[]`, which an operator reads as "I have not bookmarked anything"
   * — and they would go on not-bookmarking things into a void. §44: a check that could not run is
   * not a check that passed.
   */
  private bookmarkStoreOrThrow(): BookmarkStore {
    if (this.bookmarks === undefined) {
      throw conflict('bookmarks are not configured in this deployment');
    }
    return this.bookmarks;
  }

  get bookmarksConfigured(): boolean {
    return this.bookmarks !== undefined;
  }

  /**
   * Save a moment.
   *
   * ⚠️ Refused on a sealed incident, exactly as a note is: a closed investigation that can still
   * acquire navigational markers is a closed investigation that still changes (§57).
   */
  async addBookmark(
    scope: TenantScope,
    incidentId: string,
    input: CreatePlaybackBookmarkInput,
    actor?: ActorArg,
  ): Promise<PlaybackBookmark> {
    const store = this.bookmarkStoreOrThrow();
    const incident = await this.getOrThrow(scope, incidentId);
    this.refuseIfSealed(incident, 'bookmark');

    const bookmark: PlaybackBookmark = {
      id: this.newId(),
      tenantId: scope.tenantId,
      incidentId,
      source: input.source,
      at: input.at,
      label: input.label,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      /*
       * ⚠️ Defaulted here, not only in the schema. The route parses `CreatePlaybackBookmarkInput`
       * and so supplies it — but a caller constructing the input in code would not, and a bookmark
       * stored with no visibility is a bookmark whose sharing was decided by whichever reader
       * applied a default. Fail closed to `private`.
       */
      visibility: input.visibility ?? 'private',
      createdBy: normalizeActor(actor)?.id ?? 'unknown',
      createdAt: this.now().toISOString(),
    };
    await store.insert(scope, bookmark);
    return bookmark;
  }

  /**
   * List an incident's bookmarks, oldest first.
   *
   * ⚠️ `offsetSeconds` is **never returned from storage**. `at` is the authority; an offset is
   * meaningless the moment a session is derived over a different range, which happens as soon as
   * somebody opens the bookmark from another starting point.
   */
  async listBookmarks(
    scope: TenantScope,
    incidentId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<{ items: PlaybackBookmark[]; nextCursor?: string | undefined }> {
    const store = this.bookmarkStoreOrThrow();
    await this.getOrThrow(scope, incidentId);
    return store.list(scope, {
      incidentId,
      limit: options.limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    });
  }

  /** Remove a bookmark. Returns false when nothing matched, so the route answers 404 honestly. */
  async removeBookmark(scope: TenantScope, id: string, actor?: ActorArg): Promise<boolean> {
    const store = this.bookmarkStoreOrThrow();
    return store.remove(scope, id, normalizeActor(actor)?.id ?? 'unknown');
  }

  /** The derived activity log — transitions + assignments + notes, oldest first (P-5.0 G-2). */
  async activity(scope: TenantScope, id: string): Promise<IncidentActivity> {
    return deriveActivity(await this.getOrThrow(scope, id), this.now());
  }

  /**
   * The full investigation timeline (P-5.1, F-3) — the incident's own streams plus bounded joins
   * from the contexts that own the rest.
   *
   * ⚠️ **At most one call per requested source, and a failure is a gap rather than an error.** The
   * whole read succeeds with fewer entries and an honest account of what is missing; an operator
   * looking at a partial timeline must be able to see that it is partial. Each call is raced
   * against a timeout, because a hanging upstream would otherwise turn a bounded read into an
   * unbounded one.
   */
  async timeline(
    scope: TenantScope,
    id: string,
    include: readonly IncidentTimelineSource[] = [],
    caller?: TimelineCaller,
  ): Promise<IncidentTimeline> {
    const incident = await this.getOrThrow(scope, id);
    const failures: {
      source: IncidentTimelineSource;
      reason: 'unavailable' | 'forbidden';
      detail: string;
    }[] = [];

    const bounded = async <T>(
      source: IncidentTimelineSource,
      run: () => Promise<{ items: T[]; truncated: boolean }>,
    ): Promise<{ items: T[]; truncated: boolean } | undefined> => {
      if (!include.includes(source)) return undefined;
      try {
        return await withTimeout(run(), UPSTREAM_TIMEOUT_MS, source);
      } catch (err) {
        /*
         * ⚠️ A 403 is not an outage. The joins run under the caller's own permissions (see
         * `HttpTimelineSources`), so "you may not read that context" is a routine answer — and
         * reporting it as `unavailable` would send an operator to an engineer for something a role
         * grant fixes.
         */
        const forbidden =
          typeof err === 'object' && err !== null && 'forbidden' in err && err.forbidden === true;
        failures.push({
          source,
          reason: forbidden ? 'forbidden' : 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    };

    // Sequential rather than concurrent on purpose: three bounded reads are cheap, and a timeline
    // request that fans out in parallel multiplies a retry storm across three neighbours at once.
    const events = await bounded('events', () =>
      this.sources.relatedEvents(scope, incident.correlationId, MAX_ENTRIES_PER_SOURCE, caller),
    );
    const evidence = await bounded('evidence', () =>
      this.sources.relatedEvidence(
        scope,
        incident.id,
        incident.correlationId,
        MAX_ENTRIES_PER_SOURCE,
        caller,
      ),
    );
    const automation = await bounded('notify', () =>
      this.sources.relatedAutomation(scope, incident.id, MAX_ENTRIES_PER_SOURCE, caller),
    );

    const inputs: TimelineInputs = {
      incident,
      requested: include,
      failures,
      now: this.now(),
    };
    if (events) inputs.events = events;
    if (evidence) inputs.evidence = evidence;
    if (automation) inputs.automation = automation;
    return buildTimeline(inputs);
  }

  /**
   * The evidence chain (P-5.3, rec 7) — camera → detection → rule → incident → evidence → playback
   * → export → report, derived.
   *
   * ⚠️ **One upstream call, not eight.** Four stages come from the incident document itself (it
   * carries the camera, the triggering event and the rule as provenance copied at promotion), three
   * have no producer at all, and only evidence needs a read — the same bounded, caller-scoped read
   * the timeline makes. A chain that resolved every stage by fetching would be eight fan-outs on a
   * panel, which is the shape §54 exists to prevent.
   */
  async chain(scope: TenantScope, id: string, caller?: TimelineCaller): Promise<EvidenceChain> {
    const incident = await this.getOrThrow(scope, id);
    const failures: {
      source: IncidentTimelineSource;
      reason: 'unavailable' | 'forbidden';
      detail: string;
    }[] = [];

    let evidence: { items: RelatedEvidence[]; truncated: boolean } | undefined;
    try {
      evidence = await withTimeout(
        this.sources.relatedEvidence(
          scope,
          incident.id,
          incident.correlationId,
          MAX_ENTRIES_PER_SOURCE,
          caller,
        ),
        UPSTREAM_TIMEOUT_MS,
        'evidence',
      );
    } catch (err) {
      const forbidden =
        typeof err === 'object' && err !== null && 'forbidden' in err && err.forbidden === true;
      failures.push({
        source: 'evidence',
        reason: forbidden ? 'forbidden' : 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const chainInputs: ChainInputs = {
      incident,
      requested: ['evidence'],
      failures,
      now: this.now(),
    };
    if (evidence) chainInputs.evidence = evidence;
    return buildChain(chainInputs);
  }

  /**
   * Derived SLA attainment (P-5.1, F-4). ⚠️ No configured policy yields `unknown` — never `met`.
   * An unmeasured incident and a compliant one must never look the same in a report.
   */
  async sla(scope: TenantScope, id: string): Promise<IncidentSlaStatus> {
    const incident = await this.getOrThrow(scope, id);
    return deriveSla(incident, policyFor(this.slaPolicies, incident), this.now());
  }

  /**
   * A closed incident is sealed: no transition, no assignment, no note. "Terminal; retained for
   * audit" is only true if the record stops changing.
   */
  private refuseIfSealed(incident: Incident, verb: string): void {
    if (isTerminal(incident.status)) {
      throw conflict(`cannot ${verb} incident ${incident.id}: it is closed`);
    }
  }

  /** Version-guarded write, shared by every mutation. */
  private async persist(
    scope: TenantScope,
    next: Incident,
    expectedVersion: number,
  ): Promise<void> {
    const ok = await this.store.replace(scope, next, expectedVersion);
    if (!ok) throw conflict(`incident ${next.id} was modified concurrently; retry`);
  }

  private async transition(
    scope: TenantScope,
    id: string,
    action: IncidentAction,
    input: TransitionInput,
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    if (!canApply(action, current.status)) {
      throw conflict(`cannot ${action} an incident in status '${current.status}'`);
    }
    const next = applyTransition(current, action, input, this.factoryDeps);
    await this.persist(scope, next, current.version);
    this.metrics?.transitions.inc({ to: next.status });
    await this.publisher.publish(next);
    return next;
  }
}

/**
 * Race a bounded upstream read against a timeout.
 *
 * A join budget that counts calls but not time is not a budget: one hanging upstream turns a
 * bounded read into an unbounded one, and the timeline route stops answering at all. The rejection
 * carries the source so it becomes a legible `gap` rather than "something went wrong".
 */
/**
 * Shape an actor argument into the `{ by, actor }` pair every stream stores, and **refuse an AI**.
 *
 * ⚠️ The permission catalog is the real enforcement point — no role grants a machine principal an
 * `incident:*` write permission. This is the second lock: if an `ai-advisor` ever reaches a write
 * path, it fails here rather than being written into an immutable audit trail where removing it
 * means rewriting history.
 */
function who(actor: ActorArg | undefined): { by?: string; actor?: IncidentActorRef } {
  // Note: every caller is `async`, so a throw here surfaces as a rejection. A synchronous throw
  // from a method typed `Promise<Incident>` is a footgun — `.catch()` would never see it.
  const ref = normalizeActor(actor);
  if (!ref) return {};
  assertMayMutate(ref);
  return { by: ref.id, actor: ref };
}

function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} did not answer within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
