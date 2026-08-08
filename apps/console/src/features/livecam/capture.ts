/**
 * The browser half of the live capture path (P-9), as pure logic.
 *
 * ⭐ **Separated from the component on purpose, and the reason is the same one `overlay.ts` gives.**
 * jsdom implements no `MediaDevices`, no `HTMLVideoElement` that ever loads, and no `canvas`
 * that encodes — so anything left inside the component can only be exercised by a browser, and a
 * browser test that has to grant a camera permission is not a test anybody runs on a change. Every
 * decision that can send the wrong frame, mismeasure a stage, or lie in a statistic lives here,
 * where a test drives it with numbers.
 *
 * ### ⛔ The loop DROPS; it never queues. This is parity, not an optimisation.
 *
 * `FrameSink.push()` — the door this producer feeds — states its policy in its own header: *"The
 * oldest frame goes and the freshest is kept, because only the freshest can still matter."* A
 * browser that queued frames while an upload was in flight would hand the platform a frame stamped
 * with the service clock at the moment it *arrived*, which by then describes a scene that is
 * seconds old. The buffering would be invisible: every frame accepted, every counter healthy, and
 * every incident late. So a tick that finds the previous upload unfinished records
 * `skipped-busy` and moves on — the same answer the sink gives, taken one hop earlier where it
 * costs no bandwidth.
 */

/**
 * A stage's timing distribution.
 *
 * ⚠️ **`count` travels with it, and reading it is not optional.** `p95` is computed by nearest rank,
 * so for fewer than 20 samples it is arithmetically identical to `max` — a true statement about the
 * numbers and a useless one about the system. A report that prints a p95 without saying how many
 * samples produced it invites exactly the conclusion the sample size cannot support.
 */
export interface StageStats {
  count: number;
  min: number;
  avg: number;
  p95: number;
  max: number;
}

/**
 * A bounded sample of one stage's durations.
 *
 * ⚠️ `stats()` returns `null` before anything is measured — never a zeroed record (ADR-0039).
 * "Capture takes 0 ms" and "nothing has been captured" render identically and mean opposite things,
 * and this is the milestone whose entire output is latency numbers.
 */
export class StageTimer {
  readonly #samples: number[] = [];
  readonly #limit: number;

  constructor(limit = 1_000) {
    this.#limit = limit;
  }

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#samples.push(ms);
    if (this.#samples.length > this.#limit) this.#samples.shift();
  }

  get count(): number {
    return this.#samples.length;
  }

  stats(): StageStats | null {
    if (this.#samples.length === 0) return null;
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: sorted.length,
      min: sorted[0]!,
      avg: sum / sorted.length,
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1]!,
    };
  }
}

/**
 * Nearest-rank percentile over an already-sorted array.
 *
 * ⚠️ Nearest rank rather than interpolation, deliberately. An interpolated p95 invents a value
 * between two measurements that never occurred; for a latency budget a reader will quote back, an
 * observed number is worth more than a smoother one.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** What one capture produced, with the two browser stages already measured. */
export interface CapturedFrame {
  /** Base64 JPEG, ready for the ingest route's body. */
  image: string;
  bytes: number;
  /** Video element → canvas. */
  captureMs: number;
  /** Canvas → JPEG. */
  encodeMs: number;
  /** The client's clock at the instant the pixels were taken. Used ONLY for latency. */
  capturedAtMs: number;
}

export interface UploadResult {
  ok: boolean;
  /** The sequence number the platform assigned. Absent when the frame was refused. */
  seq?: number | undefined;
  /** Transport age as the *service* measured it, or `null` when it declined to believe the clock. */
  arrivalLagMs?: number | null | undefined;
  status?: number | undefined;
  error?: string | undefined;
}

export type AttemptOutcome = 'accepted' | 'rejected' | 'failed' | 'skipped-busy' | 'no-frame';

export interface FrameAttempt {
  outcome: AttemptOutcome;
  captureMs: number | null;
  encodeMs: number | null;
  uploadMs: number | null;
  bytes: number | null;
  seq: number | null;
  arrivalLagMs: number | null;
  error?: string;
}

export interface CaptureCounters {
  ticks: number;
  accepted: number;
  rejected: number;
  failed: number;
  skippedBusy: number;
  noFrame: number;
  bytesSent: number;
}

