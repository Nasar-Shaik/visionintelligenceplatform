/**
 * Application: the rule engine consumer. Subscribes to `event.persisted` (`t.*.event.>`) and, per
 * envelope: load the tenant's enabled rules → **evaluate** (stateless match, domain/rule-evaluator)
 * → apply the optional **windowed threshold** (tenant-scoped state) → **create** an incident
 * candidate (domain/incident) and publish `incident.candidate` + `rule.matched`. Consumes ONLY the
 * `EventEnvelope` (never DetectionResult — P1-7 rec 1); evaluation and incident creation are separate
 * stages (rec 2); the DSL is pure + sandboxed (rec 5); evaluation metrics are recorded (rec 4).
 *
 * Loops are prevented structurally: the engine consumes `t.*.event.>` but publishes its outputs onto
 * the distinct `t.*.incident.>` / `t.*.rule.>` roots, so it can never trigger on its own output. It is
 * fail-closed: an envelope that does not satisfy the contract is dead-lettered, never evaluated.
 */
import { EventEnvelope } from '@vip/contracts';
import {
  ALL_EVENTS,
  AUTOMATION_STREAM,
  ALL_INCIDENTS,
  ALL_RULE_MATCHES,
  EVENTS_STREAM,
  incidentCandidateSubject,
  ruleMatchedSubject,
  type BusMessage,
  type EventBus,
  type Subscription,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import { evaluateRule } from '../domain/rule-evaluator.js';
import { matchesScope } from '../domain/scope.js';
import { RuleSetCache } from './compiled-rules.js';
import {
  buildIncidentCandidate,
  buildRuleMatch,
  groupKeyFor,
  raisesIncident,
} from '../domain/incident.js';
import type { RuleStateStore, RuleStore } from './ports.js';
import type { RuleMetrics } from './metrics.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;
// (automation outputs land on their own subject roots — see start())

export interface RuleEngineDeps {
  bus: EventBus;
  store: RuleStore;
  state: RuleStateStore;
  maxRulesPerEvent: number;
  candidateDedupWindowMs: number;
  /** How long a compiled rule set may be served before it is rebuilt (P-4). */
  ruleCacheTtlMs?: number;
  metrics?: RuleMetrics;
  now?: () => Date;
  newId?: () => string;
  log?: LogFn;
  durable?: string;
}

export class RuleEngine {
  private readonly bus: EventBus;
  private readonly store: RuleStore;
  private readonly state: RuleStateStore;
  private readonly maxRulesPerEvent: number;
  private readonly dedupWindowMs: number;
  /** Compiled, scope-expanded rules per tenant — so evaluating an event touches no store (P-4). */
  private readonly compiled: RuleSetCache;
  private readonly metrics: RuleMetrics | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: LogFn;
  private readonly durable: string;
  private sub?: Subscription;

  constructor(deps: RuleEngineDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.state = deps.state;
    this.maxRulesPerEvent = deps.maxRulesPerEvent;
    this.dedupWindowMs = deps.candidateDedupWindowMs;
    this.compiled = new RuleSetCache({
      store: deps.store,
      maxRulesPerEvent: deps.maxRulesPerEvent,
      ...(deps.ruleCacheTtlMs !== undefined ? { ttlMs: deps.ruleCacheTtlMs } : {}),
    });
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.durable = deps.durable ?? 'rules-engine';
  }

  async start(): Promise<void> {
    // Input stream (events we consume) + output stream (automation we publish) — both must exist.
    await this.bus.ensureStream(EVENTS_STREAM, [ALL_EVENTS]);
    await this.bus.ensureStream(AUTOMATION_STREAM, [ALL_INCIDENTS, ALL_RULE_MATCHES]);
    this.sub = await this.bus.subscribe(
      { stream: EVENTS_STREAM, durable: this.durable, filterSubject: ALL_EVENTS },
      (msg) => this.onMessage(msg),
    );
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }

  /** Drop a tenant's compiled rules so an authoring change takes effect immediately (P-4). */
  invalidate(tenantId: string): void {
    this.compiled.invalidate(tenantId);
  }

  async onMessage(msg: BusMessage): Promise<void> {
    let raw: unknown;
    try {
      raw = msg.json();
    } catch {
      this.metrics?.eventsDeadLettered.inc();
      msg.term();
      return;
    }
    const parsed = EventEnvelope.safeParse(raw);
    if (!parsed.success) {
      this.metrics?.eventsDeadLettered.inc();
      this.log('warn', 'dead-lettering: not a valid EventEnvelope', {
        subject: msg.subject,
        issue: parsed.error.issues[0]?.message,
      });
      msg.term();
      return;
    }
    const envelope = parsed.data;
    this.metrics?.eventsConsumed.inc();

    try {
      await this.evaluate(envelope);
      msg.ack();
    } catch (err) {
      // Transient failure (store/broker) — redeliver rather than drop.
      this.log('error', 'rule evaluation failed; will redeliver', {
        subject: msg.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      msg.nak();
    }
  }

  /**
   * Evaluate one event against the tenant's enabled rules; publish matches + candidates.
   *
   * The rules arrive **compiled** — ordered, bounded, and with their location scopes expanded into
   * hash sets — so this path issues no query and does no sorting. Scope is checked first because it is
   * the cheapest discriminator and the one that rejects most events in a large estate: a rule for one
   * site should cost almost nothing on an event from another.
   */
  async evaluate(envelope: EventEnvelope): Promise<void> {
    const endTimer = this.metrics?.evaluationDuration.startTimer();
    const scope = TenantScope.fromTenantId(envelope.tenantId);
    const compiled = await this.compiled.get(scope);

    for (const { rule, scope: ruleScope } of compiled.rules) {
      this.metrics?.rulesEvaluated.inc();
      if (!matchesScope(ruleScope, envelope)) continue;
      const { matched } = evaluateRule(rule, envelope);
      if (!matched) continue;

      // Windowed threshold (stateful) — applied AFTER a positive stateless match.
      let matchedCount = 1;
      let windowPassed = true;
      if (rule.window) {
        const key = `${envelope.tenantId}:${rule.id}:${groupKeyFor(rule, envelope)}`;
        matchedCount = await this.state.hitAndCount(key, rule.window.withinSeconds, this.now());
        windowPassed = matchedCount >= rule.window.count;
      }

      this.metrics?.rulesMatched.inc();
      const willRaise = windowPassed && raisesIncident(rule);

      // rule.matched — lightweight audit on every match (idempotent per event+rule).
      await this.bus.publish(
        ruleMatchedSubject(envelope.tenantId),
        buildRuleMatch(rule, envelope, willRaise, this.now()),
        { msgId: `${envelope.id}:${rule.id}` },
      );

      if (!willRaise) continue;

      const candidate = buildIncidentCandidate(rule, envelope, matchedCount, this.dedupWindowMs, {
        newId: this.newId,
        now: this.now,
      });
      // incident.candidate — dedup key doubles as the JetStream msgId so bursts collapse.
      await this.bus.publish(incidentCandidateSubject(envelope.tenantId), candidate, {
        msgId: candidate.dedupKey,
      });
      this.metrics?.candidatesRaised.inc({ severity: candidate.severity });
      this.log('info', 'incident candidate raised', {
        ruleId: rule.id,
        eventId: envelope.id,
        severity: candidate.severity,
      });
    }
    endTimer?.();
  }
}
