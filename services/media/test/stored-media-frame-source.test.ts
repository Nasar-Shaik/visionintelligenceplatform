/**
 * Unit tests for the stored-media decoder's **pure parts** (P-8 Phase 8, slice 3).
 *
 * ⚠️ The decoder itself spawns ffmpeg, which is a system dependency present in the container and not
 * on every developer's machine — so it is exercised by the deployed verification (see
 * `docs/verification/P8-PHASE8-SLICE3.md`) exactly as `FfmpegDecoder` has always been. What is
 * tested here is everything that decides a *result* rather than moving bytes: the command line, the
 * timestamp parsing and the arithmetic. Those are where a defect changes a customer's answer.
 */
import { describe, expect, it } from 'vitest';
import {
  buildArgs,
  lastError,
  parseShowinfoPts,
  PTS_DIVERGENCE_TOLERANCE_FRAMES,
  STORED_MEDIA_DECODER_VERSION,
} from '../src/adapters/stored-media-frame-source.js';
import { frameFootageTime, frameOffsetSeconds } from '../src/domain/analysis.js';

describe('buildArgs — the ffmpeg command line', () => {
  const request = { fromOffsetSeconds: 120, durationSeconds: 120, frameRate: 2 };

  /**
   * ⭐ **The single most important assertion in this file.**
   *
   * `-ss` *before* `-i` is an input seek: ffmpeg jumps using the container index and issues an HTTP
   * range request. After `-i` it decodes everything from zero and throws it away — turning a
   * two-minute chunk near the end of a four-hour recording into a four-hour decode. The flags look
   * almost identical in a diff, and the behaviour differs by two orders of magnitude.
   */
  it('seeks on the INPUT, not the output', () => {
    const args = buildArgs('https://store/obj', request);
    const ss = args.indexOf('-ss');
    const i = args.indexOf('-i');
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(i);
    expect(args[ss + 1]).toBe('120.000000');
  });

  /** ⚠️ `-t` bounds the OUTPUT, so it must come after the input. */
  it('bounds the chunk after the input', () => {
    const args = buildArgs('https://store/obj', request);
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'));
  });

  /**
   * ⚠️ `showinfo` must follow `fps`, or the timestamps describe the source's frames rather than the
   * ones emitted — and would not even match in count.
   */
  it('places showinfo after the fps filter so timestamps describe emitted frames', () => {
    const args = buildArgs('https://store/obj', request);
    expect(args).toContain('fps=2,showinfo');
  });

  /**
   * ⛔ `-loglevel info`, not `error`. `showinfo` writes at info level, so lowering it would silently
   * remove every presentation timestamp — and the divergence check would then report "no PTS
   * available" for every frame of every analysis, which reads as a broken file rather than a broken
   * flag.
   */
  it('keeps the log level high enough for showinfo to be emitted', () => {
    expect(buildArgs('https://store/obj', request)).toContain('info');
  });

  /**
   * ⛔ **No `-re`.** It would throttle ffmpeg to the footage's own rate and cap every analysis at 1×.
   * Pacing is the worker's job, applied once, off the decode path.
   */
  it('never throttles the decoder to real time', () => {
    expect(buildArgs('https://store/obj', request)).not.toContain('-re');
  });

  /**
   * ⚠️ No segment writing. The recording already exists in the object store, so a second copy would
   * fill a customer's storage with their own upload.
   *
   * ⚠️ It asserts the absence of the **segment muxer**, not of `-f` — `-f image2pipe` is the frame
   * pipe and is required. An assertion on `-f` alone passes only by accident of ordering and would
   * have to be deleted the moment anything legitimate used it.
   */
  it('writes no recording segments — the only output is the frame pipe', () => {
    const args = buildArgs('https://store/obj', request);
    expect(args).not.toContain('segment');
    expect(args).not.toContain('-segment_time');
    /* Exactly one `-f`, and it is the pipe. */
    expect(args.filter((a) => a === '-f')).toHaveLength(1);
    expect(args[args.indexOf('-f') + 1]).toBe('image2pipe');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  /** ⚠️ Argument array, never a shell string — a signed URL is full of `&` and `=`. */
  it('passes the url as one argument', () => {
    const url = 'https://s3/bucket/k?X-Amz-Signature=abc&X-Amz-Expires=3600';
    expect(buildArgs(url, request)).toContain(url);
  });
});

describe('parseShowinfoPts', () => {
  const line = (t: string): string =>
    `[Parsed_showinfo_1 @ 0x55] n:0 pts:0 pts_time:${t} duration_time:0.5 fmt:yuv420p`;

  it('reads timestamps in the order ffmpeg emitted them', () => {
    expect(parseShowinfoPts(`${line('0')}\n${line('0.5')}\n${line('1')}`)).toEqual([0, 0.5, 1]);
  });

  /** ⚠️ Chunked stderr means a value can be split across two reads — a partial must not be invented. */
  it('reads nothing from a line with no timestamp', () => {
    expect(parseShowinfoPts('[Parsed_showinfo_1 @ 0x55] n:0 pts:0 pts_ti')).toEqual([]);
  });

  it('ignores unrelated ffmpeg chatter', () => {
    expect(parseShowinfoPts('Stream #0:0 -> #0:0 (h264 -> mjpeg)\nframe= 12 fps=0.0')).toEqual([]);
  });

  /** ⚠️ A negative timestamp is real (a container with an edit list) and is not silently dropped. */
  it('keeps a negative timestamp rather than discarding it', () => {
    expect(parseShowinfoPts(line('-0.033'))).toEqual([-0.033]);
  });
});

describe('lastError', () => {
  /** ⚠️ The showinfo chatter is filtered out, or every failure would be reported as a frame dump. */
  it('reports the real diagnostic, not the last showinfo line', () => {
    const stderr = [
      '[Parsed_showinfo_1 @ 0x55] n:0 pts_time:0',
      'https://store/obj: Server returned 403 Forbidden',
      '[Parsed_showinfo_1 @ 0x55] n:1 pts_time:0.5',
    ].join('\n');
    expect(lastError(stderr)).toBe('https://store/obj: Server returned 403 Forbidden');
  });

  it('says so rather than returning an empty string', () => {
    expect(lastError('   \n  \n')).toBe('ffmpeg gave no diagnostic');
  });
});

/**
 * ⭐ The chunk-seam arithmetic, worked through explicitly.
 *
 * These are the numbers that decide whether a resume repeats half a second of a customer's footage
 * or skips it, and they are subtle enough that reasoning about them in a comment is not enough.
 */
describe('chunk seam arithmetic', () => {
  const rate = 2;

  it('places the first frame of the recording at offset zero', () => {
    expect(frameOffsetSeconds(1, rate)).toBe(0);
    expect(frameFootageTime('2026-02-14T18:30:00.000Z', 1, rate).toISOString()).toBe(
      '2026-02-14T18:30:00.000Z',
    );
  });

  /**
   * ⚠️ Measured: `-t 120` at 2 fps emits **241** frames (0.0 … 120.0 inclusive), not 240. The next
   * chunk must therefore start at 120.5, and its `seqAtChunkStart` must line up with it exactly.
   */
  it('joins a chunk boundary with no repeat and no gap', () => {
    const framesInChunk0 = 241;
    const seqAtChunk0 = 0;
    const reached = frameOffsetSeconds(seqAtChunk0 + framesInChunk0 + 1, rate);
    expect(reached).toBe(120.5);

    /* The next chunk derives its starting sequence from that offset. */
    const seqAtChunk1 = Math.round(reached * rate);
    expect(seqAtChunk1).toBe(241);
    const firstSeqOfChunk1 = seqAtChunk1 + 0 + 1;
    expect(firstSeqOfChunk1).toBe(242);
    /* ⭐ Frame 242 sits at 120.5 s — exactly one interval after chunk 0's last frame at 120.0 s. */
    expect(frameOffsetSeconds(firstSeqOfChunk1, rate)).toBe(120.5);
    expect(frameOffsetSeconds(seqAtChunk0 + framesInChunk0, rate)).toBe(120);
  });

  it('stamps footage time six weeks before the analysis ran', () => {
    /* Frame 2 401 at 2 fps → 1 200 s → 20 minutes into the footage. */
    expect(frameFootageTime('2026-02-14T18:30:00.000Z', 2401, rate).toISOString()).toBe(
      '2026-02-14T18:50:00.000Z',
    );
  });
});

describe('decoder identity', () => {
  /** ⚠️ Versioned, because a decoder upgrade can change a result with no other field moving. */
  it('names itself and its version', () => {
    expect(STORED_MEDIA_DECODER_VERSION).toMatch(/^ffmpeg-stored-media\/\d+\.\d+\.\d+$/);
  });

  /** ⚠️ One full frame interval, not half — see the constant's own note. */
  it('tolerates one frame interval of timestamp drift', () => {
    expect(PTS_DIVERGENCE_TOLERANCE_FRAMES).toBe(1);
  });
});
