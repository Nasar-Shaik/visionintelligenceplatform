/**
 * StreamHub (P2-2 G-5) — the transport-AGNOSTIC core of real-time delivery. It owns everything the
 * transport should NOT: per-tenant backbone subscriptions, cursor assignment, the bounded reconnect
 * ring buffer, per-connection send-queues with priority-aware backpressure, the connection lifecycle,
 * heartbeat/duration timers, diagnostics, and metrics. It talks to the outside world only through a
 * `ConnectionSink` (an SSE adapter today; a WebSocket/gRPC adapter later — Architect rec 5) and an
 * `EventBus` (InMemoryEventBus in tests, NatsEventBus in prod — dependency-injected).
 *
 * Tenant isolation is structural: a connection's upstream consumers are filtered to `t.{itsTenant}.…`
 * and it is only ever fanned frames from its own tenant channel. Permission filtering happens BEFORE
 * `open()` (the route resolves requested ∩ permitted topics); the hub trusts the resolved set.
 *
 * Grounds: docs/architecture/phase2/REALTIME_DELIVERY.md, 09-EVENT-PLATFORM.md.
 */
import { randomUUID } from 'node:crypto';
import type { EventBus, Subscription } from '@vip/messaging';
import { tenantIdFromSubject } from '@vip/messaging';
import type { StreamControl, StreamEnvelope, StreamPriority, StreamTopic } from '@vip/contracts';
import { STREAM_PRIORITY_RANK } from '@vip/contracts';
import {
  classifyPriority,
  sourcesForTopics,
  subjectToTopic,
  typeFromSubject,
  type ConnectionState,
  type StreamSource,
} from '../domain/stream.js';

/**
 * The one-way transport port. The hub hands it typed frames; the adapter serializes (SSE `id:`/
 * `event:`/`data:` lines today) and writes to its socket. `deliver*` return the transport's writable
 * state AFTER the write (false ⇒ saturated → the hub pauses and waits for `onDrain`).
 */
export interface ConnectionSink {
  deliver(env: StreamEnvelope): boolean;
  deliverControl(ctl: StreamControl): boolean;
  writable(): boolean;
  onDrain(cb: () => void): void;
  close(): void;
}

/** Metrics port (implemented by StreamMetrics; NoopStreamMetrics in tests). */
export interface StreamMetricsSink {
  connectionOpened(tenantId: string): void;
  connectionClosed(tenantId: string): void;
  reconnect(): void;
  replayed(count: number): void;
  dropped(priority: StreamPriority): void;
  delivered(
    topic: StreamTopic,
    priority: StreamPriority,
    endToEndSeconds: number | undefined,
    edgeSeconds: number,
  ): void;
  heartbeat(ok: boolean): void;
  subscriptions(n: number): void;
  queueDepth(total: number): void;
}

export class NoopStreamMetrics implements StreamMetricsSink {
  connectionOpened(): void {}
  connectionClosed(): void {}
  reconnect(): void {}
  replayed(): void {}
  dropped(): void {}
  delivered(): void {}
  heartbeat(): void {}
  subscriptions(): void {}
  queueDepth(): void {}
}

/** Config-driven operational limits (Architect rec 4). All wired from env in the gateway config. */
export interface StreamHubLimits {
  maxConnectionsPerTenant: number;
  maxQueueDepth: number;
  replayBufferSize: number;
  heartbeatIntervalMs: number;
  maxConnectionDurationMs: number;
}

export interface OpenConnectionInput {
  connectionId?: string | undefined;
  tenantId: string;
  /** Already resolved to requested ∩ permitted by the route. */
  topics: StreamTopic[];
  lastEventId?: string | undefined;
  sink: ConnectionSink;
  /** Effective max duration for THIS connection (route passes min(limit, token-exp)). */
  maxDurationMs?: number | undefined;
}

