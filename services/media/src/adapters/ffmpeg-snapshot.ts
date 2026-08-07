/**
 * Adapter: **one frame out of a stored recording** (P-8 Phase 8, slice 6 — TD-15 for offline).
 *
 * ### ⭐ Why this closes TD-15 only for offline analysis
 *
 * TD-15 shipped a **no-op** evidence extractor because capturing a key-frame around an incident
 * needed a media frame source that did not exist. Slice 3 built one — but only for *stored* media.
 *
 * ⛔ **A live incident still cannot be extracted, and this does not pretend otherwise.** A live
 * camera's past is not stored frame-by-frame; capturing the moment an incident happened needs a ring
 * buffer holding the last N seconds, which is a different piece of work with its own memory budget.
 * An offline incident is different in kind: the whole recording is sitting in the object store, and
 * the incident's footage offset says exactly where to look.
 *
 * ### ⚠️ Accurate seek, not fast seek
 *
 * The chunked decoder puts `-ss` **before** `-i` because it wants speed and it does not care which
 * frame within a GOP it lands on — it is about to decode two minutes of them. A snapshot cares about
 * exactly one frame: `-ss` after `-i` decodes from the preceding key-frame and lands on the right
 * one. It costs the decode of at most one GOP, which for evidence is the right trade.
 */
import { spawn } from 'node:child_process';

export interface SnapshotRequest {
  /** Signed URL of the source recording. ⚠️ Internal-facing — ffmpeg runs in the container. */
  url: string;
  /** Where in the footage to look, seconds from the start. */
  offsetSeconds: number;
  /** Longest edge of the produced JPEG. Bounded so evidence cannot be a 4K still per incident. */
  maxWidth?: number;
}

export interface SnapshotResult {
  jpeg: Uint8Array;
  /** ⚠️ What was actually produced, which may differ from what was asked for — see `atOffsetSeconds`. */
  atOffsetSeconds: number;
  width: number;
  height: number;
}

export interface FfmpegSnapshotOptions {
  binary?: string;
  timeoutMs?: number;
}

/** Extracts a single frame from stored media. */
export class FfmpegSnapshotExtractor {
  readonly #binary: string;
  readonly #timeoutMs: number;

  constructor(opts: FfmpegSnapshotOptions = {}) {
    this.#binary = opts.binary ?? 'ffmpeg';
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async capture(request: SnapshotRequest): Promise<SnapshotResult> {
    const args = buildSnapshotArgs(request);
    const proc = spawn(this.#binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let stderrTail = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), this.#timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        proc.stdout.on('data', (c: Buffer) => chunks.push(c));
        proc.stderr.on('data', (c: Buffer) => {
          stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
        });
        proc.on('error', (err) => {
          reject(new Error(`ffmpeg could not be started: ${err.message}`));
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg exited ${String(code)}: ${lastLine(stderrTail)}`));
        });
      });
    } finally {
      clearTimeout(timer);
    }

    const jpeg = Buffer.concat(chunks);
    /*
     * ⛔ **An empty output is a failure, not an empty snapshot.** ffmpeg exits 0 having produced
     * nothing when the offset is past the end of the recording — so without this check the platform
     * would register a zero-byte object as a customer's evidence.
     */
    if (jpeg.length === 0) {
      throw new Error(
        `no frame exists at ${request.offsetSeconds.toFixed(3)}s — the recording may be shorter than the incident's offset`,
      );
    }
    const size = jpegSize(jpeg);
    return {
      jpeg: new Uint8Array(jpeg),
      atOffsetSeconds: request.offsetSeconds,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    };
  }
}

/**
 * ⚠️ `-ss` **after** `-i`, unlike the chunked decoder.
 *
 * Before the input it is a fast index seek that lands on the preceding key-frame — right for a
 * decoder about to consume two minutes of footage, wrong for a snapshot, where landing up to a GOP
 * early means the evidence shows a moment before the thing that caused the incident.
 */
export function buildSnapshotArgs(request: SnapshotRequest): string[] {
  const width = request.maxWidth ?? 1280;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    request.url,
    '-ss',
    request.offsetSeconds.toFixed(6),
    '-frames:v',
    '1',
    '-an',
    /* ⚠️ Never upscales: `-2` keeps the aspect ratio and `min()` leaves a small source alone. */
    '-vf',
    `scale='min(${String(width)},iw)':-2`,
    '-f',
    'image2',
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    'pipe:1',
  ];
}

/**
 * Read a JPEG's dimensions from its SOF marker.
 *
 * ⚠️ Measured from the bytes rather than assumed from the request, because `scale` may not have
 * applied — a source narrower than `maxWidth` is left alone. Evidence that misreports its own size
 * is evidence somebody will later crop wrongly.
 */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  /*
   * ⚠️ `i + 8` — the SOF read touches bytes `i+5..i+8`, so this is the exact bound. It was `i + 9`,
   * which silently skipped a marker sitting at the very end of the buffer and returned `null`. Real
   * JPEGs always have entropy-coded data after the SOF so it never bit in production, but a bound
   * that is wrong by one is wrong.
   */
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1] ?? 0;
    /* SOF0…SOF3 and SOF5…SOF15 carry the dimensions; DHT/DAC/RST/SOS do not. */
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    i += 2 + length;
  }
  return null;
}

function lastLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines[lines.length - 1] ?? 'ffmpeg gave no diagnostic';
}
