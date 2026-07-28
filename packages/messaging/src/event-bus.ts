/**
 * The `EventBus` port — the narrow surface the platform depends on, so no service imports the NATS
 * client directly. Publishing is durable (JetStream) with an optional `msgId` for source-side
 * dedup; consuming is a durable pull consumer whose handler explicitly `ack`/`nak`/`term`s each
 * message (at-least-once + idempotent consumers, ADR-0005). `term()` is the dead-letter path: a
 * poison/unprocessable message (e.g. missing tenant) is terminated, never redelivered.
 */
import { MessagingError } from './errors.js';
import { subjectMatches } from './subjects.js';

/** A message delivered to a consumer. The handler owns the ack decision. */
export interface BusMessage {
  readonly subject: string;
  /** JetStream stream sequence (0 for the in-memory bus). */
  readonly seq: number;
  /** How many times this message has been delivered (1 on first delivery). */
  readonly deliveryCount: number;
  /** Decode the JSON payload; throws `MessagingError` on malformed JSON (caller should `term()`). */
  json<T = unknown>(): T;
  /** Acknowledge — processed successfully; do not redeliver. */
  ack(): void;
  /** Negative-ack — retry later (optionally after `delayMs`). */
  nak(delayMs?: number): void;
  /** Terminate — unprocessable/poison; dead-letter and never redeliver. */
  term(): void;
}

export type MessageHandler = (msg: BusMessage) => Promise<void> | void;

export interface SubscribeOptions {
  /** JetStream stream to consume from (created via `ensureStream`). */
  stream: string;
  /** Durable consumer name — resuming with the same name continues where it left off. */
  durable: string;
  /** Subject filter (may contain `*`/`>`); must be covered by the stream's subjects. */
  filterSubject: string;
  /** Max redeliveries before the bus itself terminates a message to the DLQ (default 5). */
  maxDeliver?: number;
}

/** A live subscription; `stop()` drains and detaches the consumer. */
export interface Subscription {
  stop(): Promise<void>;
}

export interface PublishOptions {
  /** JetStream dedup id — a duplicate publish with the same id within the stream window is dropped. */
  msgId?: string;
}

export interface EventBus {
  /** Ensure a durable stream capturing `subjects` exists (idempotent). */
  ensureStream(name: string, subjects: string[]): Promise<void>;
  /** Publish a JSON payload durably to `subject`. */
  publish(subject: string, data: unknown, opts?: PublishOptions): Promise<void>;
  /** Attach a durable pull consumer; `handler` runs per message and must ack/nak/term. */
  subscribe(opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription>;
  /** Flush and close the connection. */
  close(): Promise<void>;
}

// --- In-memory bus (tests + local, no broker) --------------------------------------------------

interface StoredMsg {
  subject: string;
  data: unknown;
  msgId?: string;
}

interface Registration {
  opts: SubscribeOptions;
  handler: MessageHandler;
}

/** Records the disposition of a delivered in-memory message, for test assertions. */
export interface DeliveredRecord {
  subject: string;
  disposition: 'ack' | 'nak' | 'term' | 'pending';
}

/**
 * A broker-free `EventBus` for unit tests and local wiring. Publishing routes synchronously to every
 * matching subscriber (mirroring JetStream subject routing); message-id dedup within a stream is
 * honoured. It is NOT durable and does not redeliver — enough to prove normalize/dedup/persist
 * logic without a running NATS.
 */
export class InMemoryEventBus implements EventBus {
  private readonly streams = new Map<string, string[]>();
  private readonly subs = new Set<Registration>();
  private readonly seenMsgIds = new Set<string>();
  /** Everything published, in order (for assertions). */
  readonly published: StoredMsg[] = [];
  /** Every delivery attempt and how the handler dispositioned it (for assertions). */
  readonly delivered: DeliveredRecord[] = [];

  async ensureStream(name: string, subjects: string[]): Promise<void> {
    this.streams.set(name, subjects);
  }

  async publish(subject: string, data: unknown, opts?: PublishOptions): Promise<void> {
    if (opts?.msgId) {
      if (this.seenMsgIds.has(opts.msgId)) return; // dedup
      this.seenMsgIds.add(opts.msgId);
    }
    this.published.push({ subject, data, ...(opts?.msgId ? { msgId: opts.msgId } : {}) });
    for (const reg of this.subs) {
      if (subjectMatches(reg.opts.filterSubject, subject)) {
        await this.deliver(reg, subject, data);
      }
    }
  }

  private async deliver(reg: Registration, subject: string, data: unknown): Promise<void> {
    const record: DeliveredRecord = { subject, disposition: 'pending' };
    this.delivered.push(record);
    const msg: BusMessage = {
      subject,
      seq: 0,
      deliveryCount: 1,
      json<T>() {
        return data as T;
      },
      ack() {
        record.disposition = 'ack';
      },
      nak() {
        record.disposition = 'nak';
      },
      term() {
        record.disposition = 'term';
      },
    };
    await reg.handler(msg);
  }

  async subscribe(opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription> {
    const reg: Registration = { opts, handler };
    this.subs.add(reg);
    return {
      stop: async () => {
        this.subs.delete(reg);
      },
    };
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}

/** Decode a Uint8Array JSON payload, throwing `MessagingError` on malformed input. */
export function decodeJson<T = unknown>(bytes: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (e) {
    throw new MessagingError(`payload is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
}
