/**
 * StreamHub unit tests (P2-2 G-5) — deterministic, broker-free (InMemoryEventBus delivers
 * synchronously on publish) and transport-free (a FakeSink stands in for SSE). Proves the core of
 * real-time delivery: topic fan-out, tenant isolation, priority-aware backpressure, ring-buffer
 * reconnect replay, heartbeat, diagnostics, latency metrics, and the connection ceiling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '@vip/messaging';
import {
  eventSubject,
  incidentCandidateSubject,
  incidentRaisedSubject,
  notificationSubject,
} from '@vip/messaging';
import type { StreamControl, StreamEnvelope, StreamTopic } from '@vip/contracts';
import {
  StreamHub,
  type ConnectionSink,
  type StreamHubLimits,
  type StreamMetricsSink,
} from '../src/application/stream-hub.js';

const LIMITS: StreamHubLimits = {
  maxConnectionsPerTenant: 50,
  maxQueueDepth: 500,
  replayBufferSize: 200,
  heartbeatIntervalMs: 0, // disabled unless a test opts in
  maxConnectionDurationMs: 0,
};

class FakeSink implements ConnectionSink {
  delivered: StreamEnvelope[] = [];
  controls: StreamControl[] = [];
  paused = false;
  closed = false;
  #drain: Array<() => void> = [];
  deliver(env: StreamEnvelope): boolean {
    this.delivered.push(env);
    return !this.paused;
  }
  deliverControl(ctl: StreamControl): boolean {
    this.controls.push(ctl);
    return !this.paused;
  }
  writable(): boolean {
    return !this.closed && !this.paused;
  }
  onDrain(cb: () => void): void {
    this.#drain.push(cb);
  }
  close(): void {
    this.closed = true;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    const cbs = this.#drain;
    this.#drain = [];
    for (const cb of cbs) cb();
  }
}

class FakeMetrics implements StreamMetricsSink {
  opened = 0;
  closedCount = 0;
  reconnects = 0;
  replays = 0;
  droppedPriorities: string[] = [];
  deliveries: Array<{ topic: string; e2e?: number; edge: number }> = [];
  heartbeats: boolean[] = [];
  subs = 0;
  connectionOpened(): void {
    this.opened++;
  }
  connectionClosed(): void {
    this.closedCount++;
  }
  reconnect(): void {
    this.reconnects++;
  }
  replayed(n: number): void {
    this.replays += n;
  }
  dropped(p: string): void {
    this.droppedPriorities.push(p);
  }
  delivered(topic: string, _p: string, e2e: number | undefined, edge: number): void {
    this.deliveries.push({ topic, e2e, edge });
  }
  heartbeat(ok: boolean): void {
    this.heartbeats.push(ok);
  }
  subscriptions(n: number): void {
    this.subs = n;
  }
  queueDepth(): void {}
}

function makeHub(
  bus: InMemoryEventBus,
  over: Partial<StreamHubLimits> = {},
  metrics?: StreamMetricsSink,
  now?: () => number,
): StreamHub {
  return new StreamHub({ bus, limits: { ...LIMITS, ...over }, metrics, now });
}

const ALL: StreamTopic[] = ['incidents', 'alerts', 'events', 'system'];

afterEach(() => vi.useRealTimers());

describe('fan-out + classification', () => {
  it('delivers a matching incident frame with a decoded envelope', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink });

    await bus.publish(incidentRaisedSubject('tnt_a'), {
      incidentId: 'inc_1',
      severity: 'medium',
      occurredAt: '2026-07-31T09:00:00.000Z',
    });

    expect(sink.delivered).toHaveLength(1);
    const env = sink.delivered[0]!;
    expect(env).toMatchObject({
      topic: 'incidents',
      type: 'incident.raised',
      tenantId: 'tnt_a',
      priority: 'medium',
      id: '1',
    });
    expect((env.payload as { incidentId: string }).incidentId).toBe('inc_1');
    // ready control was sent first.
    expect(sink.controls[0]?.type).toBe('ready');
    await hub.close();
  });

  it('filters by subscribed topic (alerts-only misses incidents)', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ['alerts'], sink });

    await bus.publish(incidentRaisedSubject('tnt_a'), { incidentId: 'inc_1' });
    await bus.publish(notificationSubject('tnt_a', 'sent'), { notificationId: 'ntf_1' });

    expect(sink.delivered.map((e) => e.topic)).toEqual(['alerts']);
    await hub.close();
  });

  it('never streams internal incident candidates', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink });
    await bus.publish(incidentCandidateSubject('tnt_a'), { candidateId: 'cnd_1' });
    expect(sink.delivered).toHaveLength(0);
    await hub.close();
  });

  it('classifies system vs events and derives priority', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink });

    await bus.publish(eventSubject('tnt_a', 'system.camera.offline'), { cameraId: 'cam_1' });
    await bus.publish(eventSubject('tnt_a', 'analytics.people.count'), { count: 5 });

    const byTopic = Object.fromEntries(sink.delivered.map((e) => [e.type, e]));
    expect(byTopic['event.system.camera.offline']?.topic).toBe('system');
    expect(byTopic['event.system.camera.offline']?.priority).toBe('high');
    expect(byTopic['event.analytics.people.count']?.topic).toBe('events');
    expect(byTopic['event.analytics.people.count']?.priority).toBe('low');
    await hub.close();
  });
});

describe('tenant isolation', () => {
  it('a tenant-A connection never receives tenant-B events', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus);
    const a = new FakeSink();
    const b = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink: a });
    await hub.open({ tenantId: 'tnt_b', topics: ALL, sink: b });

    await bus.publish(incidentRaisedSubject('tnt_b'), { incidentId: 'inc_b' });

    expect(a.delivered).toHaveLength(0);
    expect(b.delivered).toHaveLength(1);
    expect(b.delivered[0]!.tenantId).toBe('tnt_b');
    await hub.close();
  });
});

describe('backpressure + priority drop (rec 1)', () => {
  it('sheds the least-urgent frame when the queue is full, sparing high priority', async () => {
    const bus = new InMemoryEventBus();
    const metrics = new FakeMetrics();
    const hub = makeHub(bus, { maxQueueDepth: 3 }, metrics);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink });

    // First frame is written then the socket saturates → subsequent frames queue.
    sink.pause();
    await bus.publish(eventSubject('tnt_a', 'analytics.people.count'), { n: 1 }); // low → queued
    await bus.publish(eventSubject('tnt_a', 'analytics.people.count'), { n: 2 }); // low → queued
    await bus.publish(eventSubject('tnt_a', 'analytics.people.count'), { n: 3 }); // low → queued (full)
    await bus.publish(incidentRaisedSubject('tnt_a'), { severity: 'critical' }); // high → evicts a low

    expect(metrics.droppedPriorities).toEqual(['low']);

    sink.resume();
    const priorities = sink.delivered.map((e) => e.priority);
    expect(priorities).toContain('high'); // the critical frame survived
    expect(priorities.filter((p) => p === 'low').length).toBe(2); // one low was dropped
    await hub.close();
  });
});

describe('reconnect replay from the ring buffer (rec 4)', () => {
  it('replays only frames after Last-Event-ID for the connection topics', async () => {
    const bus = new InMemoryEventBus();
    const metrics = new FakeMetrics();
    const hub = makeHub(bus, {}, metrics);

    const first = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink: first });
    await bus.publish(incidentRaisedSubject('tnt_a'), { incidentId: 'inc_1' }); // id 1
    await bus.publish(incidentRaisedSubject('tnt_a'), { incidentId: 'inc_2' }); // id 2
    await bus.publish(incidentRaisedSubject('tnt_a'), { incidentId: 'inc_3' }); // id 3
    expect(first.delivered.map((e) => e.id)).toEqual(['1', '2', '3']);

    // A fresh connection resumes from id 1 → should replay 2 and 3.
    const resumed = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink: resumed, lastEventId: '1' });
    expect(resumed.delivered.map((e) => e.id)).toEqual(['2', '3']);
    expect(metrics.reconnects).toBe(1);
    expect(metrics.replays).toBe(2);
    await hub.close();
  });
});

describe('diagnostics + latency (recs 2 & 3)', () => {
  it('reports a per-connection snapshot scoped to the tenant, and records latency', async () => {
    const bus = new InMemoryEventBus();
    const metrics = new FakeMetrics();
    let clock = 1_000;
    const hub = makeHub(bus, {}, metrics, () => clock);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ['incidents'], sink, connectionId: 'conn_1' });

    clock = 2_000; // 1s after the event occurredAt below
    await bus.publish(incidentRaisedSubject('tnt_a'), {
      incidentId: 'inc_1',
      occurredAt: new Date(1_000).toISOString(),
    });

    const diag = hub.diagnostics('tnt_a');
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({
      connectionId: 'conn_1',
      tenantId: 'tnt_a',
      topics: ['incidents'],
      state: 'streaming',
      lastDeliveredId: '1',
    });
    // end-to-end latency ≈ 1s (2000 - 1000).
    expect(metrics.deliveries[0]?.e2e).toBeCloseTo(1, 5);
    // Isolation: another tenant sees nothing.
    expect(hub.diagnostics('tnt_other')).toHaveLength(0);
    await hub.close();
  });
});

describe('connection ceiling (rec 4)', () => {
  it('rejects a connection over the per-tenant limit', async () => {
    const bus = new InMemoryEventBus();
    const hub = makeHub(bus, { maxConnectionsPerTenant: 1 });
    await hub.open({ tenantId: 'tnt_a', topics: ALL, sink: new FakeSink() });
    expect(hub.hasCapacity('tnt_a')).toBe(false);
    await expect(
      hub.open({ tenantId: 'tnt_a', topics: ALL, sink: new FakeSink() }),
    ).rejects.toThrow(/connection limit/);
    await hub.close();
  });
});

describe('heartbeat (rec 1 lifecycle)', () => {
  it('emits periodic heartbeat control frames', async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus();
    const metrics = new FakeMetrics();
    const hub = makeHub(bus, { heartbeatIntervalMs: 1_000 }, metrics);
    const sink = new FakeSink();
    await hub.open({ tenantId: 'tnt_a', topics: ['incidents'], sink });

    await vi.advanceTimersByTimeAsync(2_500);
    const heartbeats = sink.controls.filter((c) => c.type === 'heartbeat');
    expect(heartbeats.length).toBe(2);
    expect(metrics.heartbeats.filter((ok) => ok).length).toBe(2);
    await hub.close();
  });
});

describe('lifecycle teardown', () => {
  it('closing the last connection stops the upstream subscriptions', async () => {
    const bus = new InMemoryEventBus();
    const metrics = new FakeMetrics();
    const hub = makeHub(bus, {}, metrics);
    const sink = new FakeSink();
    const handle = await hub.open({ tenantId: 'tnt_a', topics: ['incidents'], sink });
    expect(metrics.subs).toBe(1);
    handle.close();
    expect(sink.closed).toBe(true);
    expect(metrics.subs).toBe(0);
    expect(hub.diagnostics()).toHaveLength(0);
    await hub.close();
  });
});
