/**
 * Real-time stream client (P2-2 G-5). Consumes the gateway's SSE endpoint (`/api/stream`) over
 * `fetch` streaming rather than the native `EventSource`, because the console authenticates with a
 * bearer token in a header (EventSource cannot set headers, and we refuse to put tokens in URLs).
 *
 * It reconnects with exponential backoff, resumes with `Last-Event-ID`, and reports connection
 * state so the UI can show a live/polling indicator. Polling hooks stay active as a fallback — this
 * layer only *accelerates* freshness (invalidating caches on push); it never becomes a hard
 * dependency for correctness.
 */
import type { StreamTopic } from '@vip/contracts';

export interface StreamFrame {
  event: string; // 'ready' | 'heartbeat' | 'error' | a StreamTopic
  data: string;
  id?: string;
}

/** Parse a raw SSE buffer into complete frames + the trailing partial (pure — unit tested). */
export function parseSseBuffer(buffer: string): { frames: StreamFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? ''; // last chunk may be incomplete
  const frames: StreamFrame[] = [];
  for (const block of parts) {
    let event = 'message';
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment/keepalive
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
    if (dataLines.length > 0 || event !== 'message') {
      frames.push(
        id !== undefined
          ? { event, data: dataLines.join('\n'), id }
          : { event, data: dataLines.join('\n') },
      );
    }
  }
  return { frames, rest };
}

export type LiveConnectionState = 'connecting' | 'connected' | 'polling';

export interface LiveStreamHandlers {
  onState(state: LiveConnectionState): void;
  onFrame(frame: StreamFrame): void;
}

export interface LiveStreamOptions {
  topics: StreamTopic[];
  getToken: () => string | null;
  handlers: LiveStreamHandlers;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  maxBackoffMs?: number;
}

/** A resilient SSE connection with backoff + Last-Event-ID resume. Call `stop()` to end it. */
export class LiveStreamClient {
  #stopped = false;
  #controller: AbortController | null = null;
  #lastEventId: string | undefined;
  readonly #opts: Required<Omit<LiveStreamOptions, 'baseUrl' | 'maxBackoffMs'>> &
    Pick<LiveStreamOptions, 'baseUrl' | 'maxBackoffMs'>;

  constructor(opts: LiveStreamOptions) {
    this.#opts = { fetchImpl: opts.fetchImpl ?? fetch.bind(globalThis), ...opts };
  }

  start(): void {
    if (this.#controller) return;
    void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  async #run(): Promise<void> {
    const base = this.#opts.baseUrl ?? '/api';
    const url = `${base}/stream?topics=${this.#opts.topics.join(',')}`;
    const maxBackoff = this.#opts.maxBackoffMs ?? 15_000;
    let backoff = 500;

    while (!this.#stopped) {
      this.#opts.handlers.onState('connecting');
      this.#controller = new AbortController();
      try {
        const token = this.#opts.getToken();
        const res = await this.#opts.fetchImpl(url, {
          headers: {
            accept: 'text/event-stream',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(this.#lastEventId ? { 'last-event-id': this.#lastEventId } : {}),
          },
          signal: this.#controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream status ${res.status}`);

        this.#opts.handlers.onState('connected');
        backoff = 500; // reset on a successful connection
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseBuffer(buf);
          buf = rest;
          for (const frame of frames) {
            if (frame.id) this.#lastEventId = frame.id;
            this.#opts.handlers.onFrame(frame);
          }
        }
      } catch {
        if (this.#stopped) break;
      }
      if (this.#stopped) break;
      // Connection ended/failed → fall back to polling and retry with backoff.
      this.#opts.handlers.onState('polling');
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}
