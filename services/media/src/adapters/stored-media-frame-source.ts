/**
 * Adapter: the **stored-media frame source** (P-8 Phase 8, slice 3) — the implementation
 * `FrameSource` was written for.
 *
 * ### ⭐ What this is, and what it deliberately is not
 *
 * It is the live decoder's other half. `FfmpegDecoder` opens an RTSP stream and does two jobs:
 * writes rolling MP4 segments *and* pipes JPEG frames to perception. This one opens a **stored
 * object over a presigned URL** and does only the second — because a recording that already exists
 * in the object store does not need to be recorded again, and writing segments from it would fill
 * the customer's storage with a second copy of their own upload.
 *
 * Everything that decides an analytical outcome is identical: the same ffmpeg binary, the same
 * `fps` filter, the same MJPEG pipe, the same JPEG framing. ⛔ It is **not a second decoder** in any
 * sense that could change an answer, and the parity verification is what holds that claim up.
 *
 * ### ⚠️ Why it reads a URL rather than a file
 *
 * ffmpeg speaks HTTP, and the object is already in the object store behind a presigned GET. Copying
 * a 2 GiB upload to local disk before decoding it would need 2 GiB of scratch space per concurrent
 * session on a host sized for neither, and would add minutes before the first frame. Streaming it
 * also means a chunk that seeks to 03:12:00 issues **range requests**, so a resume near the end of
 * a long recording does not re-read the beginning.
 *
 * ### ⚠️ No `-re`
 *
 * The live decoder consumes a stream that arrives in real time by nature. Here `-re` would throttle
 * ffmpeg to the footage's own rate and cap every analysis at 1×, which is the opposite of what an
 * investigation wants. Pacing, when a session asks for it, is applied by the **worker** — one place,
 * measurable, and off the decode path entirely.
 */
import { spawn } from 'node:child_process';
import type { Frame } from '../application/ports.js';
import type {
  FrameChunkResult,
  FrameRequest,
  FrameSource,
  FrameSourceFactory,
  FrameSourceInput,
} from '../application/frame-source.js';
import { frameFootageTime, frameOffsetSeconds } from '../domain/analysis.js';

const JPEG_SOI = 0xffd8;
const JPEG_EOI = 0xffd9;

/**
 * ⚠️ **Bumped when decode or timestamping behaviour changes** — see `AnalysisProvenance`. It is on
 * the frame rather than only on the session because a session resumed across a deployment can have
 * been decoded by two versions, and the frames are where that is visible.
 */
export const STORED_MEDIA_DECODER_VERSION = 'ffmpeg-stored-media/1.0.0';

/**
 * ⭐ How far the container's own timestamps may drift from the derived offset before it is a finding.
 *
 * Half a frame interval at the analysis rate would be too tight — MJPEG output is quantised to the
 * `fps` filter's grid and ordinary rounding lands within it. **One full frame interval** is the
 * point at which a frame is genuinely attributed to the wrong moment, which is when an operator
 * would find an incident's evidence clip showing the wrong thing.
 */
export const PTS_DIVERGENCE_TOLERANCE_FRAMES = 1;

export interface StoredMediaFrameSourceOptions {
  /** ffmpeg executable (default `ffmpeg`, resolved on PATH). */
  binary?: string;
  /**
   * How long one chunk's ffmpeg may run before it is killed.
   *
   * ⚠️ A ceiling, not a budget. An object store that accepts the connection and then stops sending
   * would otherwise hold a worker's lease for ever while reporting healthy progress, which is the
   * one failure shape a heartbeat cannot distinguish from slow work.
   */
  chunkTimeoutMs?: number;
}

/** What one decoded chunk observed, beyond the frames themselves. */
export interface ChunkDiagnostics {
  /** Frames whose presentation timestamp diverged from the derived offset beyond tolerance. */
  ptsDiverged: number;
  /** The largest divergence seen, seconds. `null` when no frame carried a readable PTS. */
  worstDivergenceSeconds: number | null;
  /** Frames for which ffmpeg reported no presentation timestamp at all. */
  ptsMissing: number;
}

export class StoredMediaFrameSourceFactory implements FrameSourceFactory {
  readonly #binary: string;
  readonly #chunkTimeoutMs: number;
  readonly #signUrl: (tenantId: string, key: string) => Promise<string>;

