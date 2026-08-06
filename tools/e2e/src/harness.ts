/**
 * PlatformHarness — the G-3.5 end-to-end validation rig.
 *
 * It composes the **real** application spine of four bounded-context services exactly as their
 * production composition roots do (services/{events,rules,workflow,notify}/src/index.ts), but over a
 * single broker-free `InMemoryEventBus` and DB-free in-memory stores, with deterministic time + ids:
 *
 *     DetectionResult ─▶ events(EventIngestService)  ─ t.*.event.>        ─▶ rules(RuleEngine)
 *                                                                              │  t.*.incident.candidate
 *                                                                              ▼
 *                        notify(AlertEngine) ◀─ t.*.incident.raised ─  workflow(IncidentPromoter)
 *                                │  t.*.notification.>
 *                                ▼
 *                         (delivery log = the "dashboard" read model)
 *
 * The in-memory bus delivers synchronously and recursively, so a single `emitDetection()` /
 * `emitEvent()` call drives the entire chain to completion within one awaited turn — no sleeps, no
 * polling, fully deterministic. Reads (`events`/`incidents`/`notifications`) model what the Operations
 * Console dashboard fetches through the gateway.
 *
 * Boundary note: this file lives under tools/ (outside the runtime dependency graph, see
 * tools/import-graph/check-imports.mjs) which is the only place allowed to import more than one
 * service's internals — production code never does; services talk over the bus alone.
 */
