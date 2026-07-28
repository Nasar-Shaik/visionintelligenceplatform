/**
 * Application ports (hexagonal seams). The supervisor depends only on these interfaces; adapters
 * (HTTP camera client, ffmpeg decoder, S3 storage, perception sink) implement them, and tests
 * substitute fakes. This is what keeps the ingestion lifecycle fully unit-testable without ffmpeg,
 * a camera, or a network.
 */
import type { StreamConnection } from '@vip/contracts';

/** Resolves a camera's connection descriptor (with decrypted credentials) from the Camera context. */
export interface CameraSource {
  resolve(tenantId: string, cameraId: string): Promise<StreamConnection>;
}

/** A decoded video frame handed to perception. In P1-4 `data` may be a JPEG; P1-6 consumes it. */
export interface Frame {
  seq: number;
  at: Date;
  data?: Uint8Array;
}

/** A finalized recording segment emitted by the decoder, ready to persist. */
export interface DecodedSegment {
  body: Uint8Array;
  startedAt: Date;
  durationSeconds: number;
  contentType: string;
}

/** Lifecycle callbacks the decoder invokes for one open stream. */
export interface DecoderCallbacks {
  /** The input opened and media is flowing. */
  onConnected(): void;
  /** A frame was extracted (at the configured rate). */
  onFrame(frame: Frame): void;
  /** A recording segment finalized and is ready to store. */
  onSegment(segment: DecodedSegment): void | Promise<void>;
  /** The stream failed / was lost (network drop, decode error, unexpected exit). */
  onError(error: Error): void;
  /** The stream ended cleanly (only after an explicit stop). */
  onClose(): void;
}

export interface DecodeOptions {
  /** Target frame-extraction rate (frames/sec) for perception. */
  frameRate: number;
  /** Recording segment length in seconds. */
  segmentSeconds: number;
}

/** An active decode session; `stop()` tears it down (no further callbacks after it resolves). */
export interface DecoderSession {
  stop(): Promise<void>;
}

/** Opens a decode session for a resolved connection, delivering events via `cb`. */
export interface Decoder {
  open(conn: StreamConnection, opts: DecodeOptions, cb: DecoderCallbacks): DecoderSession;
}

/** Where extracted frames go for perception. P1-4 ships a null sink; P1-6 wires the pipeline. */
export interface FrameSink {
  push(tenantId: string, cameraId: string, frame: Frame): void;
}

/** Deferred timer, injectable so reconnect scheduling is deterministic under test. */
export interface Timers {
  set(fn: () => void, ms: number): NodeJS.Timeout;
  clear(handle: NodeJS.Timeout): void;
}

export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
};