export interface CaptureLoopDeps {
  fps: number;
  /**
   * Frames allowed in flight at once.
   *
   * ⚠️ **1 by default, and raising it is a measurement decision, not a throughput one.** With one in
   * flight, `uploadMs` is a clean round trip. With more, uploads contend for the browser's
   * per-origin connection pool and the number stops being "how long the network took" — it becomes
   * "how long the network took plus how long we made it wait behind ourselves". The back-pressure
   * validation raises it deliberately to force the sink's queue to fill; nothing else should.
   */
  maxInflight?: number;
  capture: () => Promise<CapturedFrame | null>;
  upload: (frame: CapturedFrame) => Promise<UploadResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: FrameAttempt) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Paces capture at a target rate and reports what each frame cost.
 *
 * ⚠️ **The cadence is anchored to a start time, not to the last tick.** `setTimeout(1000/fps)` in a
 * loop accumulates every scheduling delay: at 4 fps with 30 ms of jitter per tick, ten minutes of
 * capture drifts by ~72 seconds and the achieved rate quietly reads 3.9 fps for reasons that have
 * nothing to do with the platform. Computing each deadline from `startedAt + n × interval` makes a
 * late tick borrow from the next one instead of pushing it.
 */
export class LiveCaptureLoop {
  readonly stages = {
    capture: new StageTimer(),
    encode: new StageTimer(),
    upload: new StageTimer(),
    /** Service-measured transport age. Its own timer because it is measured by the *other* clock. */
    transport: new StageTimer(),
  };

  readonly counters: CaptureCounters = {
    ticks: 0,
    accepted: 0,
    rejected: 0,
    failed: 0,
    skippedBusy: 0,
    noFrame: 0,
    bytesSent: 0,
  };

  #running = false;
  #inflight = 0;
  #startedAt = 0;
  readonly #deps: CaptureLoopDeps;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxInflight: number;

  constructor(deps: CaptureLoopDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#maxInflight = Math.max(1, deps.maxInflight ?? 1);
  }

  get running(): boolean {
    return this.#running;
  }

  get inflight(): number {
    return this.#inflight;
  }

  /** Frames accepted per second of wall clock. `null` before the first one — never 0. */
  achievedFps(): number | null {
    if (this.counters.accepted === 0) return null;
    const seconds = (this.#now() - this.#startedAt) / 1000;
    return seconds <= 0 ? null : this.counters.accepted / seconds;
  }

  stop(): void {
    this.#running = false;
  }

  /** Runs until `stop()`. Resolves once the loop has left; in-flight uploads may still settle. */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#startedAt = this.#now();
    const interval = 1000 / this.#deps.fps;
    let tick = 0;

    while (this.#running) {
      this.counters.ticks += 1;
      if (this.#inflight >= this.#maxInflight) {
        this.counters.skippedBusy += 1;
        this.#report({
          outcome: 'skipped-busy',
          captureMs: null,
          encodeMs: null,
          uploadMs: null,
          bytes: null,
          seq: null,
          arrivalLagMs: null,
        });
      } else {
        void this.#one();
      }
      tick += 1;
      /*
       * ⚠️ A deadline that has already passed yields 0, not a negative sleep — and the loop still
       * yields to the event loop so an in-flight upload can settle and `stop()` can be observed. A
       * `while` that never awaits is a frozen tab, which is how a capture page becomes the thing
       * that breaks the browser it is meant to be validating.
       */
      const due = this.#startedAt + tick * interval;
      await this.#sleep(Math.max(0, due - this.#now()));
    }
  }

  async #one(): Promise<void> {
    this.#inflight += 1;
    try {
      const frame = await this.#deps.capture();
      if (frame === null) {
        this.counters.noFrame += 1;
        this.#report({
          outcome: 'no-frame',
          captureMs: null,
          encodeMs: null,
          uploadMs: null,
          bytes: null,
          seq: null,
          arrivalLagMs: null,
        });
        return;
      }
      this.stages.capture.add(frame.captureMs);
      this.stages.encode.add(frame.encodeMs);

      const sent = this.#now();
      const result = await this.#deps.upload(frame);
      const uploadMs = this.#now() - sent;
      this.stages.upload.add(uploadMs);

      const arrivalLagMs =
        typeof result.arrivalLagMs === 'number' ? result.arrivalLagMs : null;
      if (arrivalLagMs !== null) this.stages.transport.add(arrivalLagMs);

      if (result.ok) {
        this.counters.accepted += 1;
        this.counters.bytesSent += frame.bytes;
      } else {
        this.counters.rejected += 1;
      }
      this.#report({
        outcome: result.ok ? 'accepted' : 'rejected',
        captureMs: frame.captureMs,
        encodeMs: frame.encodeMs,
        uploadMs,
        bytes: frame.bytes,
        seq: result.seq ?? null,
        arrivalLagMs,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    } catch (err) {
      this.counters.failed += 1;
      this.#report({
        outcome: 'failed',
        captureMs: null,
        encodeMs: null,
        uploadMs: null,
        bytes: null,
        seq: null,
        arrivalLagMs: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.#inflight -= 1;
    }
  }

  #report(attempt: FrameAttempt): void {
    this.#deps.onAttempt?.(attempt);
  }
}