import type {
  CreateChannelInput,
  CreateRuleInput,
  DetectionResult,
  EventEnvelope,
  Incident,
  Notification,
  Rule,
} from '@vip/contracts';
import {
  InMemoryEventBus,
  eventSubject,
  capabilityOutputSubject,
  type DeliveredRecord,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';

// --- Real service application/domain/adapter classes (composed, never re-implemented) -------------
import { EventIngestService } from '../../../services/events/src/application/event-ingest-service.js';
import { InMemoryEventStore } from '../../../services/events/src/adapters/in-memory-event-store.js';
import {
  dedupKey,
  normalizeDetectionResult,
} from '../../../services/events/src/domain/event-normalizer.js';

import { RuleEngine } from '../../../services/rules/src/application/rule-engine.js';
import { RuleService } from '../../../services/rules/src/application/rule-service.js';
import { InMemoryRuleStore } from '../../../services/rules/src/adapters/in-memory-rule-store.js';
import { InMemoryRuleStateStore } from '../../../services/rules/src/adapters/in-memory-rule-state.js';
import { InMemoryDwellStateStore } from '../../../services/rules/src/adapters/in-memory-dwell-state.js';

import { IncidentService } from '../../../services/workflow/src/application/incident-service.js';
import { IncidentPromoter } from '../../../services/workflow/src/application/incident-promoter.js';
import { BusIncidentPublisher } from '../../../services/workflow/src/application/incident-publisher.js';
import { InMemoryIncidentStore } from '../../../services/workflow/src/adapters/in-memory-incident-store.js';

import { AlertEngine } from '../../../services/notify/src/application/alert-engine.js';
import { BusNotificationPublisher } from '../../../services/notify/src/application/notification-publisher.js';
import {
  ChannelSenderRegistry,
  InAppSender,
  WebhookSender,
  type ChannelSender,
} from '../../../services/notify/src/application/channel-sender.js';
import { InMemoryChannelStore } from '../../../services/notify/src/adapters/in-memory-channel-store.js';
import { InMemoryNotificationStore } from '../../../services/notify/src/adapters/in-memory-notification-store.js';

import { Clock, uuidFactory } from './determinism.js';

/** Production config defaults mirrored from each service's config/env.ts (deterministic overrides). */
const EVENTS_DEDUP_WINDOW_MS = 10_000;
const RULES_MAX_PER_EVENT = 1_000;
const RULES_CANDIDATE_DEDUP_WINDOW_MS = 60_000;

export interface HarnessOptions {
  /** Fixed clock start; a fresh harness with the same start replays byte-identically. */
  startISO?: string;
  /** Register a webhook sender too (defaults to in-app only, which always delivers locally). */
  webhookSender?: ChannelSender;
}

/** One observed hop through the bus (subject + how the consumer dispositioned it). */
export type FlowRecord = DeliveredRecord;

export class PlatformHarness {
  readonly bus: InMemoryEventBus;
  readonly clock: Clock;
  readonly newId: () => string;

  // events context
  private readonly eventStore: InMemoryEventStore;
  readonly eventIngest: EventIngestService;

  // rules context
  private readonly ruleStore: InMemoryRuleStore;
  private readonly ruleState: InMemoryRuleStateStore;
  /** P-8 Phase 7 — the dwell stage's state, in-memory here exactly as in production. */
  private readonly dwellState: InMemoryDwellStateStore;
  readonly ruleService: RuleService;
  private readonly ruleEngine: RuleEngine;

  // workflow context
  private readonly incidentStore: InMemoryIncidentStore;
  readonly incidentService: IncidentService;
  private readonly promoter: IncidentPromoter;

  // notify context
  private readonly channelStore: InMemoryChannelStore;
  private readonly notificationStore: InMemoryNotificationStore;
  private readonly alertEngine: AlertEngine;

  private started = false;

  constructor(opts: HarnessOptions = {}) {
    this.bus = new InMemoryEventBus();
    this.clock = new Clock(opts.startISO);
    this.newId = uuidFactory();
    const now = this.clock.now;
    const newId = this.newId;

    // events — normalize DetectionResult → EventEnvelope, persist (dedup), publish t.*.event.*
    this.eventStore = new InMemoryEventStore();
    this.eventIngest = new EventIngestService({
      bus: this.bus,
      store: this.eventStore,
      dedupWindowMs: EVENTS_DEDUP_WINDOW_MS,
      now,
      newId,
    });

    // rules — consume t.*.event.>, evaluate, publish incident.candidate + rule.matched
    this.ruleStore = new InMemoryRuleStore({ now, newId });
    this.ruleState = new InMemoryRuleStateStore();
    this.dwellState = new InMemoryDwellStateStore();
    // Authoring writes drop the engine's compiled-rule cache, exactly as the real service wires it.
    const engineRef: { current?: RuleEngine } = {};
    this.ruleService = new RuleService({
      store: this.ruleStore,
      now,
      newId,
      onRulesChanged: (tenantId) => engineRef.current?.invalidate(tenantId),
    });
    this.ruleEngine = new RuleEngine({
      dwell: this.dwellState,
      bus: this.bus,
      store: this.ruleStore,
      state: this.ruleState,
      maxRulesPerEvent: RULES_MAX_PER_EVENT,
      candidateDedupWindowMs: RULES_CANDIDATE_DEDUP_WINDOW_MS,
      now,
      newId,
    });
    engineRef.current = this.ruleEngine;

    // workflow — consume incident.candidate, idempotently promote, publish incident.raised
    this.incidentStore = new InMemoryIncidentStore();
    this.incidentService = new IncidentService({
      store: this.incidentStore,
      publisher: new BusIncidentPublisher(this.bus),
      now,
      newId,
    });
    this.promoter = new IncidentPromoter({ bus: this.bus, service: this.incidentService });

    // notify — consume incident.raised, select channels, deliver, publish notification.*
    this.channelStore = new InMemoryChannelStore({ now, newId });
    this.notificationStore = new InMemoryNotificationStore();
    const senders = new ChannelSenderRegistry()
      .register('in-app', new InAppSender())
      .register('webhook', opts.webhookSender ?? new WebhookSender());
    this.alertEngine = new AlertEngine({
      bus: this.bus,
      channels: this.channelStore,
      notifications: this.notificationStore,
      senders,
      publisher: new BusNotificationPublisher(this.bus),
      now,
      newId,
    });
  }

  /** Attach every consumer to the bus. Idempotent; call once before emitting. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.eventIngest.start();
    await this.ruleEngine.start();
    await this.promoter.start();
    await this.alertEngine.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.alertEngine.stop();
    await this.promoter.stop();
    await this.ruleEngine.stop();
    await this.eventIngest.stop();
    await this.bus.close();
    this.started = false;
  }

  // --- Seeding (control-plane; what an admin configures before events flow) ---------------------

  /** Register a tenant rule (authoring API path). Returns the stored Rule. */
  seedRule(tenantId: string, input: CreateRuleInput, actor = 'architect'): Promise<Rule> {
    return this.ruleService.create(TenantScope.fromTenantId(tenantId), input, actor);
  }

  /** Register a notification channel so raised incidents fan out. Defaults to an enabled in-app inbox. */
  seedChannel(
    tenantId: string,
    input: CreateChannelInput = { name: 'ops inbox', type: 'in-app', config: {}, enabled: true },
  ): Promise<unknown> {
    return this.channelStore.create(TenantScope.fromTenantId(tenantId), input);
  }

  // --- Emission (data-plane entry points) -------------------------------------------------------

  /**
   * INFERENCE ENTRY — a capability publishes a DetectionResult onto its output subject, exactly as the
   * Python inference runtime does. Drives the full events-service normalize → persist → publish path.
   * Returns after the whole synchronous cascade (rules → workflow → notify) has settled.
   */
  async emitDetection(result: DetectionResult): Promise<void> {
    await this.bus.publish(capabilityOutputSubject(result.tenantId, result.capabilityId), result, {
      msgId: `${result.tenantId}:${result.capabilityId}:${result.frame.seq}`,
    });
  }

  /**
   * PRODUCER ENTRY — a producer emits an already-formed semantic `EventEnvelope` (e.g. a behaviour /
   * analytics / system.* event). Mirrors the *tail* of EventIngestService.ingest (persist for the
   * dashboard read-model, then publish on t.{tenant}.event.{type}) so these events flow through the
   * same rules → workflow → notify spine and are visible to the dashboard.
   *
   * Used for event types whose Node-side normaliser mapping / system-event producer wiring is not yet
   * connected (see the G-3.5 report, TD-1). The Python runtime's events.py already produces these
   * envelopes; this models that boundary deterministically without new production code.
   */
  async emitEvent(envelope: EventEnvelope): Promise<void> {
    const scope = TenantScope.fromTenantId(envelope.tenantId);
    const key = dedupKey(envelope, EVENTS_DEDUP_WINDOW_MS);
    const isNew = await this.eventStore.persist(scope, envelope, key);
    if (!isNew) return; // duplicate collapses at the store, exactly like the ingest path
    await this.bus.publish(eventSubject(envelope.tenantId, envelope.type), envelope, {
      msgId: envelope.id,
    });
  }

  /**
   * REPLAY ENTRY — re-publish an already-stored `EventEnvelope` onto the event subject so the Rule
   * Engine re-evaluates it, exactly as the events-service replay route does. Used by the replay /
   * regression tests: feeding a fresh harness the events another run persisted must yield identical
   * rule evaluations and incidents (deterministic).
   */
  async replayEvent(envelope: EventEnvelope): Promise<void> {
    await this.bus.publish(eventSubject(envelope.tenantId, envelope.type), envelope, {
      msgId: envelope.id,
    });
  }

  /** Pure normalize (no side effects) — for tests that assert the DetectionResult→EventEnvelope map. */
  normalize(result: DetectionResult): EventEnvelope[] {
    return normalizeDetectionResult(result, { now: this.clock.now, newId: this.newId });
  }

  // --- Read model (what the Operations Console dashboard fetches via the gateway) ----------------

  async events(tenantId: string): Promise<EventEnvelope[]> {
    const page = await this.eventStore.query(TenantScope.fromTenantId(tenantId), { limit: 500 });
    return page.events;
  }

  async incidents(tenantId: string): Promise<Incident[]> {
    const page = await this.incidentStore.list(TenantScope.fromTenantId(tenantId), { limit: 200 });
    return page.items;
  }

  async notifications(tenantId: string): Promise<Notification[]> {
    const page = await this.notificationStore.list(TenantScope.fromTenantId(tenantId), {
      limit: 200,
    });
    return page.items;
  }

  /** Count published subjects matching a predicate — unbounded, for performance/flow assertions. */
  countPublished(match: (subject: string) => boolean): number {
    return this.bus.published.reduce((n, m) => (match(m.subject) ? n + 1 : n), 0);
  }

  /** Every bus hop observed this run (subject + disposition) — for message-flow assertions. */
  get flow(): FlowRecord[] {
    return this.bus.delivered;
  }

  /** Every subject published this run, in order — for event-flow assertions. */
  publishedSubjects(): string[] {
    return this.bus.published.map((m) => m.subject);
  }
}
