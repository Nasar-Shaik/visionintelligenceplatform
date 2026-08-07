/**
 * Adapter: measure an uploaded recording with `ffprobe` (P-8 Phase 8).
 *
 * ⭐ **This is the boundary where an uploaded file stops being a claim.** A presigned PUT says where
 * bytes may land; the content type says what the uploader *called* them. Everything the platform
 * goes on to believe about the recording — its codec, its dimensions, its duration, whether it is a
 * video at all — is measured here.
 *
 * ### ⛔ Untrusted input, treated as such
 *
 * 1. **`spawn` with an argument array**, never a shell. A filename is data, and the only reason it
 *    cannot become a command is that nothing ever interpolates it into one.
 * 2. **A bounded run.** `ffprobe` on a malformed file can sit and think; a probe that never returns
 *    holds an HTTP request open. It is killed at a deadline and that is a refusal, not a hang.
 * 3. **A bounded read.** Output is capped, so a pathological file cannot answer with a gigabyte of
 *    JSON.
 * 4. **The URL is signed and short-lived**, so the probe reads the object over the same path anyone
 *    else would and needs no credentials of its own.
 */
import { spawn } from 'node:child_process';
import type { AnalysisAsset, AnalysisContainer } from '@vip/contracts';

export interface ProbeResult {
  codec: string;
  codecTag?: string;
  width: number;
  height: number;
  frameRate: number;
  durationSeconds: number;
  /** The container's own creation time, when it carries one. ⚠️ mp4/mov do; avi does not. */
  createdAt?: Date;
}

export interface MediaProbe {
  probe(url: string): Promise<ProbeResult>;
}

export interface FfprobeOptions {
  binary?: string;
  /** ⚠️ Wall-clock ceiling. A probe that cannot answer in this long is a refusal. */
  timeoutMs?: number;
  /** Output ceiling in bytes. */
  maxOutputBytes?: number;
}

export class FfprobeMediaProbe implements MediaProbe {
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(opts: FfprobeOptions = {}) {
    this.#binary = opts.binary ?? 'ffprobe';
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#maxOutputBytes = opts.maxOutputBytes ?? 1_000_000;
  }

  async probe(url: string): Promise<ProbeResult> {
    const raw = await this.#run([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,codec_tag_string,width,height,avg_frame_rate,r_frame_rate,duration',
      '-show_entries',
      'format=duration,format_name:format_tags=creation_time',
      '-of',
      'json',
      url,
    ]);
    return parseProbe(raw);
  }

  #run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let truncated = false;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`ffprobe did not answer within ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (out.length + chunk.length > this.#maxOutputBytes) {
          truncated = true;
          child.kill('SIGKILL');
          return;
        }
        out += chunk.toString('utf8');
      });
      /* ⚠️ Bounded too — a file that produces an error per frame would otherwise fill memory. */
      child.stderr.on('data', (chunk: Buffer) => {
        if (err.length < 4000) err += chunk.toString('utf8');
      });

      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`ffprobe could not be started: ${e.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (truncated) {
          reject(new Error('ffprobe produced more output than a video description can need'));
          return;
        }
        if (code !== 0) {
          reject(new Error(`ffprobe exited ${String(code)}: ${err.trim().slice(0, 300)}`));
          return;
        }
        resolve(out);
      });
    });
  }
}

/**
 * ⚠️ Pure, and separate from the spawn, so every shape ffprobe can return is testable without a
 * file — including the ones that produce a plausible wrong answer rather than an error.
 */
export function parseProbe(raw: string): ProbeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('ffprobe returned output that is not JSON');
  }
  const root = json as {
    streams?: Array<Record<string, unknown>>;
    format?: { duration?: string; tags?: Record<string, string> };
  };
  const stream = root.streams?.[0];
  /*
   * ⛔ No video stream is the single most important refusal here. An audio file, a text file with a
   * video extension and a corrupt container all land in this branch, and the alternative is an
   * analysis that runs happily over nothing.
   */
  if (stream === undefined) throw new Error('the file contains no video stream');

  const codec = asString(stream['codec_name']);
  if (codec === undefined) throw new Error('the file’s video stream declares no codec');

  const width = asNumber(stream['width']);
  const height = asNumber(stream['height']);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    throw new Error('the file’s video stream has no usable dimensions');
  }

  /*
   * ⚠️ Duration lives on the stream for some containers and on the format for others, and a
   * fragmented mp4 can carry it in neither. Absent is 0, which `rejectAsset` refuses by name —
   * never a guess, and never a silently-accepted unknown.
   */
  const duration = asFloat(stream['duration']) ?? asFloat(root.format?.duration) ?? 0;

  const codecTag = asString(stream['codec_tag_string']);
  const created = root.format?.tags?.['creation_time'];
  const createdAt = created === undefined ? undefined : new Date(created);

  return {
    codec,
    ...(codecTag === undefined || codecTag === '' || codecTag === '[0][0][0][0]'
      ? {}
      : { codecTag }),
    width,
    height,
    frameRate: parseRational(
      asString(stream['avg_frame_rate']) ?? asString(stream['r_frame_rate']),
    ),
    durationSeconds: duration,
    ...(createdAt === undefined || Number.isNaN(createdAt.getTime()) ? {} : { createdAt }),
  };
}

/**
 * ffprobe reports frame rate as a rational (`30000/1001`), and `0/0` for a stream that has none.
 *
 * ⚠️ `0/0` must become **0**, not `NaN` and not a division by zero — it flows into `sourceFrameRate`,
 * which is presented to an operator. A `NaN` there fails contract validation at the far end of the
 * request, which is the least useful place to discover a malformed upload.
 */
export function parseRational(value: string | undefined): number {
  if (value === undefined) return 0;
  const [n, d] = value.split('/');
  const num = Number(n);
  const den = d === undefined ? 1 : Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/** Build the stored asset from what was measured plus what the platform already knows. */
export function assetFromProbe(input: {
  key: string;
  originalName: string;
  bytes: number;
  contentType: string;
  container: AnalysisContainer;
  probe: ProbeResult;
}): AnalysisAsset {
  return {
    key: input.key,
    originalName: input.originalName,
    bytes: input.bytes,
    contentType: input.contentType,
    container: input.container,
    codec: input.probe.codec,
    ...(input.probe.codecTag === undefined ? {} : { codecTag: input.probe.codecTag }),
    width: input.probe.width,
    height: input.probe.height,
    sourceFrameRate: input.probe.frameRate,
    durationSeconds: input.probe.durationSeconds,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asFloat(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
