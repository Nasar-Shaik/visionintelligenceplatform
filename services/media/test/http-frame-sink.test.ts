/**
 * The perception seam (P-8 Phase 2). ⚠️ Every test here exists because of the one guarantee this
 * adapter has to keep: **a slow, broken or absent AI runtime must never cost a recorded second.**
 * The interesting cases are therefore the unhappy ones — a hung runtime, a refusing runtime, a
 * missing runtime, and one camera trying to consume the capacity of sixteen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpFrameSink } from '../src/adapters/http-frame-sink.js';

const frame = (seq: number, at = new Date()) => ({
  seq,
  at,
  data: new Uint8Array([0xff, 0xd8, seq & 0xff]),
});

const sink = (over: Partial<ConstructorParameters<typeof HttpFrameSink>[0]> = {}) =>
  new HttpFrameSink({
    url: 'http://runtime:8085',
    internalKey: 'k'.repeat(16),
    capabilityId: 'perception.person-detection',
    queuePerCamera: 2,
    maxInflight: 2,
    timeoutMs: 50,
    ...over,
  });

/** Wait for the sink to quiesce: nothing queued and nothing in flight. */
async function settle(s: HttpFrameSink, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    const st = s.stats();
    if (st.queueDepth === 0 && st.inflight === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpFrameSink — the recording guarantee', () => {
  it('⚠️ returns immediately even when the runtime never answers', async () => {
    // A fetch that never settles is the shape of a wedged runtime — the worst case for the decoder.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const s = sink();

    const started = Date.now();
    for (let i = 0; i < 50; i += 1) s.push('t1', 'cam1', frame(i));
    const elapsed = Date.now() - started;

    // 50 pushes against a hung runtime, on the thread that writes MP4 segments.
    expect(elapsed).toBeLessThan(100);
    expect(s.stats().offered).toBe(50);
    // Bounded: two in flight, two queued, and every other frame deliberately dropped.
    expect(s.stats().queueDepth).toBeLessThanOrEqual(2);
    expect(s.stats().droppedQueueFull).toBeGreaterThan(40);
  });

  it('⚠️ never throws when the runtime is unreachable, and counts the failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED 172.20.0.9:8085'))),
    );
    const s = sink();

    expect(() => s.push('t1', 'cam1', frame(1))).not.toThrow();
    await settle(s);

    const st = s.stats();
    expect(st.failed).toBe(1);
    expect(st.delivered).toBe(0);
    expect(st.lastError).toContain('ECONNREFUSED');
  });

  it('counts a refusal as failed, not as delivered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 401 }))),
    );
    const s = sink();
    s.push('t1', 'cam1', frame(1));
    await settle(s);

    expect(s.stats().failed).toBe(1);
    expect(s.stats().delivered).toBe(0);
    expect(s.stats().lastError).toContain('401');
  });
});

describe('HttpFrameSink — what reaches the runtime', () => {
  it('posts the frame with its tenant, camera and capability, authenticated', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response('{"success":true}', { status: 200 }));
      }),
    );
    const s = sink();
    const at = new Date('2026-08-05T10:00:00.000Z');
    s.push('tnt_demo_retail', 'cam_7', { seq: 42, at, data: new Uint8Array([1, 2, 3]) });
    await settle(s);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://runtime:8085/infer');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-internal-key']).toBe('k'.repeat(16));
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.capabilityId).toBe('perception.person-detection');
    // ⚠️ Tenant travels with the frame. A frame without one is dropped by the runtime, fail-closed.
    expect(body.context.tenantId).toBe('tnt_demo_retail');
    expect(body.frame).toMatchObject({ cameraId: 'cam_7', seq: 42, source: 'media' });
    expect(body.frame.capturedAt).toBe('2026-08-05T10:00:00.000Z');
    expect(Buffer.from(String(body.imageBase64), 'base64')).toEqual(Buffer.from([1, 2, 3]));
    expect(s.stats().delivered).toBe(1);
  });

  it('⚠️ never posts a frame with no pixels, and says so in its own counter', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const s = sink();

    s.push('t1', 'cam1', { seq: 1, at: new Date() });
    s.push('t1', 'cam1', { seq: 2, at: new Date(), data: new Uint8Array() });
    await settle(s);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.stats().droppedNoImage).toBe(2);
    expect(s.stats().delivered).toBe(0);
    // Offered still counts them: the decoder did hand them over, and that is the honest number.
    expect(s.stats().offered).toBe(2);
  });
});

describe('HttpFrameSink — fairness and bounds', () => {
  it('⚠️ bounds each camera separately, so a busy camera cannot spend another camera’s slots', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response('{}', { status: 200 });
      }),
    );
    const s = sink({ queuePerCamera: 2, maxInflight: 1 });

    for (let i = 0; i < 20; i += 1) s.push('t1', 'busy', frame(i));
    s.push('t1', 'quiet', frame(1));

    // The busy camera is capped at its own two; the quiet camera's single frame is still there.
    expect(s.stats().queueDepth).toBeLessThanOrEqual(3);
    expect(s.stats().activeCameras).toBe(2);

    release?.();
    await settle(s);
    expect(s.stats().delivered).toBeGreaterThanOrEqual(2);
  });

  it('serves cameras round-robin rather than draining one queue first', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        seen.push(JSON.parse(String(init.body)).frame.cameraId);
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );
    const s = sink({ queuePerCamera: 4, maxInflight: 1 });

    for (let i = 0; i < 3; i += 1) {
      s.push('t1', 'a', frame(i));
      s.push('t1', 'b', frame(i));
    }
    await settle(s);

    // Both cameras got service before either was exhausted.
    expect(seen.filter((c) => c === 'a').length).toBeGreaterThan(0);
    expect(seen.filter((c) => c === 'b').length).toBeGreaterThan(0);
    expect(new Set(seen.slice(0, 2)).size).toBe(2);
  });

  it('holds inflight at the configured ceiling', async () => {
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = sink({ queuePerCamera: 8, maxInflight: 3 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        peak = Math.max(peak, s.stats().inflight);
        await gate;
        return new Response('{}', { status: 200 });
      }),
    );

    for (let i = 0; i < 8; i += 1) s.push('t1', `cam${i}`, frame(i));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.stats().inflight).toBe(3);

    release?.();
    await settle(s);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
