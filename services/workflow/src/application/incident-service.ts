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
import { conflict, notFound } from './errors.js';
import type { IncidentStore } from './ports.js';
import { NoopIncidentPublisher, type IncidentPublisher } from './incident-publisher.js';
import type { IncidentMetrics } from './metrics.js';

export interface IncidentServiceDeps {
  store: IncidentStore;
  publisher?: IncidentPublisher;
  metrics?: IncidentMetrics;
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

export class IncidentService {
  private readonly store: IncidentStore;
  private readonly publisher: IncidentPublisher;
  private metrics: IncidentMetrics | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: IncidentServiceDeps) {
    this.store = deps.store;
    this.publisher = deps.publisher ?? NoopIncidentPublisher;
    this.metrics = deps.metrics;
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

  acknowledge(
    scope: TenantScope,
    id: string,
    input: AcknowledgeIncidentInput,
    actor?: string,
  ): Promise<Incident> {
    return this.transition(scope, id, 'acknowledge', { by: actor, note: input.note });
  }

  resolve(
    scope: TenantScope,
    id: string,
    input: ResolveIncidentInput,
    actor?: string,
  ): Promise<Incident> {
    return this.transition(scope, id, 'resolve', { by: actor, resolution: input.resolution });
  }

  close(
    scope: TenantScope,
    id: string,
    input: CloseIncidentInput,
    actor?: string,
  ): Promise<Incident> {
    return this.transition(scope, id, 'close', { by: actor, note: input.note });
  }

  /** Begin investigating (P-5.0 G-1). */
  investigate(
    scope: TenantScope,
    id: string,
    input: InvestigateIncidentInput,
    actor?: string,
  ): Promise<Incident> {
    return this.transition(scope, id, 'investigate', { by: actor, note: input.note });
  }

  /** Escalate, recording who now owns the outcome (P-5.0 G-1). */
  escalate(
    scope: TenantScope,
    id: string,
    input: EscalateIncidentInput,
    actor?: string,
  ): Promise<Incident> {
    return this.transition(scope, id, 'escalate', {
      by: actor,
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
    actor?: string,
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    this.refuseIfSealed(current, 'assign');
    const next = applyAssignment(
      current,
      { to: input.assignee ?? undefined, by: actor, note: input.note },
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
    actor?: string,
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    this.refuseIfSealed(current, 'comment on');
    if (current.notes.length >= MAX_NOTES) {
      throw conflict(`incident ${id} has reached the ${MAX_NOTES}-note limit`);
    }
    const next = appendNote(
      current,
      { body: input.body, by: actor, attachments: input.attachments },
      this.factoryDeps,
    );
    await this.persist(scope, next, current.version);
    this.metrics?.notesAdded.inc();
    return next;
  }

  /** The derived activity log — transitions + assignments + notes, oldest first (P-5.0 G-2). */
  async activity(scope: TenantScope, id: string): Promise<IncidentActivity> {
    return deriveActivity(await this.getOrThrow(scope, id), this.now());
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
