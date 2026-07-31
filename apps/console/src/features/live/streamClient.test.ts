/**
 * Real-time stream client tests (P2-2 G-5). Cover the pure SSE frame parser and the resilient
 * connection loop (resume with Last-Event-ID, fall back to polling on failure) with an injected
 * fake `fetch` — no network, no MSW.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveStreamClient, parseSseBuffer, type StreamFrame } from './streamClient';

describe('parseSseBuffer', () => {
  it('parses complete frames and keeps the trailing partial', () => {
    const raw =
      'event: ready\ndata: {"topics":["incidents"]}\n\n' +
      'id: 7\nevent: incidents\ndata: {"id":"7"}\n\n' +
      'id: 8\nevent: inci'; // partial
    const { frames, rest } = parseSseBuffer(raw);
    expect(frames).toEqual<StreamFrame[]>([
      { event: 'ready', data: '{"topics":["incidents"]}' },
      { event: 'incidents', data: '{"id":"7"}', id: '7' },
    ]);
    expect(rest).toBe('id: 8\nevent: inci');
  });

  it('ignores comment/keepalive lines and defaults the event name', () => {
    const { frames } = parseSseBuffer(': keepalive\n\ndata: hello\n\n');
    expect(frames).toEqual([{ event: 'message', data: 'hello' }]);
  });
});

/** Build a fetch Response whose body streams the given SSE chunks then ends. */
function streamResponse(chunks: string[], ok = true, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok, status, body } as unknown as Response;
}

afterEach(() => vi.useRealTimers());

describe('LiveStreamClient', () => {
  it('connects, reports state, and emits parsed frames; resumes with Last-Event-ID', async () => {
    const states: string[] = [];
    const frames: StreamFrame[] = [];
    const seenHeaders: Array<Record<string, string>> = [];
    let call = 0;

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
      call += 1;
      if (call === 1) {
        return streamResponse(['id: 5\nevent: incidents\ndata: {"id":"5"}\n\n']);
      }
      // Second connection: block so the loop parks here (resolves never).
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    const client = new LiveStreamClient({
      topics: ['incidents', 'alerts'],
      getToken: () => 'tok_123',
      fetchImpl,
      maxBackoffMs: 10,
      handlers: {
        onState: (s) => states.push(s),
        onFrame: (f) => frames.push(f),
      },
    });
    client.start();
    // Let the first stream be consumed and the reconnect be issued.
    await vi.waitFor(() => expect(call).toBeGreaterThanOrEqual(2), { timeout: 1000 });
    client.stop();

    expect(frames).toEqual([{ event: 'incidents', data: '{"id":"5"}', id: '5' }]);
    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    // First attempt carried the bearer token, no resume header.
    expect(seenHeaders[0]?.authorization).toBe('Bearer tok_123');
    expect(seenHeaders[0]?.['last-event-id']).toBeUndefined();
    // The reconnect resumed from the last delivered id.
    expect(seenHeaders[1]?.['last-event-id']).toBe('5');
  });

  it('falls back to polling state when the connection fails', async () => {
    const states: string[] = [];
    const fetchImpl = vi.fn(async () => streamResponse([], false, 503)) as unknown as typeof fetch;
    const client = new LiveStreamClient({
      topics: ['incidents'],
      getToken: () => null,
      fetchImpl,
      maxBackoffMs: 5,
      handlers: { onState: (s) => states.push(s), onFrame: () => {} },
    });
    client.start();
    await vi.waitFor(() => expect(states).toContain('polling'), { timeout: 1000 });
    client.stop();
    expect(states).toContain('polling');
  });
});
