/**
 * Application: the ingest pipeline. Subscribes to capability outputs on the backbone and, per
 * message: decode → validate (`DetectionResult`) → normalize → dedup+persist (tenant-scoped) →
 * publish the persisted envelope on `t.{tenantId}.event.*`. Fail-closed at every step (Law 5):
 * a payload that is not valid JSON, does not satisfy the contract (e.g. missing `tenantId`), or
 * whose subject tenant disagrees with its body is **terminated** to the dead-letter path — never
 * processed, never redelivered. Persist is idempotent, so at-least-once redelivery is safe; a
 * duplicate (already-persisted) is not re-published.
 */
import { DetectionResult } from '@vip/contracts';
import {
  ALL_CAPABILITY_OUTPUTS,
  ALL_EVENTS,
  CAPABILITY_OUTPUT_STREAM,
  EVENTS_STREAM,
  eventSubject,
  tenantIdFromSubject,
  type BusMessage,
  type EventBus,
  type Subscription,
} from '@vip/messaging';
import { TenantScope } from '@vip/tenancy';
import { dedupKey, normalizeDetectionResult } from '../domain/event-normalizer.js';
import type { EventStore } from './ports.js';

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: object) => void;

export interface EventIngestDeps {
  bus: EventBus;
  store: EventStore;
  dedupWindowMs: number;
  now?: () => Date;
  newId?: () => string;
  log?: LogFn;
  /** Durable consumer name (defaults to `events-normalizer`). */
  durable?: string;
}

export interface IngestOutcome {
  persisted: number;
  deduped: number;
  detections: number;
}

export class EventIngestService {
  private readonly bus: EventBus;
  private readonly store: EventStore;
  private readonly dedupWindowMs: number;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: LogFn;
  private readonly durable: string;
  private sub?: Subscription;

  constructor(deps: EventIngestDeps) {
    this.bus = deps.bus;
    this.store = deps.store;
    this.dedupWindowMs = deps.dedupWindowMs;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.durable = deps.durable ?? 'events-normalizer';
  }

  /** Ensure both streams exist and attach the durable consumer. */
  async start(): Promise<void> {
    // The input stream (capability outputs) AND the output stream (persisted events) must exist
    // before we consume or publish — else the `t.{tenant}.event.*` publish has no stream to land on.
    await this.bus.ensureStream(CAPABILITY_OUTPUT_STREAM, [ALL_CAPABILITY_OUTPUTS]);
    await this.bus.ensureStream(EVENTS_STREAM, [ALL_EVENTS]);
    this.sub = await this.bus.subscribe(
      {
        stream: CAPABILITY_OUTPUT_STREAM,
        durable: this.durable,
        filterSubject: ALL_CAPABILITY_OUTPUTS,
      },
      (msg) => this.onMessage(msg),
    );
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }

  /** Handle one delivered message. Owns its ack/term decision. */
  async onMessage(msg: BusMessage): Promise<void> {
    let raw: unknown;
    try {
      raw = msg.json();
    } catch {
      this.log('warn', 'dead-lettering: payload is not valid JSON', { subject: msg.subject });
      msg.term();
      return;
    }

    const parsed = DetectionResult.safeParse(raw);
    if (!parsed.success) {
      this.log('warn', 'dead-lettering: not a valid DetectionResult (fail-closed)', {
        subject: msg.subject,
        issue: parsed.error.issues[0]?.message,
      });
      msg.term();
      return;
    }
    const result = parsed.data;

    // Defence in depth: the subject's tenant token must match the body's tenantId.
    const subjectTenant = tenantIdFromSubject(msg.subject);
    if (subjectTenant && subjectTenant !== result.tenantId) {
      this.log('error', 'dead-lettering: subject/body tenant mismatch (cross-tenant)', {
        subject: msg.subject,
        bodyTenant: result.tenantId,
      });
      msg.term();
      return;
    }

    try {
      const outcome = await this.ingest(result);
      msg.ack();
      this.log('info', 'ingested capability output', { subject: msg.subject, ...outcome });
    } catch (err) {
      // Transient (store/broker) failure — let the bus redeliver (do NOT ack).
      this.log('error', 'ingest failed; will redeliver', {
        subject: msg.subject,
        err: err instanceof Error ? err.message : String(err),
      });
      msg.nak();
    }
  }

  /** Normalize → persist (dedup) → publish. Pure of transport concerns; reusable/testable. */
  async ingest(result: DetectionResult): Promise<IngestOutcome> {
    const scope = TenantScope.fromTenantId(result.tenantId);
    const envelopes = normalizeDetectionResult(result, { now: this.now, newId: this.newId });
    let persisted = 0;
    let deduped = 0;
    for (const envelope of envelopes) {
      const key = dedupKey(envelope, this.dedupWindowMs);
      const isNew = await this.store.persist(scope, envelope, key);
      if (!isNew) {
        deduped++;
        continue;
      }
      persisted++;
      await this.bus.publish(eventSubject(envelope.tenantId, envelope.type), envelope, {
        msgId: envelope.id,
      });
    }
    return { persisted, deduped, detections: envelopes.length };
  }
}