  constructor(
    signUrl: (tenantId: string, key: string) => Promise<string>,
    opts: StoredMediaFrameSourceOptions = {},
  ) {
    this.#signUrl = signUrl;
    this.#binary = opts.binary ?? 'ffmpeg';
    this.#chunkTimeoutMs = opts.chunkTimeoutMs ?? 10 * 60_000;
  }

  async open(input: FrameSourceInput): Promise<FrameSource> {
    /*
     * ⚠️ Signed ONCE per session rather than per chunk, and the lifetime has to cover the whole run.
     * A URL that expires mid-analysis fails the chunk after it, which the worker would correctly
     * treat as transient and retry — twice — before failing a session whose only problem was a
     * clock. The caller owns the lifetime; this just uses what it is given.
     */
    const url = await this.#signUrl(input.tenantId, input.assetKey);
    return new StoredMediaFrameSource(this.#binary, url, input, this.#chunkTimeoutMs);
  }
}

export class StoredMediaFrameSource implements FrameSource {
  readonly #binary: string;
  readonly #url: string;
  readonly #input: FrameSourceInput;
  readonly #chunkTimeoutMs: number;
  #chunkIndex = 0;
  #closed = false;
  #diagnostics: ChunkDiagnostics = {
    ptsDiverged: 0,
    worstDivergenceSeconds: null,
    ptsMissing: 0,
  };

  constructor(binary: string, url: string, input: FrameSourceInput, chunkTimeoutMs: number) {
    this.#binary = binary;
    this.#url = url;
    this.#input = input;
    this.#chunkTimeoutMs = chunkTimeoutMs;
  }

