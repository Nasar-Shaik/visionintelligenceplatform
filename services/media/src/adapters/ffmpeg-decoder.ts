/**
 * Adapter: the real RTSP/RTMP decoder, backed by the **ffmpeg binary** (spawned as a child process
 * — a system dependency, NOT a native npm addon, so it respects the no-native-build policy). One
 * ffmpeg invocation does two jobs from the same input:
 *   1. Recording — copy the H.264 video into rolling MP4 SEGMENTS in a temp dir (`-f segment`).
 *   2. Frames    — extract JPEG frames at the configured rate to stdout (`image2pipe`), scanned
 *                  into `onFrame` for the perception pipeline.
 * Connection is signalled by the first frame; loss/exit by the process error/close. Credentials are
 * embedded into the input URL transiently and NEVER logged. See INGESTION_PIPELINE.md.
 *
 * This adapter is validated live via the dev-stack RTSP test source (`docker compose --profile media
 * up`) + the ffmpeg binary; the supervisor's lifecycle logic is unit-tested with a fake decoder, so
 * this file is exercised by the integration suite (skipped when ffmpeg/RTSP are absent).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamConnection } from '@vip/contracts';
import type {
  DecodeOptions,
  Decoder,
  DecoderCallbacks,
  DecoderSession,
} from '../application/ports.js';

const JPEG_SOI = 0xffd8;
const JPEG_EOI = 0xffd9;
const SEGMENT_POLL_MS = 1000;

export interface FfmpegDecoderOptions {
  /** ffmpeg executable (default `ffmpeg`, resolved on PATH). */
  binary?: string;
}

export class FfmpegDecoder implements Decoder {
  readonly #binary: string;

  constructor(opts: FfmpegDecoderOptions = {}) {
    this.#binary = opts.binary ?? 'ffmpeg';
  }

  open(conn: StreamConnection, opts: DecodeOptions, cb: DecoderCallbacks): DecoderSession {
    return new FfmpegSession(this.#binary, conn, opts, cb);
  }
}

class FfmpegSession implements DecoderSession {
  readonly #dir: string;
  readonly #proc: ChildProcessByStdio<null, Readable, Readable>;
  readonly #cb: DecoderCallbacks;
  readonly #opts: DecodeOptions;
  #stopped = false;
  #connected = false;
  #buf: Buffer = Buffer.alloc(0);
  #segTimer: NodeJS.Timeout;
  #seenSegments = new Map<string, Date>();
  #frameSeq = 0;

  constructor(binary: string, conn: StreamConnection, opts: DecodeOptions, cb: DecoderCallbacks) {
    this.#cb = cb;
    this.#opts = opts;
    this.#dir = mkdtempSync(join(tmpdir(), 'vip-media-'));

    const url = authedUrl(conn);
    const args = buildArgs(conn, url, opts, this.#dir);
    this.#proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.#proc.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    this.#proc.stderr.on('data', () => {
      /* stderr carries ffmpeg diagnostics; intentionally not logged (may echo the authed URL) */
    });
    this.#proc.on('error', (err) => {
      if (!this.#stopped) this.#cb.onError(err);
    });
    this.#proc.on('close', (code) => {
      this.#finalizeSegments(true);
      if (this.#stopped) this.#cb.onClose();
      else this.#cb.onError(new Error(`ffmpeg exited (code ${code ?? 'null'})`));
    });

    this.#segTimer = setInterval(() => this.#finalizeSegments(false), SEGMENT_POLL_MS);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#segTimer);
    this.#proc.kill('SIGTERM');
    // give ffmpeg a moment to flush, then hard-clean the temp dir
    await new Promise((r) => setTimeout(r, 200));
    this.#cleanup();
  }

  #onStdout(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    // Extract every complete JPEG (SOI…EOI) from the MJPEG pipe.
    for (;;) {
      const start = findMarker(this.#buf, JPEG_SOI);
      if (start < 0) break;
      const end = findMarker(this.#buf, JPEG_EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.#buf = this.#buf.subarray(start); // drop leading garbage
        break;
      }
      const frame = this.#buf.subarray(start, end + 2);
      this.#buf = this.#buf.subarray(end + 2);
      if (!this.#connected) {
        this.#connected = true;
        this.#cb.onConnected();
      }
      this.#cb.onFrame({ seq: this.#frameSeq++, at: new Date(), data: new Uint8Array(frame) });
    }
  }

  /** Emit any segment file that is complete (a newer file exists, or we're finalizing on close). */
  #finalizeSegments(final: boolean): void {
    let files: string[];
    try {
      files = readdirSync(this.#dir)
        .filter((f) => f.endsWith('.mp4'))
        .sort();
    } catch {
      return;
    }
    for (const f of files) if (!this.#seenSegments.has(f)) this.#seenSegments.set(f, new Date());

    // All but the most recent file are complete; on `final`, the last one is complete too.
    const complete = final ? files : files.slice(0, -1);
    for (const f of complete) {
      const path = join(this.#dir, f);
      let body: Buffer;
      try {
        if (statSync(path).size === 0) continue;
        body = readFileSync(path);
      } catch {
        continue;
      }
      const startedAt = this.#seenSegments.get(f) ?? new Date();
      this.#seenSegments.delete(f);
      try {
        unlinkSync(path);
      } catch {
        /* best-effort */
      }
      void this.#cb.onSegment({
        body: new Uint8Array(body),
        startedAt,
        durationSeconds: this.#opts.segmentSeconds,
        contentType: 'video/mp4',
      });
    }
  }

  #cleanup(): void {
    try {
      rmSync(this.#dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Build the ffmpeg CLI: segment recording + MJPEG frame pipe from one input. */
function buildArgs(
  conn: StreamConnection,
  url: string,
  opts: DecodeOptions,
  dir: string,
): string[] {
  const input = conn.protocol === 'rtsp' ? ['-rtsp_transport', 'tcp', '-i', url] : ['-i', url];
  return [
    '-loglevel',
    'error',
    ...input,
    // Output 1: rolling MP4 segments (video only, stream-copied — no re-encode).
    '-an',
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(opts.segmentSeconds),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'mp4',
    join(dir, 'seg-%06d.mp4'),
    // Output 2: JPEG frames at the target rate to stdout for perception.
    '-map',
    '0:v:0',
    '-vf',
    `fps=${opts.frameRate}`,
    '-c:v',
    'mjpeg',
    '-f',
    'image2pipe',
    'pipe:1',
  ];
}

/** Embed credentials into the stream URL transiently (never logged). */
function authedUrl(conn: StreamConnection): string {
  if (!conn.username) return conn.streamUrl;
  try {
    const u = new URL(conn.streamUrl);
    u.username = encodeURIComponent(conn.username);
    if (conn.password) u.password = encodeURIComponent(conn.password);
    return u.toString();
  } catch {
    return conn.streamUrl;
  }
}

/** Find a two-byte JPEG marker (0xFFD8 / 0xFFD9) at/after `from`. */
function findMarker(buf: Buffer, marker: number, from = 0): number {
  const hi = marker >> 8;
  const lo = marker & 0xff;
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === hi && buf[i + 1] === lo) return i;
  }
  return -1;
}