/** Per-connection diagnostics snapshot (Architect rec 2). */
export interface ConnectionDiagnostics {
  connectionId: string;
  tenantId: string;
  topics: StreamTopic[];
  state: ConnectionState;
  connectedAt: string;
  durationMs: number;
  resumed: boolean;
  replayedCount: number;
  queueDepth: number;
  lastDeliveredId?: string | undefined;
  lastDeliveredAt?: string | undefined;
  heartbeats: number;
  lastHeartbeatAt?: string | undefined;
}

export interface StreamConnectionHandle {
  readonly connectionId: string;
  close(): void;
}

/** Thrown by `open()` when a tenant is at its connection ceiling (route → HTTP 429). */
export class StreamConnectionLimitError extends Error {
  constructor(public readonly tenantId: string) {
    super(`stream connection limit reached for tenant ${tenantId}`);
    this.name = 'StreamConnectionLimitError';
  }
}

interface RingItem {
  id: number;
  topic: StreamTopic;
  priority: StreamPriority;
  env: StreamEnvelope;
  receivedAt: number;
}

interface QueuedItem {
  env: StreamEnvelope;
  priority: StreamPriority;
  receivedAt: number;
}

interface Conn {
  id: string;
  tenantId: string;
  topics: Set<StreamTopic>;
  sink: ConnectionSink;
  queue: QueuedItem[];
  state: ConnectionState;
  connectedAt: number;
  resumed: boolean;
  replayedCount: number;
  lastDeliveredId?: string;
  lastDeliveredAt?: number;
  heartbeats: number;
  lastHeartbeatAt?: number;
  draining: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  durationTimer?: ReturnType<typeof setTimeout>;
}

interface TenantChannel {
  tenantId: string;
  cursor: number;
  ring: RingItem[];
  sources: Map<string, Subscription>;
  connections: Set<Conn>;
}

export interface StreamHubOptions {
  bus: EventBus;
  limits: StreamHubLimits;
  metrics?: StreamMetricsSink;
  /** Injectable clock (ms) for deterministic tests. */
  now?: () => number;
}

export class StreamHub {
  readonly #bus: EventBus;
  readonly #limits: StreamHubLimits;
  #metrics: StreamMetricsSink;
  readonly #now: () => number;
  readonly #channels = new Map<string, TenantChannel>();
  /** Unique per hub instance so durable consumer names never collide across restarts. */
  readonly #session = randomUUID().slice(0, 8);

  constructor(opts: StreamHubOptions) {
    this.#bus = opts.bus;
    this.#limits = opts.limits;
    this.#metrics = opts.metrics ?? new NoopStreamMetrics();
    this.#now = opts.now ?? Date.now;
  }

  /** Attach a metrics sink after construction (the /metrics registry is built inside the server). */
  useMetrics(metrics: StreamMetricsSink): void {
    this.#metrics = metrics;
  }

