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
  CloseIncidentInput,
  Incident,
  IncidentCandidate,
  IncidentPage,
  IncidentQuery,
  ResolveIncidentInput,
} from '@vip/contracts';
import type { TenantScope } from '@vip/tenancy';
import { canApply, type IncidentAction } from '../domain/incident-state.js';
import { applyTransition, promoteFromCandidate } from '../domain/incident-factory.js';
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

  private async transition(
    scope: TenantScope,
    id: string,
    action: IncidentAction,
    input: { by?: string | undefined; note?: string | undefined; resolution?: string | undefined },
  ): Promise<Incident> {
    const current = await this.getOrThrow(scope, id);
    if (!canApply(action, current.status)) {
      throw conflict(`cannot ${action} an incident in status '${current.status}'`);
    }
    const next = applyTransition(current, action, input, this.factoryDeps);
    const ok = await this.store.replace(scope, next, current.version);
    if (!ok) throw conflict(`incident ${id} was modified concurrently; retry`);
    this.metrics?.transitions.inc({ to: next.status });
    await this.publisher.publish(next);
    return next;
  }
}