/**
 * ⭐ **How far the browser's clock is from the platform's**, estimated the way NTP does it.
 *
 * ⛔ Without this the whole transport figure is unsound. `arrivalLagMs` is
 * `serviceClock.now() − browserClock.capturedAt`: it is transport time **plus clock skew**, and the
 * two are not separable from one sample. A laptop 400 ms behind the server reports 400 ms of
 * network latency that does not exist; one 400 ms ahead reports a negative lag the service then
 * refuses to believe at all, so the stage silently measures nothing. Both are ways for a latency
 * report to be confidently wrong, and neither shows up as an error.
 *
 * `t0` is client-send, `t1` is client-receive, `serverMs` is the instant the service stamped in
 * between. The estimate assumes a symmetric round trip — the assumption is not free, so
 * `uncertaintyMs` (half the round trip) is returned with it and the report prints both. An offset
 * of 12 ms ± 40 ms is a statement that the clocks agree to within the measurement; the same number
 * without its uncertainty is a false precision.
 */
export function estimateClockOffset(
  t0: number,
  t1: number,
  serverMs: number,
): { offsetMs: number; uncertaintyMs: number; roundTripMs: number } {
  const roundTripMs = t1 - t0;
  return {
    offsetMs: serverMs - (t0 + t1) / 2,
    uncertaintyMs: roundTripMs / 2,
    roundTripMs,
  };
}

/**
 * The capture geometry actually used, given what the device produced and what was asked for.
 *
 * ⚠️ **The aspect ratio is preserved and the request is a bound, not a shape.** A webcam ignores
 * `width`/`height` constraints it cannot satisfy and hands back whatever its sensor does; scaling
 * that into a fixed box would letterbox or stretch every frame the detector sees. A stretched
 * person is a person the model was never trained on, and the resulting miss would be recorded as a
 * detector limitation rather than as the bug it is.
 */
export function fitCapture(
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
): { width: number; height: number; scale: number } {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return { width: 0, height: 0, scale: 1 };
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest <= maxEdge ? 1 : maxEdge / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    scale,
  };
}

/**
 * Bytes → base64, in chunks.
 *
 * ⛔ **The obvious one-liner crashes on real frames.** `String.fromCharCode(...bytes)` spreads every
 * byte into an argument list, and a 640×480 JPEG is ~40 000 of them — under the engine's argument
 * limit, so it works in a test with a small fixture and works at low resolution. Raise the capture
 * to 1080p, or turn the quality up, and the same call throws `RangeError: Maximum call stack size
 * exceeded` on a path with no error handling around it. The failure would look like "capture stops
 * working at high resolution", which is not where anyone would look for a base64 helper.
 *
 * 0x8000 per chunk is comfortably inside every engine's limit and costs one concatenation per 32 KB.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Turn a `getUserMedia` rejection into something an operator can act on.
 *
 * ⚠️ **The name is the signal, not the message.** Browsers word these differently and change the
 * wording between versions; `NotAllowedError` is stable and means one specific thing. Matching on
 * message text is how a recovery path stops working after a Chrome update, silently, in the
 * direction of "unknown error".
 */
export function describeCameraError(err: unknown): { code: string; message: string; retry: boolean } {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
      return {
        code: 'permission-denied',
        message:
          'The browser blocked camera access. Grant it in the site permissions and press Start again — the page cannot re-prompt on its own once denied.',
        retry: true,
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        code: 'no-device',
        message:
          'No camera matched. Check the device is connected and not held by another application, then choose it from the list.',
        retry: true,
      };
    case 'NotReadableError':
      return {
        code: 'device-busy',
        message:
          'The camera is connected but another application is holding it. Close that application and press Start again.',
        retry: true,
      };
    case 'AbortError':
      return { code: 'aborted', message: 'Camera start was interrupted. Press Start again.', retry: true };
    case 'SecurityError':
      return {
        code: 'insecure-context',
        message:
          'The browser refuses camera access on this origin. Live capture requires HTTPS and a Permissions-Policy that allows the camera.',
        retry: false,
      };
    case 'NotSupportedError':
      /*
       * ⛔ **Found by the certification run, and it produced the exact message this function
       * exists to prevent.** A headless Chromium with no camera backend rejects with
       * `NotSupportedError` and the message "Not supported" — which fell through to `unknown` and
       * rendered as **"unknown — Not supported"**. That tells an operator nothing, and it is the
       * failure mode a real deployment hits too: a browser without a media backend, an OS that has
       * disabled the camera at system level, or a constraint set the device cannot satisfy.
       *
       * ⚠️ Not retryable. Pressing Start again cannot conjure a capture backend, and offering a
       * retry that is guaranteed to fail is worse than saying so.
       */
      return {
        code: 'capture-unsupported',
        message:
          'This browser cannot capture video here — there is no camera backend available. Check the camera is enabled at the operating-system level, and use Chrome or Edge 120+ on a machine with a working camera.',
        retry: false,
      };
    default:
      return {
        code: 'unknown',
        message: err instanceof Error ? err.message : String(err),
        retry: true,
      };
  }
}
