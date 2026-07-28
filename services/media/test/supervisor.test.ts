/**
 * Supervisor lifecycle tests — the heart of ingestion, driven with fakes so the whole state machine
 * (connect → frames → record → loss → backoff reconnect → stop), tenant isolation, event emission,
 * and degraded-storage behaviour are deterministic without ffmpeg, a camera, or a network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { StreamSupervisor } from '../src/application/stream-supervisor.js';
import {
  CollectingPublisher,
  FakeCameraSource,
  FakeDecoder,
  ManualTimers,
  RecordingFrameSink,
  flush,
  memoryObjectStore,
} from './helpers.js';

const clock = { now: () => new Date('2026-07-28T00:00:00.000Z') };

function build() {
  const decoder = new FakeDecoder();
  const cameraSource = new FakeCameraSource();
  const store = memoryObjectStore();
  const frameSink = new RecordingFrameSink();
  const publisher = new CollectingPublisher();
  const timers = new ManualTimers();
  const logs: { level: string; msg: string }[] = [];
  const supervisor = new StreamSupervisor({
    cameraSource,
    decoder,
    objectStore: store,
    frameSink,
    clock,
    options: { frameRate: 2, segmentSeconds: 6, backoff: { baseMs: 500, capMs: 30_000 } },
    publisher,
    timers,
    onLog: (level, msg) => logs.push({ level, msg }),
  });
  return { supervisor, decoder, cameraSource, store, frameSink, publisher, timers, logs };
}

describe('start + connect', () => {
  it('starts a worker (connecting) and moves to connected on the decoder signal', async () => {
    const t = build();
    const initial = t.supervisor.start('tnt_a', 'cam_1');
    expect(initial.state).toBe('connecting');

    await flush();
    t.decoder.connected();

    const status = t.supervisor.status('tnt_a', 'cam_1');
    expect(status.state).toBe('connected');
    expect(status.recording).toBe(true);
    expect(status.reconnectAttempts).toBe(0);
    expect(t.publisher.types()).toContain('media.stream.connected');
  });

  it('is idempotent — starting an active stream returns the existing worker', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    t.supervisor.start('tnt_a', 'cam_1'); // no new session
    expect(t.decoder.sessions.length).toBe(1);
  });
});

describe('frames + recording', () => {
  it('counts frames and forwards them to the sink', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    t.decoder.frame(0);
    t.decoder.frame(1);
    expect(t.supervisor.status('tnt_a', 'cam_1').framesReceived).toBe(2);
    expect(t.frameSink.frames.map((f) => f.frame.seq)).toEqual([0, 1]);
  });

  it('records a segment under {tenantId}/{cameraId}/recordings/… and emits media.recording.segment', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    await t.decoder.segment(new Uint8Array([9, 9, 9]));

    const keys = t.store.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^tnt_a\/cam_1\/recordings\/seg-.*\.mp4$/);

    const segEvents = t.publisher.events.filter((e) => e.type === 'media.recording.segment');
    expect(segEvents).toHaveLength(1);
    expect(segEvents[0]!.payload).toMatchObject({
      cameraId: 'cam_1',
      tenantId: 'tnt_a',
      sizeBytes: 3,
    });
    expect(t.supervisor.status('tnt_a', 'cam_1').lastSegmentAt).toBeTruthy();
  });

  it('degrades (logs, no event, no throw) when the store write fails — never blocks the live path', async () => {
    const t = build();
    t.store.failPut = true;
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    await t.decoder.segment();

    expect(t.publisher.types()).not.toContain('media.recording.segment');
    expect(t.logs.some((l) => l.level === 'error')).toBe(true);
    // The worker is still alive and connected.
    expect(t.supervisor.status('tnt_a', 'cam_1').state).toBe('connected');
  });
});

describe('loss + reconnect (backoff)', () => {
  it('on loss → lost + media.stream.lost + a scheduled reconnect', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    t.decoder.error('drop');

    const status = t.supervisor.status('tnt_a', 'cam_1');
    expect(status.state).toBe('lost');
    expect(status.recording).toBe(false);
    expect(status.lastError).toBe('drop');
    expect(t.publisher.types()).toContain('media.stream.lost');
    expect(t.timers.count).toBe(1);
  });

  it('reconnect attempt fires and re-connects; a successful connect resets the attempt counter', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();

    t.decoder.error(); // loss 1
    const firstDelay = t.timers.runNext(); // fire reconnect
    expect(firstDelay).toBe(500); // base * 2^0
    await flush();
    expect(t.decoder.sessions.length).toBe(2); // reopened
    t.decoder.connected();
    expect(t.supervisor.status('tnt_a', 'cam_1').reconnectAttempts).toBe(0);
  });

  it('backoff grows exponentially across consecutive losses', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();

    // loss 1 (attempt 0 → 500ms)
    t.decoder.error();
    expect(t.timers.runNext()).toBe(500);
    await flush();
    // loss 2 (attempt 1 → 1000ms)
    t.decoder.error();
    expect(t.timers.runNext()).toBe(1000);
    await flush();
    // loss 3 (attempt 2 → 2000ms)
    t.decoder.error();
    expect(t.timers.runNext()).toBe(2000);
  });

  it('a camera-resolve failure is treated as a loss (reconnect scheduled)', async () => {
    const t = build();
    t.cameraSource.fail = true;
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    expect(t.supervisor.status('tnt_a', 'cam_1').state).toBe('lost');
    expect(t.publisher.types()).toContain('media.stream.lost');
    expect(t.timers.count).toBe(1);
  });
});

describe('stop', () => {
  it('stops the worker and suppresses reconnects', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();
    t.decoder.error(); // schedules a reconnect

    const status = await t.supervisor.stop('tnt_a', 'cam_1');
    expect(status.state).toBe('stopped');
    expect(t.timers.count).toBe(0); // reconnect timer cleared
    expect(t.decoder.sessions.at(-1)!.stopped).toBe(true);
  });

  it('404s stopping / statusing a stream that was never started', async () => {
    const t = build();
    await expect(t.supervisor.stop('tnt_a', 'ghost')).rejects.toMatchObject({ statusCode: 404 });
    expect(() => t.supervisor.status('tnt_a', 'ghost')).toThrow();
  });
});

describe('cross-tenant isolation', () => {
  it('the same cameraId in two tenants is two independent workers; neither sees the other', async () => {
    const t = build();
    t.supervisor.start('tnt_a', 'cam_1');
    await flush();
    t.decoder.connected();

    // tnt_b never started cam_1 → not found.
    expect(() => t.supervisor.status('tnt_b', 'cam_1')).toThrow();
    expect(t.supervisor.list('tnt_b')).toHaveLength(0);
    expect(t.supervisor.list('tnt_a').map((s) => s.cameraId)).toEqual(['cam_1']);
  });
});
