/**
 * `EventBus` over NATS JetStream (ADR-0016) — the durable backbone in cloud and (via leaf nodes) at
 * edge. Streams are file-backed and tenant-partitioned by subject; consumers are durable pull
 * consumers with explicit ack. A message that exceeds `maxDeliver` is terminated to the dead-letter
 * path rather than looping forever. The heavy client (`nats`) is confined to this file so the rest
 * of the platform depends only on the `EventBus` port.
 */
import { connect, type NatsConnection } from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerMessages,
  type JsMsg,
} from '@nats-io/jetstream';
import {
  type BusMessage,
  type EventBus,
  type MessageHandler,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
  decodeJson,
} from './event-bus.js';

export interface NatsEventBusOptions {
  /** NATS server URL(s), e.g. `nats://localhost:44222`. */
  servers: string;
  /** Optional client name for monitoring. */
  name?: string;
  /** Stream retention age in ms (default 7 days). */
  maxAgeMs?: number;
}

const encoder = new TextEncoder();
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DELIVER = 5;

export class NatsEventBus implements EventBus {
  private constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly maxAgeMs: number,
  ) {}

  /** Connect and initialise JetStream. Throws if the broker is unreachable (fail-fast). */
  static async connect(opts: NatsEventBusOptions): Promise<NatsEventBus> {
    const nc = await connect({ servers: opts.servers, name: opts.name ?? 'vip-messaging' });
    const jsm = await jetstreamManager(nc);
    const js = jetstream(nc);
    return new NatsEventBus(nc, js, jsm, opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
  }

  async ensureStream(name: string, subjects: string[]): Promise<void> {
    const config = {
      name,
      subjects,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: this.maxAgeMs * 1_000_000, // ms → ns
      // JetStream de-duplicates publishes carrying the same Nats-Msg-Id within this window.
      duplicate_window: 2 * 60 * 1000 * 1_000_000, // 2 min in ns
    };
    try {
      await this.jsm.streams.add(config);
    } catch {
      // Already exists (or subjects changed) — reconcile subjects idempotently.
      await this.jsm.streams.update(name, config);
    }
  }

  async publish(subject: string, data: unknown, opts?: PublishOptions): Promise<void> {
    const payload = encoder.encode(JSON.stringify(data));
    await this.js.publish(subject, payload, opts?.msgId ? { msgID: opts.msgId } : undefined);
  }

  async subscribe(opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription> {
    const maxDeliver = opts.maxDeliver ?? DEFAULT_MAX_DELIVER;
    await this.jsm.consumers.add(opts.stream, {
      durable_name: opts.durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: opts.deliverNew ? DeliverPolicy.New : DeliverPolicy.All,
      filter_subject: opts.filterSubject,
      max_deliver: maxDeliver,
    });

    const consumer = await this.js.consumers.get(opts.stream, opts.durable);
    const messages: ConsumerMessages = await consumer.consume();

    // Drive the async iterator in the background; each message is dispositioned by the handler.
    void (async () => {
      for await (const m of messages) {
        await this.dispatch(m, handler, maxDeliver);
      }
    })();

    return {
      stop: async () => {
        await messages.close();
      },
    };
  }

  private async dispatch(m: JsMsg, handler: MessageHandler, maxDeliver: number): Promise<void> {
    const deliveryCount = m.info.deliveryCount;
    const msg: BusMessage = {
      subject: m.subject,
      seq: m.seq,
      deliveryCount,
      json<T>() {
        return decodeJson<T>(m.data);
      },
      ack: () => m.ack(),
      nak: (delayMs?: number) => m.nak(delayMs),
      term: () => m.term(),
    };
    try {
      await handler(msg);
    } catch {
      // Unhandled failure: retry until the ceiling, then dead-letter (term) instead of looping.
      if (deliveryCount >= maxDeliver) m.term();
      else m.nak();
    }
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
