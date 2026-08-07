/** Test doubles for the media supervisor: fake decoder/camera-source, manual timers, in-memory store. */
import type { StreamConnection } from '@vip/contracts';
import type { ObjectStore, ObjectSummary } from '@vip/storage';
import type { DomainEvent, EventPublisher } from '../src/application/events.js';
import type {
  CameraSource,
  Decoder,
  DecoderCallbacks,
  DecoderSession,
  Frame,
  FrameSink,
  Timers,
} from '../src/application/ports.js';

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeSession {
  conn: StreamConnection;
  cb: DecoderCallbacks;
  stopped: boolean;
}

/** A decoder whose lifecycle the test drives explicitly via the most recently opened session. */
export class FakeDecoder implements Decoder {
  readonly sessions: FakeSession[] = [];

  open(conn: StreamConnection, _opts: unknown, cb: DecoderCallbacks): DecoderSession {
    const entry: FakeSession = { conn, cb, stopped: false };
    this.sessions.push(entry);
    return {
      stop: async () => {
        entry.stopped = true;
      },
    };
  }

  #latest(): FakeSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error('no decoder session opened yet');
    return s;
  }

  connected(): void {
    this.#latest().cb.onConnected();
  }
  frame(seq = 0): void {
    this.#latest().cb.onFrame({ seq, at: new Date() });
  }
  async segment(body = new Uint8Array([1, 2, 3, 4])): Promise<void> {
    await this.#latest().cb.onSegment({
      body,
      startedAt: new Date('2026-07-28T00:00:00.000Z'),
      durationSeconds: 6,
      contentType: 'video/mp4',
    });
  }
  error(msg = 'stream dropped'): void {
    this.#latest().cb.onError(new Error(msg));
  }
  close(): void {
    this.#latest().cb.onClose();
  }
}

export class FakeCameraSource implements CameraSource {
  fail = false;
  async resolve(_tenantId: string, cameraId: string): Promise<StreamConnection> {
    if (this.fail) throw new Error('camera resolve failed');
    return { cameraId, protocol: 'rtsp', streamUrl: `rtsp://cam/${cameraId}` };
  }
}

interface PendingTimer {
  fn: () => void;
  ms: number;
  id: object;
}

/** Timers the test advances manually, so reconnect backoff is deterministic. */
export class ManualTimers implements Timers {
  pending: PendingTimer[] = [];
  set(fn: () => void, ms: number): NodeJS.Timeout {
    const id = {};
    this.pending.push({ fn, ms, id });
    return id as unknown as NodeJS.Timeout;
  }
  clear(handle: NodeJS.Timeout): void {
    this.pending = this.pending.filter((p) => p.id !== (handle as unknown as object));
  }
  /** Fire the single pending timer and return its delay (throws if none). */
  runNext(): number {
    const p = this.pending.shift();
    if (!p) throw new Error('no pending timer');
    p.fn();
    return p.ms;
  }
  get count(): number {
    return this.pending.length;
  }
}

export class RecordingFrameSink implements FrameSink {
  readonly frames: { tenantId: string; cameraId: string; frame: Frame }[] = [];
  push(tenantId: string, cameraId: string, frame: Frame): void {
    this.frames.push({ tenantId, cameraId, frame });
  }
}

export class CollectingPublisher implements EventPublisher {
  readonly events: DomainEvent[] = [];
  async publish(event: DomainEvent): Promise<void> {
    this.events.push(event);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

/** In-memory ObjectStore; `failPut` forces a storage error to test degraded recording. */
export function memoryObjectStore(): ObjectStore & { keys(): string[]; failPut: boolean } {
  const map = new Map<string, Uint8Array>();
  const store = {
    failPut: false,
    keys: () => [...map.keys()],
    async put({ key, body }: { key: string; body: Uint8Array | Buffer | string }) {
      if (store.failPut) throw new Error('minio down');
      map.set(
        key,
        typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body),
      );
    },
    async get(key: string) {
      const b = map.get(key);
      if (!b) throw new Error(`not found: ${key}`);
      return { body: b };
    },
    async list(prefix: string) {
      const out: ObjectSummary[] = [];
      for (const [key, v] of map) if (key.startsWith(prefix)) out.push({ key, size: v.length });
      return out;
    },
    async head(key: string) {
      const b = map.get(key);
      return b ? { key, size: b.length } : null;
    },
    async delete(key: string) {
      map.delete(key);
    },
    async presignGet(key: string, ttl: number) {
      return `https://signed/${key}?ttl=${ttl}`;
    },
    async presignPut(key: string, ttl: number, contentType: string) {
      return `https://signed-put/${key}?ttl=${ttl}&ct=${encodeURIComponent(contentType)}`;
    },
  };
  return store;
}
