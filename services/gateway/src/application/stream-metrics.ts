/**
 * Prometheus metrics for the real-time delivery subsystem (Architect G-5 recs 2 & 3). Wraps the
 * per-instance /metrics registry (never the global default, so multiple app instances in tests do
 * not collide). Implements the transport-agnostic `StreamMetricsSink` the StreamHub depends on, so
 * the hub never imports prom-client and tests can inject a no-op.
 */
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import type { StreamPriority, StreamTopic } from '@vip/contracts';
import type { StreamMetricsSink } from './stream-hub.js';

export class StreamMetrics implements StreamMetricsSink {
  readonly #active: Gauge<'tenant'>;
  readonly #subscriptions: Gauge<string>;
  readonly #queueDepth: Gauge<string>;
  readonly #reconnects: Counter<string>;
  readonly #replays: Counter<string>;
  readonly #dropped: Counter<'priority'>;
  readonly #deliveredTotal: Counter<'topic' | 'priority'>;
  readonly #heartbeats: Counter<'ok'>;
  /** End-to-end latency: domain-event `occurredAt` → gateway delivered to the client socket. */
  readonly #e2eLatency: Histogram<string>;
  /** Edge latency: gateway received from the backbone → gateway delivered to the client socket. */
  readonly #edgeLatency: Histogram<string>;

  constructor(registry: Registry) {
    this.#active = new Gauge({
      name: 'stream_active_connections',
      help: 'Active SSE stream connections',
      labelNames: ['tenant'],
      registers: [registry],
    });
    this.#subscriptions = new Gauge({
      name: 'stream_upstream_subscriptions',
      help: 'Active upstream backbone subscriptions (per tenant × source)',
      registers: [registry],
    });
    this.#queueDepth = new Gauge({
      name: 'stream_queue_depth',
      help: 'Total buffered frames across all connection send-queues',
      registers: [registry],
    });
    this.#reconnects = new Counter({
      name: 'stream_reconnects_total',
      help: 'Connections that resumed with a Last-Event-ID',
      registers: [registry],
    });
    this.#replays = new Counter({
      name: 'stream_replayed_events_total',
      help: 'Frames re-delivered from the ring buffer on reconnect',
      registers: [registry],
    });
    this.#dropped = new Counter({
      name: 'stream_dropped_events_total',
      help: 'Frames dropped under backpressure, by priority',
      labelNames: ['priority'],
      registers: [registry],
    });
    this.#deliveredTotal = new Counter({
      name: 'stream_delivered_events_total',
      help: 'Frames delivered to clients, by topic and priority',
      labelNames: ['topic', 'priority'],
      registers: [registry],
    });
    this.#heartbeats = new Counter({
      name: 'stream_heartbeats_total',
      help: 'Heartbeat control frames, by outcome',
      labelNames: ['ok'],
      registers: [registry],
    });
    this.#e2eLatency = new Histogram({
      name: 'stream_delivery_latency_seconds',
      help: 'End-to-end latency: event occurredAt → delivered to client',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
    this.#edgeLatency = new Histogram({
      name: 'stream_edge_latency_seconds',
      help: 'Edge latency: gateway received from backbone → delivered to client',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
      registers: [registry],
    });
  }

  connectionOpened(tenantId: string): void {
    this.#active.inc({ tenant: tenantId });
  }
  connectionClosed(tenantId: string): void {
    this.#active.dec({ tenant: tenantId });
  }
  reconnect(): void {
    this.#reconnects.inc();
  }
  replayed(count: number): void {
    if (count > 0) this.#replays.inc(count);
  }
  dropped(priority: StreamPriority): void {
    this.#dropped.inc({ priority });
  }
  delivered(
    topic: StreamTopic,
    priority: StreamPriority,
    endToEndSeconds: number | undefined,
    edgeSeconds: number,
  ): void {
    this.#deliveredTotal.inc({ topic, priority });
    if (endToEndSeconds !== undefined && endToEndSeconds >= 0) {
      this.#e2eLatency.observe(endToEndSeconds);
    }
    if (edgeSeconds >= 0) this.#edgeLatency.observe(edgeSeconds);
  }
  heartbeat(ok: boolean): void {
    this.#heartbeats.inc({ ok: ok ? 'true' : 'false' });
  }
  subscriptions(n: number): void {
    this.#subscriptions.set(n);
  }
  queueDepth(total: number): void {
    this.#queueDepth.set(total);
  }
}