  /** What the chunks decoded so far observed. ⚠️ Cumulative across the session, like the counts. */
  diagnostics(): ChunkDiagnostics {
    return { ...this.#diagnostics };
  }

  async read(
    request: FrameRequest,
    onFrame: (frame: Frame) => Promise<void>,
    signal: AbortSignal,
  ): Promise<FrameChunkResult> {
    if (this.#closed) throw new Error('this frame source is closed');
    const chunkIndex = this.#chunkIndex;
    this.#chunkIndex += 1;
    const chunkId = `${this.#input.sessionId}#${String(chunkIndex)}`;

    const proc = spawn(this.#binary, buildArgs(this.#url, request), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /*
     * ⚠️ **Seq is absolute across the whole recording, not per chunk**, and this is the arithmetic
     * the milestone rests on. A per-chunk counter would restart every two minutes, so frame 1 of
     * chunk 2 would be stamped at offset 0 and every incident after the first chunk would be
     * attributed to the start of the file.
     */
    const seqAtChunkStart = Math.round(request.fromOffsetSeconds * request.frameRate);

    let framesEmitted = 0;
    let buf: Buffer = Buffer.alloc(0);
    const ptsQueue: number[] = [];
    let stderrTail = '';
    /* ⚠️ Frames arrive faster than they are consumed; the promise chain is what serialises them. */
    let pending: Promise<void> = Promise.resolve();
    let failure: Error | undefined;

    const onAbort = (): void => {
      proc.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      failure ??= new Error(
        `decoding one chunk exceeded ${String(this.#chunkTimeoutMs)}ms — the recording could not be read fast enough to make progress`,
      );
      proc.kill('SIGKILL');
    }, this.#chunkTimeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        proc.stdout.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          for (;;) {
            const start = findMarker(buf, JPEG_SOI);
            if (start < 0) break;
            const end = findMarker(buf, JPEG_EOI, start + 2);
            if (end < 0) {
              if (start > 0) buf = buf.subarray(start);
              break;
            }
            const jpeg = buf.subarray(start, end + 2);
            buf = buf.subarray(end + 2);

            const indexInChunk = framesEmitted;
            framesEmitted += 1;
            const seq = seqAtChunkStart + indexInChunk + 1;
            const data = new Uint8Array(jpeg);
            const pts = ptsQueue[indexInChunk];
            const frame = this.#stamp(seq, request, chunkId, chunkIndex, pts, data);

            /*
             * ⭐ **Back-pressure, and the reason the stream is paused.**
             *
             * `onFrame` is awaited by contract. Without pausing, ffmpeg would keep filling this
             * buffer at decode speed while the runtime consumed frames at its own — 28 800 JPEGs for
             * a four-hour recording, held in the process that must not run out of memory. Pausing
             * stops reading the pipe, ffmpeg blocks on its own write, and memory stays flat.
             */
            proc.stdout.pause();
            pending = pending
              .then(() => onFrame(frame))
              .then(
                () => {
                  if (!signal.aborted && !proc.killed) proc.stdout.resume();
                },
                (err: unknown) => {
                  failure ??= err instanceof Error ? err : new Error(String(err));
                  proc.kill('SIGKILL');
                },
              );
          }
        });

        proc.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          /* ⚠️ Bounded. A pathological file can produce megabytes of diagnostics per chunk. */
          stderrTail = (stderrTail + text).slice(-2000);
          for (const pts of parseShowinfoPts(text)) ptsQueue.push(pts);
        });

        proc.on('error', (err) => {
          reject(new Error(`ffmpeg could not be started: ${err.message}`));
        });
        proc.on('close', (code) => {
          /* ⚠️ Wait for the last frame's delivery before settling, or its result is lost. */
          pending.then(
            () => {
              if (failure !== undefined) {
                reject(failure);
                return;
              }
              if (signal.aborted) {
                resolve();
                return;
              }
              /*
               * ⚠️ A non-zero exit is only a failure when it is not our own kill. SIGKILL after a
               * cancellation reports 137, and treating that as a decode error would fail a session
               * an operator deliberately stopped.
               */
              if (code !== 0 && code !== null) {
                reject(
                  new Error(
                    `ffmpeg exited with code ${String(code)} while decoding ${this.#input.assetKey}: ${lastError(stderrTail)}`,
                  ),
                );
                return;
              }
              resolve();
            },
            (err: unknown) => {
              reject(err instanceof Error ? err : new Error(String(err)));
            },
          );
        });
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }

    /*
     * ⭐ **The chunk's end is measured, not assumed.**
     *
     * `reachedOffsetSeconds` is derived from the frames that actually came out, so a truncated file
     * advances by what it gave rather than by what was asked for. `reachedEnd` is true when ffmpeg
     * produced less than the chunk asked for — the only reliable end-of-file signal, because a
     * container's declared duration and its real content disagree often enough to matter.
     */
    /*
     * ⛔ **Floored at 1, and this guards a real infinite loop.** `nextChunk` may legitimately ask for
     * one second, and the analysis rate may legitimately be 0.1 fps — so `floor(1 × 0.1)` is 0, and
     * `0 < 0` is false. The chunk would report "not finished" having produced nothing, the offset
     * would not advance, and the session would decode empty chunks for ever while its heartbeat said
     * it was healthy. A chunk that yields no frames has reached the end of what it can read.
     *
     * ⚠️ Measured boundary behaviour: `-t 4` at 2 fps emits **9** frames (0.0 … 4.0 inclusive), not
     * 8. That is why `reachedOffsetSeconds` is derived from the frames that came out rather than from
     * the duration that was asked for — the two disagree by one frame at every chunk boundary, and
     * deriving from the request would overlap or gap the seam on every chunk.
     */
    const expected = Math.max(1, Math.floor(request.durationSeconds * request.frameRate));
    const reachedOffsetSeconds =
      framesEmitted === 0
        ? request.fromOffsetSeconds
        : frameOffsetSeconds(seqAtChunkStart + framesEmitted + 1, request.frameRate);

    return {
      framesEmitted,
      reachedOffsetSeconds,
      reachedEnd: signal.aborted ? false : framesEmitted < expected,
    };
  }

  /** Build one frame's event time and provenance. ⭐ The whole of "when did this happen". */
  #stamp(
    seq: number,
    request: FrameRequest,
    chunkId: string,
    chunkIndex: number,
    ptsSeconds: number | undefined,
    data: Uint8Array,
  ): Frame {
    const mediaOffsetSeconds = frameOffsetSeconds(seq, request.frameRate);

    /*
     * ⭐ **The container's own clock against ours, checked rather than trusted.**
     *
     * `mediaOffsetSeconds` is `(seq − 1) / frameRate`, which is exact for constant-frame-rate footage
     * and wrong for anything else: variable frame rate, an NVR export with a gap where the recorder
     * dropped out, two clips concatenated. Comparing it with the presentation timestamp is the only
     * way to notice, and noticing is the difference between a report that is wrong and one that says
     * it might be.
     */
    if (ptsSeconds === undefined) {
      this.#diagnostics.ptsMissing += 1;
    } else {
      /*
       * ⚠️ **`pts_time` is CHUNK-RELATIVE, and this was measured rather than assumed.**
       *
       * With `-ss` before `-i`, ffmpeg rebases output timestamps to zero at the seek point. Measured
       * against ffmpeg 8.1.2 on a 20 s CFR file: a chunk seeking to 10 s reports `pts_time` 0…4,
       * byte-identical to the chunk that starts at 0. Comparing it against the *absolute* footage
       * offset would therefore have reported every frame after the first chunk as diverged — a
       * finding on every multi-chunk analysis, which is worse than no finding at all, because an
       * operator learns to ignore it.
       */
      const derivedWithinChunk = mediaOffsetSeconds - request.fromOffsetSeconds;
      const divergence = Math.abs(ptsSeconds - derivedWithinChunk);
      const tolerance = PTS_DIVERGENCE_TOLERANCE_FRAMES / request.frameRate;
      if (
        this.#diagnostics.worstDivergenceSeconds === null ||
        divergence > this.#diagnostics.worstDivergenceSeconds
      ) {
        this.#diagnostics.worstDivergenceSeconds = divergence;
      }
      if (divergence > tolerance) this.#diagnostics.ptsDiverged += 1;
    }

    return {
      seq,
      /* ⭐ Footage time. Never wall clock — see `frameFootageTime`. */
      at: frameFootageTime(this.#input.footageStartedAt, seq, request.frameRate),
      data,
      provenance: {
        sourceKind: 'stored-media',
        sourceId: this.#input.assetKey,
        analysisId: this.#input.analysisId,
        sessionId: this.#input.sessionId,
        chunkId,
        chunkIndex,
        mediaOffsetSeconds,
        ptsSeconds: ptsSeconds ?? null,
        frameRate: request.frameRate,
        decoder: STORED_MEDIA_DECODER_VERSION,
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}

/**
 * Build the ffmpeg CLI for one chunk.
 *
 * ⚠️ **`-ss` before `-i`, and that placement is the difference between a resume that works and one
 * that reads the whole file.** Before the input it is an *input* seek: ffmpeg jumps using the
 * container index and issues an HTTP range request, so chunk 60 starts near byte 60/61 of the
 * object. After the input it decodes everything from zero and discards it, which turns a two-minute
 * chunk near the end of a four-hour recording into a four-hour decode.
 */
export function buildArgs(url: string, request: FrameRequest): string[] {
  return [
    '-hide_banner',
    /* ⚠️ `info`, not `error` — `showinfo` writes the presentation timestamps at info level. */
    '-loglevel',
    'info',
    '-nostdin',
    '-ss',
    request.fromOffsetSeconds.toFixed(6),
    '-i',
    url,
    '-t',
    request.durationSeconds.toFixed(6),
    '-an',
    '-map',
    '0:v:0',
    /*
     * ⚠️ `showinfo` AFTER `fps`, so the timestamps reported are the ones belonging to the frames
     * that are actually emitted. Before it, they would describe the source's frames and pair with
     * nothing — the count would not even match.
     */
    '-vf',
    `fps=${String(request.frameRate)},showinfo`,
    '-c:v',
    'mjpeg',
    '-f',
    'image2pipe',
    'pipe:1',
  ];
}

/**
 * Read presentation timestamps out of `showinfo` output.
 *
 * ⚠️ **Paired with frames by INDEX, not by arrival.** stdout and stderr are separate pipes with no
 * ordering guarantee between them, so "the line that arrived just now describes the frame that
 * arrived just now" is not true and would misattribute timestamps under load. Both streams are
 * strictly ordered *within themselves*, and `showinfo` emits exactly one line per emitted frame, so
 * the nth line describes the nth frame however the two interleave.
 *
 * ⚠️ A frame whose line has not arrived yet gets `null` rather than a neighbour's value. An absent
 * timestamp is honest; a wrong one silently moves an incident.
 */
export function parseShowinfoPts(text: string): number[] {
  const out: number[] = [];
  const re = /pts_time:(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** The last line of ffmpeg's diagnostics that looks like an error, for an operator-facing message. */
export function lastError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('[Parsed_showinfo'));
  return lines[lines.length - 1] ?? 'ffmpeg gave no diagnostic';
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
