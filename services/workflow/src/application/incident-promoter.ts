/**
 * Application: the incident promoter consumer. Subscribes to `incident.candidate` (filter
 * `t.*.incident.candidate` on the AUTOMATION stream) and, per candidate, idempotently promotes it to
 * a persisted `raised` incident via `IncidentService`, which publishes `incident.raised`.
 *
 * Loops are impossible by construction: this consumer filters ONLY `incident.candidate`, while its
 * outputs land on `incident.raised|acknowledged|resolved|closed` — the same stream, different
 * subjects, never re-consumed here. Fail-closed: a message that is not a valid `IncidentCandidate`
 * is dead-lettered (`term`), never promoted. A transient store failure is `nak`'d for redelivery.
 */
import { IncidentCandidate } from '@vip/contracts';
import {
  ALL_INCIDENT_CANDIDATES,
  ALL_INCIDENTS,
  ALL_RULE_MATCHES,
  AUTOMATION_STREAM,
  type BusMessage,
  type EventBus,
  type Subscription,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import type { IncidentService } from './incident-service.js';
import type { IncidentMetrics } from './metrics.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;

export interface IncidentPromoterDeps {
  bus: EventBus;
  service: IncidentService;
  metrics?: IncidentMetrics;
  log?: LogFn;
  durable?: string;
}

export class IncidentPromoter {
  private readonly bus: EventBus;
  private readonly service: IncidentService;
  private readonly metrics: IncidentMetrics | undefined;
  private readonly log: LogFn;
  private readonly durable: string;
  private sub?: Subscription;

  constructor(deps: IncidentPromoterDeps) {
    this.bus = deps.bus;
    this.service = deps.service;
    this.metrics = deps.metrics;
    this.log = deps.log ?? (() => {});
    this.durable = deps.durable ?? 'workflow-incidents';
  }

  async start(): Promise<void> {
    // The AUTOMATION stream captures both the candidate we consume and the lifecycle we publish.
    await this.bus.ensureStream(AUTOMATION_STREAM, [ALL_INCIDENTS, ALL_RULE_MATCHES]);
    this.sub = await this.bus.subscribe(
      { stream: AUTOMATION_STREAM, durable: this.durable, filterSubject: ALL_INCIDENT_CANDIDATES },
      (msg) => this.onMessage(msg),
    );
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }

  async onMessage(msg: BusMessage): Promise<void> {
    let raw: unknown;
    try {
      raw = msg.json();
    } catch {
      this.metrics?.candidatesDeadLettered.inc();
      msg.term();
      return;
    }
    const parsed = IncidentCandidate.safeParse(raw);
    if (!parsed.success) {
      this.metrics?.candidatesDeadLettered.inc();
      this.log('warn', 'dead-lettering: not a valid IncidentCandidate', {
        subject: msg.subject,
        issue: parsed.error.issues[0]?.message,
      });
      msg.term();
      return;
    }
    const candidate = parsed.data;
    try {
      const scope = TenantScope.fromTenantId(candidate.tenantId);
      const { incident, created } = await this.service.promote(scope, candidate);
      if (created) {
        this.log('info', 'incident raised', {
          incidentId: incident.id,
          severity: incident.severity,
          correlationId: incident.correlationId,
        });
      }
      msg.ack();
    } catch (err) {
      this.log('error', 'incident promotion failed; will redeliver', {
        subject: msg.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      msg.nak();
    }
  }
}
