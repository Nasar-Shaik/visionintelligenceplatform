/**
 * Application: the incident → evidence consumer. Subscribes to **`incident.raised`** (frozen 22 §11:
 * Evidence consumes `incident.raised`) and hands each raised incident to an injected
 * `IncidentEvidenceExtractor`. The extractor is the seam where a future media source (the ring-buffer
 * clip / key-frame snapshot from the Media context) materialises evidence and registers it via the
 * `EvidenceService`. G-4 ships the wiring + a **no-op** default extractor (live extraction needs the
 * media frame source, deferred — see README/TD): the event path is real and tested; only the pixels
 * are deferred. Fail-closed: a non-Incident payload is dead-lettered (`term`), never processed.
 *
 * Loop-free by construction: it only consumes `incident.raised` and publishes onto the distinct
 * `t.*.evidence.>` root, which it never consumes.
 */
import { Incident } from '@vip/contracts';
import {
  ALL_INCIDENTS,
  ALL_INCIDENTS_RAISED,
  ALL_RULE_MATCHES,
  AUTOMATION_STREAM,
  type BusMessage,
  type EventBus,
  type Subscription,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import type { EvidenceService } from './evidence-service.js';
import type { EvidenceMetrics } from './metrics.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;

/**
 * Materialise + register evidence for a raised incident. The default is a no-op (no media source
 * wired yet); a future Media-backed implementation captures a snapshot/clip around the incident and
 * calls `EvidenceService.register`, preserving the Event → Incident → Evidence traceability.
 */
export interface IncidentEvidenceExtractor {
  extract(scope: TenantScope, incident: Incident): Promise<number>;
}

export class NoopIncidentEvidenceExtractor implements IncidentEvidenceExtractor {
  constructor(private readonly log: LogFn = () => {}) {}
  async extract(_scope: TenantScope, incident: Incident): Promise<number> {
    this.log('info', 'evidence extraction deferred (no media source wired)', {
      incidentId: incident.id,
      eventId: incident.triggeredBy.eventId,
    });
    return 0;
  }
}

export interface IncidentConsumerDeps {
  bus: EventBus;
  extractor: IncidentEvidenceExtractor;
  service: EvidenceService;
  metrics?: EvidenceMetrics;
  log?: LogFn;
  durable?: string;
}

export class IncidentEvidenceConsumer {
  readonly #bus: EventBus;
  readonly #extractor: IncidentEvidenceExtractor;
  readonly #metrics: EvidenceMetrics | undefined;
  readonly #log: LogFn;
  readonly #durable: string;
  #sub?: Subscription;

  constructor(deps: IncidentConsumerDeps) {
    this.#bus = deps.bus;
    this.#extractor = deps.extractor;
    this.#metrics = deps.metrics;
    this.#log = deps.log ?? (() => {});
    this.#durable = deps.durable ?? 'evidence-incidents';
  }

  async start(): Promise<void> {
    await this.#bus.ensureStream(AUTOMATION_STREAM, [ALL_INCIDENTS, ALL_RULE_MATCHES]);
    this.#sub = await this.#bus.subscribe(
      { stream: AUTOMATION_STREAM, durable: this.#durable, filterSubject: ALL_INCIDENTS_RAISED },
      (msg) => this.onMessage(msg),
    );
  }

  async stop(): Promise<void> {
    await this.#sub?.stop();
  }

  async onMessage(msg: BusMessage): Promise<void> {
    let raw: unknown;
    try {
      raw = msg.json();
    } catch {
      this.#metrics?.incidentsDeadLettered.inc();
      msg.term();
      return;
    }
    const parsed = Incident.safeParse(raw);
    if (!parsed.success) {
      this.#metrics?.incidentsDeadLettered.inc();
      this.#log('warn', 'dead-lettering: not a valid Incident', {
        subject: msg.subject,
        issue: parsed.error.issues[0]?.message,
      });
      msg.term();
      return;
    }
    this.#metrics?.incidentsConsumed.inc();
    try {
      const scope = TenantScope.fromTenantId(parsed.data.tenantId);
      const count = await this.#extractor.extract(scope, parsed.data);
      if (count > 0) {
        this.#log('info', 'evidence extracted for incident', {
          incidentId: parsed.data.id,
          count,
        });
      }
      msg.ack();
    } catch (err) {
      this.#metrics?.extractionErrors.inc();
      this.#log('error', 'evidence extraction failed; will redeliver', {
        subject: msg.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      msg.nak();
    }
  }
}
