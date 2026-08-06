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
import {
  EventEnvelope,
  type LiveDwellTimer,
  type LiveRuleStatus,
  type Rule,
  type RuleCacheStats,
} from '@vip/contracts';
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
import type { RuleStatsRegistry } from './rule-stats.js';
import {
  buildIncidentCandidate,
  buildRuleMatch,
  groupKeyFor,
  raisesIncident,
  type DwellContext,
} from '../domain/incident.js';
import {
  dwellKey,
  parseDwellKey,
  subjectKeyFor,
  timerStateOf,
  zoneKeyFor,
} from '../domain/dwell.js';
import type { DwellStateStore, RuleStateStore, RuleStore, ZoneLookup } from './ports.js';
import type { RuleMetrics } from './metrics.js';
import { DryRunLog } from './dry-run-log.js';
import { RateWindow } from './rate-window.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;
// (automation outputs land on their own subject roots — see start())

export interface RuleEngineDeps {
  bus: EventBus;
  store: RuleStore;
  state: RuleStateStore;
  /** Where a subject's visit lives between events (P-8 Phase 7). */
  dwell: DwellStateStore;
  /**
   * Resolves a detection zone's name and version for the candidate's explanation (P-8 Phase 7).
   *
   * ⚠️ **Synchronous and optional.** It is read on the per-event path, so it must be a cache lookup
   * and never a call; and a deployment without it produces candidates carrying the zone id alone,
   * which is honest and still actionable. A required async lookup here would have put the camera
   * service between a camera and an alert.
   */
  zones?: ZoneLookup | undefined;
  maxRulesPerEvent: number;
  candidateDedupWindowMs: number;
  /** How long a compiled rule set may be served before it is rebuilt (P-4). */
  ruleCacheTtlMs?: number;
  /** Durable per-rule counters (P-4.1). Absent = no per-rule statistics on this node. */
  stats?: RuleStatsRegistry;
  metrics?: RuleMetrics;
  now?: () => Date;
  newId?: () => string;
  log?: LogFn;
  durable?: string;
  /** Which node this is, for `LiveRuleStatus.node`. Defaults to `HOSTNAME`. */
  node?: string;
}

export class RuleEngine {
  private readonly bus: EventBus;
  private readonly store: RuleStore;
  private readonly state: RuleStateStore;
  private readonly dwell: DwellStateStore;
  private readonly zones: ZoneLookup | undefined;
  /** Candidates a dry-run rule would have raised. Bounded, in-process, read by the console. */
  readonly dryRuns = new DryRunLog();
  /** Which node is answering. Every number on the status page is this node's — see `LiveRuleStatus`. */
  private readonly node: string;
  private readonly startedAtMs: number;
  /** Sliding rate windows for the Live Rule Status page. ⚠️ `null` until a window elapses. */
  private readonly rates: {
    events: RateWindow;
    evaluations: RateWindow;
    candidates: RateWindow;
  };
  /** ⚠️ Mirrors the Prometheus counter, so the status page can show it without a scrape. */
  private withoutIdentity = 0;
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
    this.dwell = deps.dwell;
    this.zones = deps.zones;
    this.maxRulesPerEvent = deps.maxRulesPerEvent;
    this.dedupWindowMs = deps.candidateDedupWindowMs;
    this.compiled = new RuleSetCache({
      store: deps.store,
      maxRulesPerEvent: deps.maxRulesPerEvent,
      ...(deps.ruleCacheTtlMs !== undefined ? { ttlMs: deps.ruleCacheTtlMs } : {}),
      ...(deps.stats ? { stats: deps.stats } : {}),
    });
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.durable = deps.durable ?? 'rules-engine';
    this.node = deps.node ?? process.env['HOSTNAME'] ?? 'rules';
    this.startedAtMs = this.now().getTime();
    this.rates = {
      events: new RateWindow(this.startedAtMs),
      evaluations: new RateWindow(this.startedAtMs),
      candidates: new RateWindow(this.startedAtMs),
    };
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