  /** Open a connection: enforce the ceiling, ensure upstream subs, replay, then stream. */
  async open(input: OpenConnectionInput): Promise<StreamConnectionHandle> {
    const channel = this.#channelFor(input.tenantId);
    if (channel.connections.size >= this.#limits.maxConnectionsPerTenant) {
      throw new StreamConnectionLimitError(input.tenantId);
    }

    const conn: Conn = {
      id: input.connectionId ?? randomUUID(),
      tenantId: input.tenantId,
      topics: new Set(input.topics),
      sink: input.sink,
      queue: [],
      state: 'subscribed',
      connectedAt: this.#now(),
      resumed: false,
      replayedCount: 0,
      heartbeats: 0,
      draining: false,
    };
    channel.connections.add(conn);
    await this.#ensureSources(channel);
    this.#metrics.connectionOpened(input.tenantId);

    // ready control frame — echoes the granted topics + the resume cursor.
    conn.sink.deliverControl({
      type: 'ready',
      at: new Date(this.#now()).toISOString(),
      topics: [...conn.topics],
      cursor: String(channel.cursor),
    });

    // Reconnect replay from the bounded ring buffer (Architect rec 4 — current strategy).
    if (input.lastEventId !== undefined) {
      const from = Number(input.lastEventId);
      if (Number.isFinite(from)) {
        const missed = channel.ring.filter((r) => r.id > from && conn.topics.has(r.topic));
        if (missed.length > 0) {
          conn.resumed = true;
          conn.replayedCount = missed.length;
          this.#metrics.reconnect();
          this.#metrics.replayed(missed.length);
          for (const r of missed) this.#enqueue(conn, r.env, r.priority, r.receivedAt);
        } else {
          conn.resumed = true;
          this.#metrics.reconnect();
        }
      }
    }

    conn.state = 'streaming';
    this.#startTimers(conn, input.maxDurationMs);
    this.#pump(conn);

    return { connectionId: conn.id, close: () => this.#close(conn) };
  }

  /** Is there room for another connection on this tenant? (Route pre-check → clean HTTP 429.) */
  hasCapacity(tenantId: string): boolean {
    const channel = this.#channels.get(tenantId);
    return !channel || channel.connections.size < this.#limits.maxConnectionsPerTenant;
  }

  /**
   * Snapshot of active connections (Architect rec 2 — internal diagnostics). Scoped to `tenantId`
   * when given (tenant isolation — a caller only ever sees its own tenant's connections).
   */
  diagnostics(tenantId?: string): ConnectionDiagnostics[] {
    const out: ConnectionDiagnostics[] = [];
    const now = this.#now();
    for (const channel of this.#channels.values()) {
      if (tenantId !== undefined && channel.tenantId !== tenantId) continue;
      for (const c of channel.connections) {
        out.push({
          connectionId: c.id,
          tenantId: c.tenantId,
          topics: [...c.topics],
          state: c.state,
          connectedAt: new Date(c.connectedAt).toISOString(),
          durationMs: now - c.connectedAt,
          resumed: c.resumed,
          replayedCount: c.replayedCount,
          queueDepth: c.queue.length,
          lastDeliveredId: c.lastDeliveredId,
          lastDeliveredAt: c.lastDeliveredAt
            ? new Date(c.lastDeliveredAt).toISOString()
            : undefined,
          heartbeats: c.heartbeats,
          lastHeartbeatAt: c.lastHeartbeatAt
            ? new Date(c.lastHeartbeatAt).toISOString()
            : undefined,
        });
      }
    }
    return out;
  }

  /** Detach all subscriptions and close all connections (graceful shutdown). */
  async close(): Promise<void> {
    for (const channel of [...this.#channels.values()]) {
      for (const c of [...channel.connections]) this.#close(c, 'server shutting down');
    }
  }

  // --- internals --------------------------------------------------------------------------------

  #channelFor(tenantId: string): TenantChannel {
    let channel = this.#channels.get(tenantId);
    if (!channel) {
      channel = { tenantId, cursor: 0, ring: [], sources: new Map(), connections: new Set() };
      this.#channels.set(tenantId, channel);
    }
    return channel;
  }

  /** Ensure exactly the upstream consumers needed by the tenant's union of active topics exist. */
  async #ensureSources(channel: TenantChannel): Promise<void> {
    const union = new Set<StreamTopic>();
    for (const c of channel.connections) for (const t of c.topics) union.add(t);
    const needed = sourcesForTopics([...union]);
    const neededKeys = new Set(needed.map((s) => s.key));

    // Stop sources no longer needed.
    for (const [key, sub] of [...channel.sources]) {
      if (!neededKeys.has(key)) {
        await sub.stop();
        channel.sources.delete(key);
      }
    }
    // Start missing sources.
    for (const source of needed) {
      if (!channel.sources.has(source.key)) {
        const sub = await this.#subscribeSource(channel, source);
        channel.sources.set(source.key, sub);
      }
    }
    this.#reportSubscriptionCount();
  }

  #subscribeSource(channel: TenantChannel, source: StreamSource): Promise<Subscription> {
    return this.#bus.subscribe(
      {
        stream: source.stream,
        durable: `gw-stream-${source.key}-${channel.tenantId}-${this.#session}`,
        filterSubject: source.filterSubject(channel.tenantId),
        deliverNew: true, // live fan-out — never a full-stream replay (ring buffer serves catch-up)
      },
      (msg) => {
        this.#ingest(channel, msg.subject, () => msg.json());
        msg.ack();
      },
    );
  }

  /** Classify → build envelope → ring-buffer → fan out to interested connections. */
  #ingest(channel: TenantChannel, subject: string, read: () => unknown): void {
    const topic = subjectToTopic(subject);
    if (!topic) return; // internal (e.g. incident.candidate) — never streamed to clients
    // Defence in depth: the subject is tenant-scoped by the filter, but re-check.
    if (tenantIdFromSubject(subject) !== channel.tenantId) return;

    const payload = read();
    const receivedAt = this.#now();
    const type = typeFromSubject(subject);
    const priority = classifyPriority(topic, type, payload);
    const occurredAt = readOccurredAt(payload) ?? new Date(receivedAt).toISOString();
    channel.cursor += 1;
    const id = String(channel.cursor);
    const env: StreamEnvelope = {
      id,
      streamVersion: '1.0.0',
      topic,
      tenantId: channel.tenantId,
      type,
      priority,
      occurredAt,
      payload,
    };

    channel.ring.push({ id: channel.cursor, topic, priority, env, receivedAt });
    if (channel.ring.length > this.#limits.replayBufferSize) channel.ring.shift();

    for (const conn of channel.connections) {
      if (conn.topics.has(topic)) this.#enqueue(conn, env, priority, receivedAt);
    }
  }

  /** Enqueue with priority-aware backpressure: evict the least-urgent frame when the queue is full. */
  #enqueue(conn: Conn, env: StreamEnvelope, priority: StreamPriority, receivedAt: number): void {
    if (conn.queue.length >= this.#limits.maxQueueDepth) {
      // Find the least-urgent queued item (highest rank number).
      let worstIdx = 0;
      for (let i = 1; i < conn.queue.length; i++) {
        if (
          STREAM_PRIORITY_RANK[conn.queue[i]!.priority] >
          STREAM_PRIORITY_RANK[conn.queue[worstIdx]!.priority]
        ) {
          worstIdx = i;
        }
      }
      const worst = conn.queue[worstIdx]!;
      // Future coalescing (Architect rec 6) would hook here: instead of dropping a LOW frame, merge
      // it into a pending summary. For G-5 we drop, always sparing the more-urgent frame.
      if (STREAM_PRIORITY_RANK[priority] <= STREAM_PRIORITY_RANK[worst.priority]) {
        conn.queue.splice(worstIdx, 1);
        this.#metrics.dropped(worst.priority);
        conn.queue.push({ env, priority, receivedAt });
      } else {
        this.#metrics.dropped(priority); // incoming is the least urgent — drop it
      }
    } else {
      conn.queue.push({ env, priority, receivedAt });
    }
    this.#reportQueueDepth();
    this.#pump(conn);
  }

  /** Drain a connection's queue to its sink, honouring transport backpressure. */
  #pump(conn: Conn): void {
    if (conn.state === 'closed') return;
    while (conn.queue.length > 0 && conn.sink.writable()) {
      const item = conn.queue.shift()!;
      const now = this.#now();
      const writable = conn.sink.deliver(item.env);
      conn.lastDeliveredId = item.env.id;
      conn.lastDeliveredAt = now;
      const occurredMs = Date.parse(item.env.occurredAt);
      const e2e = Number.isFinite(occurredMs) ? (now - occurredMs) / 1000 : undefined;
      this.#metrics.delivered(item.env.topic, item.priority, e2e, (now - item.receivedAt) / 1000);
      if (!writable) break; // socket buffer filled mid-drain — wait for 'drain'
    }
    // If frames remain and the transport is saturated, arm a one-shot drain listener to resume.
    if (conn.queue.length > 0 && !conn.sink.writable() && !conn.draining) {
      conn.draining = true;
      conn.sink.onDrain(() => {
        conn.draining = false;
        this.#pump(conn);
      });
    }
    this.#reportQueueDepth();
  }

  #startTimers(conn: Conn, maxDurationMs?: number): void {
    const hb = this.#limits.heartbeatIntervalMs;
    if (hb > 0) {
      conn.heartbeatTimer = setInterval(() => this.#heartbeat(conn), hb);
      if (typeof conn.heartbeatTimer.unref === 'function') conn.heartbeatTimer.unref();
    }
    const dur = Math.min(maxDurationMs ?? Infinity, this.#limits.maxConnectionDurationMs);
    if (Number.isFinite(dur) && dur > 0) {
      conn.durationTimer = setTimeout(() => {
        conn.sink.deliverControl({
          type: 'error',
          at: new Date(this.#now()).toISOString(),
          detail: 'max connection duration reached — please reconnect',
        });
        this.#close(conn);
      }, dur);
      if (typeof conn.durationTimer.unref === 'function') conn.durationTimer.unref();
    }
  }

  #heartbeat(conn: Conn): void {
    try {
      conn.sink.deliverControl({ type: 'heartbeat', at: new Date(this.#now()).toISOString() });
      conn.heartbeats += 1;
      conn.lastHeartbeatAt = this.#now();
      this.#metrics.heartbeat(true);
    } catch {
      // A dead socket surfaces as a write throw — treat it as a failed heartbeat and close.
      this.#metrics.heartbeat(false);
      this.#close(conn, 'heartbeat failed');
    }
  }

  #close(conn: Conn, reason?: string): void {
    if (conn.state === 'closed') return;
    conn.state = 'closed';
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
    if (conn.durationTimer) clearTimeout(conn.durationTimer);
    const channel = this.#channels.get(conn.tenantId);
    if (channel) {
      channel.connections.delete(conn);
      if (channel.connections.size === 0) {
        void this.#teardownChannel(channel);
      } else {
        void this.#ensureSources(channel);
      }
    }
    this.#metrics.connectionClosed(conn.tenantId);
    try {
      if (reason) {
        conn.sink.deliverControl({
          type: 'error',
          at: new Date(this.#now()).toISOString(),
          detail: reason,
        });
      }
    } catch {
      // best-effort; the socket may already be gone
    }
    conn.sink.close();
  }

  async #teardownChannel(channel: TenantChannel): Promise<void> {
    // Detach synchronously (clear + delete + report) BEFORE awaiting the network stops, so the
    // channel is gone from diagnostics/metrics immediately; the socket teardown drains after.
    const subs = [...channel.sources.values()];
    channel.sources.clear();
    this.#channels.delete(channel.tenantId);
    this.#reportSubscriptionCount();
    for (const sub of subs) await sub.stop();
  }

  #reportSubscriptionCount(): void {
    let n = 0;
    for (const channel of this.#channels.values()) n += channel.sources.size;
    this.#metrics.subscriptions(n);
  }

  #reportQueueDepth(): void {
    let total = 0;
    for (const channel of this.#channels.values()) {
      for (const c of channel.connections) total += c.queue.length;
    }
    this.#metrics.queueDepth(total);
  }
}

/** Best-effort read of a domain event's `occurredAt` from an opaque payload. */
function readOccurredAt(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const v =
      (payload as Record<string, unknown>).occurredAt ??
      (payload as Record<string, unknown>).createdAt;
    if (typeof v === 'string') return v;
  }
  return undefined;
}