  /**
   * Recompile a tenant's rules now (P-4.1, Architect rec 5) — the warm-up half of an authoring write.
   *
   * `invalidate` alone leaves the rebuild to the next event, which is exactly the event the author is
   * watching for; that event pays a query it did not need to. Warming moves the cost onto the write,
   * where someone is already waiting and a few milliseconds are invisible.
   *
   * Never throws. A warm-up is an optimisation, and a failed optimisation must not fail the save that
   * triggered it — the set is already invalidated, so the worst case is the behaviour before this
   * existed.
   */
  async warm(tenantId: string): Promise<void> {
    try {
      await this.compiled.refresh(TenantScope.fromTenantId(tenantId));
    } catch (err) {
      this.log('warn', 'rule set warm-up failed; the next event will compile', {
        tenantId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Compiled-rule cache health for this node (Architect rec 8). */
  cacheStats(tenantId: string): RuleCacheStats {
    return this.compiled.statsFor(tenantId);
  }

  /**
   * **What the engine is doing right now** (P-8 Phase 7, Architect recs 3 + 6).
   *
   * Assembled from what this process already holds — the compiled rule set, the rate windows and the
   * dwell store — so it costs a walk of live state and no I/O. Nothing here is stored, and nothing in
   * evaluation reads it.
   *
   * ⚠️ Every rate is `null` until its window has elapsed (ADR-0039). `0.0/s` on a node that started
   * four seconds ago is a fabrication, and it is the fabrication most likely to be believed, because
   * an idle estate produces the identical number honestly.
   */
  async liveStatus(tenantId: string): Promise<LiveRuleStatus> {
    const nowMs = this.now().getTime();
    const scope = TenantScope.fromTenantId(tenantId);
    const compiled = await this.compiled.get(scope);

    let dwellRules = 0;
    let dryRunRules = 0;
    const zoneIds = new Set<string>();
    /** Rule id → the rule, so a live timer can name its threshold without a second lookup. */
    const byId = new Map<string, Rule>();
    for (const { rule, scope: ruleScope } of compiled.rules) {
      byId.set(rule.id, rule);
      if (rule.dwell !== undefined) dwellRules += 1;
      if (rule.dryRun) dryRunRules += 1;
      for (const zoneId of ruleScope.detectionZoneIds) zoneIds.add(zoneId);
    }

    /*
     * ⚠️ The dwell store is cross-tenant (one process, every tenant), so entries are filtered by the
     * tenant prefix of their key. Returning another tenant's live timers on this page would be a
     * cross-tenant leak wearing an operations hat.
     */
    const prefix = `${tenantId}:`;
    const timers: LiveDwellTimer[] = [];
    let activeCount = 0;
    for (const { key, record } of this.dwell.active()) {
      if (!key.startsWith(prefix)) continue;
      const parsed = parseDwellKey(key);
      if (parsed === undefined) continue;
      const rule = byId.get(parsed.ruleId);
      if (rule?.dwell === undefined) continue;
      activeCount += 1;
      if (timers.length >= 50) continue;

      const { state, cooldownRemainingSeconds } = timerStateOf(record, rule.dwell, nowMs);
      const zone = this.zones?.(tenantId, parsed.zoneKey === '-' ? undefined : parsed.zoneKey);
      const timer: LiveDwellTimer = {
        ruleId: rule.id,
        ruleName: rule.name,
        subject: parsed.subject,
        subjectKind: rule.dwell.groupBy,
        firstObservedAt: new Date(record.firstObservedAtMs).toISOString(),
        lastObservedAt: new Date(record.lastObservedAtMs).toISOString(),
        elapsedSeconds: (record.lastObservedAtMs - record.firstObservedAtMs) / 1000,
        thresholdSeconds: rule.dwell.minSeconds,
        observations: record.observations,
        trackFragments: Math.max(1, record.trackIds.length),
        longestGapSeconds: record.longestGapMs / 1000,
        state,
        cooldownRemainingSeconds,
        dryRun: rule.dryRun,
      };
      if (parsed.zoneKey !== '-') timer.zoneId = parsed.zoneKey;
      if (zone !== undefined) {
        timer.zoneName = zone.name;
        /*
         * ⚠️ The camera comes from the ZONE, because the dwell key does not carry one. Without it the
         * Live Rule Status page cannot offer a camera to draw the zone view for — the screen the
         * whole visual demonstration is built on had an empty selector.
         */
        if (zone.cameraId !== undefined) timer.cameraId = zone.cameraId;
      }
      timers.push(timer);
    }
    /* Closest to firing first — what an operator watching a screen wants at the top. */
    timers.sort(
      (a, b) => b.elapsedSeconds / b.thresholdSeconds - a.elapsedSeconds / a.thresholdSeconds,
    );

    const dwellStats = this.dwell.stats();
    return {
      tenantId,
      node: this.node,
      uptimeSeconds: (nowMs - this.startedAtMs) / 1000,
      activeRules: compiled.rules.length,
      dwellRules,
      dryRunRules,
      activeZones: zoneIds.size,
      evaluationsPerSecond: this.rates.evaluations.perSecond(nowMs),
      candidatesPerSecond: this.rates.candidates.perSecond(nowMs),
      eventsPerSecond: this.rates.events.perSecond(nowMs),
      activeDwellTimers: activeCount,
      timers,
      dwellWithoutIdentity: this.withoutIdentity,
      dwellStateEntries: dwellStats.entries,
      dwellStateCapacity: dwellStats.maxEntries,
      dwellStateEvicted: dwellStats.evicted,
      at: new Date(nowMs).toISOString(),
    };
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
    this.rates.events.add(this.now().getTime());
    /*
     * ⚠️ **Event → Rule latency, sampled on arrival** (Architect rec 6). Measured before any work,
     * so it is the transport half alone: how long a frame's event took to reach this engine. Pairing
     * it with `candidateLatency` at the other end isolates a slow broker from a slow rule set, which
     * is the entire point of separating the two.
     */
    const ingestMs = this.now().getTime() - Date.parse(envelope.occurredAt);
    if (Number.isFinite(ingestMs) && ingestMs >= 0) {
      this.metrics?.ingestLatency.observe(ingestMs / 1000);
    }

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
    // One clock read for the whole event: "last evaluated" to the millisecond is precision nobody uses.
    const startedAtMs = this.now().getTime();
    const scope = TenantScope.fromTenantId(envelope.tenantId);
    const compiled = await this.compiled.get(scope);

    for (const { rule, scope: ruleScope, stats } of compiled.rules) {
      this.metrics?.rulesEvaluated.inc();
      this.rates.evaluations.add(startedAtMs);
      if (stats) {
        stats.evaluations += 1;
        stats.lastEvaluatedAt = startedAtMs;
      }
      if (!matchesScope(ruleScope, envelope)) continue;

      /*
       * Timed only past the scope check (P-4.1). A rule the scope rejected did no work worth
       * measuring, and reading the clock for it would put two `performance.now()` calls per rule per
       * event into the path this whole design exists to keep empty.
       */
      const ruleStartedAt = stats ? performance.now() : 0;
      let matched: boolean;
      try {
        ({ matched } = evaluateRule(rule, envelope));
      } catch (err) {
        // A throwing rule is a defect, not a match. Recorded, skipped, and the event continues.
        if (stats) stats.failures += 1;
        this.log('error', 'rule evaluation threw; skipping this rule', {
          ruleId: rule.id,
          eventId: envelope.id,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (stats) {
        const micros = (performance.now() - ruleStartedAt) * 1000;
        stats.totalMicros += micros;
        stats.timedEvaluations += 1;
        if (micros > stats.maxMicros) stats.maxMicros = micros;
      }
      if (!matched) continue;
      if (stats) {
        stats.matches += 1;
        stats.lastMatchedAt = startedAtMs;
      }

      // Windowed threshold (stateful) — applied AFTER a positive stateless match.
      let matchedCount = 1;
      let windowPassed = true;
      if (rule.window) {
        const key = `${envelope.tenantId}:${rule.id}:${groupKeyFor(rule, envelope)}`;
        matchedCount = await this.state.hitAndCount(key, rule.window.withinSeconds, this.now());
        windowPassed = matchedCount >= rule.window.count;
      }

      /*
       * Dwell threshold (stateful) — the last stage, and the only one that can decline for a reason
       * that is about the *platform* rather than about the rule. See `domain/dwell.ts`.
       */
      let dwell: DwellContext | undefined;
      let dwellPassed = true;
      if (rule.dwell && windowPassed) {
        const outcome = await this.#observeDwell(rule, envelope);
        if (outcome === undefined) {
          /*
           * ⚠️ No subject key — the event carries neither an identity nor a track id, so there is
           * nothing to accumulate against. Counted and skipped, never bucketed under a placeholder:
           * pooling anonymous detections into one subject produces a phantom who is always present
           * and crosses every threshold. This is the "Missing Identity" mutation.
           */
          this.metrics?.dwellWithoutIdentity.inc();
          this.withoutIdentity += 1;
          dwellPassed = false;
        } else {
          dwell = outcome;
          dwellPassed = outcome.outcome.fires;
          if (outcome.outcome.coolingDown) this.metrics?.dwellSuppressedByCooldown.inc();
        }
      }

      this.metrics?.rulesMatched.inc();
      const wouldRaise = windowPassed && dwellPassed && raisesIncident(rule);
      /*
       * ⚠️ **Dry run is applied HERE and nowhere else.** Everything above ran exactly as it would
       * live — the dwell clock advanced, the cool-down armed — because a dry run whose state diverged
       * from a live run would report numbers for a rule nobody is going to operate. What changes is
       * only whether the candidate is published.
       */
      const willRaise = wouldRaise && !rule.dryRun;

      // rule.matched — lightweight audit on every match (idempotent per event+rule).
      await this.bus.publish(
        ruleMatchedSubject(envelope.tenantId),
        buildRuleMatch(rule, envelope, willRaise, this.now()),
        { msgId: `${envelope.id}:${rule.id}` },
      );

      if (!wouldRaise) continue;

      const candidate = buildIncidentCandidate(
        rule,
        envelope,
        matchedCount,
        this.dedupWindowMs,
        { newId: this.newId, now: this.now },
        dwell,
      );

      if (!willRaise) {
        /*
         * ⚠️ Built and then deliberately not published. Building it is what makes the dry-run report
         * trustworthy: it is the same function, so what an operator sees in the dry run is exactly
         * the candidate they would have received. Recording it here rather than publishing it is the
         * one and only difference between the two modes.
         */
        this.metrics?.candidatesSuppressedByDryRun.inc();
        this.dryRuns.record(candidate);
        this.log('info', 'dry run: candidate withheld', {
          ruleId: rule.id,
          eventId: envelope.id,
          durationSeconds: candidate.durationSeconds,
        });
        continue;
      }

      // incident.candidate — dedup key doubles as the JetStream msgId so bursts collapse.
      await this.bus.publish(incidentCandidateSubject(envelope.tenantId), candidate, {
        msgId: candidate.dedupKey,
      });
      this.metrics?.candidatesRaised.inc({ severity: candidate.severity });
      this.rates.candidates.add(this.now().getTime());
      /*
       * ⚠️ **Event → candidate latency, sampled where both ends are known** (Architect rec 6). The
       * event's `occurredAt` is when the camera saw it; `now` is when the candidate went out. Nowhere
       * else in the platform holds both, and a metric assembled later from two services' clocks would
       * be measuring clock skew.
       */
      const producedMs = this.now().getTime() - Date.parse(envelope.occurredAt);
      if (Number.isFinite(producedMs) && producedMs >= 0) {
        this.metrics?.candidateLatency.observe(producedMs / 1000);
      }
      this.log('info', 'incident candidate raised', {
        ruleId: rule.id,
        eventId: envelope.id,
        severity: candidate.severity,
        ...(candidate.durationSeconds !== undefined
          ? { durationSeconds: candidate.durationSeconds }
          : {}),
      });
    }
    endTimer?.();
  }

  /**
   * Run the dwell stage for one rule and one event.
   *
   * Returns `undefined` when the event carries no subject key — see the call site for why that is a
   * refusal rather than a default.
   */
  async #observeDwell(rule: Rule, envelope: EventEnvelope): Promise<DwellContext | undefined> {
    const config = rule.dwell;
    if (config === undefined) return undefined;
    const subject = subjectKeyFor(config.groupBy, envelope);
    if (subject === undefined) return undefined;

    const key = dwellKey(envelope.tenantId, rule.id, zoneKeyFor(envelope), subject);
    /*
     * ⚠️ `occurredAt`, not the node's clock — a replayed backlog must contribute the duration it
     * actually represents. See `domain/dwell.observe`.
     */
    const atMs = Date.parse(envelope.occurredAt);
    const outcome = await this.dwell.observe(
      key,
      {
        atMs: Number.isFinite(atMs) ? atMs : this.now().getTime(),
        eventId: envelope.id,
        eventType: envelope.type,
        trackId: envelope.subjects[0]?.trackId,
        confidence: envelope.confidence,
        /*
         * ⚠️ The frame this event came from, so the timeline can point at footage (rec 1). It lives
         * in the payload rather than on the envelope — see the normalizer for why a frame sequence
         * has no business being a field every `tenant.created` event carries.
         */
        frameId:
          typeof envelope.payload['frameId'] === 'string' ? envelope.payload['frameId'] : undefined,
      },
      config,
    );
    const context: DwellContext = { outcome, subject };
    /*
     * The zone's name and version, from the resolver the composition root supplied. ⚠️ A synchronous
     * in-memory lookup against a cache media already refreshes — never a call. When it is absent the
     * candidate carries the zone id alone, which is honest and still actionable.
     */
    const zone = this.zones?.(envelope.tenantId, envelope.zoneId);
    if (zone !== undefined) {
      context.zoneName = zone.name;
      context.zoneVersion = zone.version;
    } else if (envelope.zoneId !== undefined) {
      /*
       * ⚠️ **Counted, because the consequence is not cosmetic.** A miss costs the candidate its
       * `zoneVersion`, and that is what an incident detail page uses to fetch the geometry *as it was
       * judged*. Without it the page falls back to today's polygon and quietly answers a different
       * question. The candidate is still raised and still actionable — the miss must never block an
       * alert — but a deployment with a non-zero rate here has incidents that cannot be re-examined
       * against their own evidence, and nothing else would say so.
       */
      this.metrics?.zoneNameUnresolved.inc();
    }
    return context;
  }
}
