/**
 * Domain: replay pacing (P-8 Phase 8, slice 3) — how fast a session works through its footage.
 *
 * ### ⭐ The one property this file exists to preserve
 *
 * **Pacing changes when an answer arrives and never what the answer is.** Every downstream decision
 * on this platform — the events service's dedup window, `window`, `dwell`, every rule cool-down — is
 * keyed on `occurredAt`, which for an offline analysis is *footage* time derived from the frame's
 * position in the file. Wall clock reaches nothing that decides anything.
 *
 * That is why this is a separate, pure-ish module rather than three lines in the worker's loop: the
 * claim is the milestone's central acceptance criterion, so the thing that could break it is worth
 * being able to point at, drive from a test, and reason about on its own.
 *
 * ⚠️ **It sleeps and it does nothing else.** It never touches a frame's timestamp, never reorders,
 * never skips. A pacer that dropped frames to "keep up" would silently turn a slow host into a
 * different analytical answer, which is precisely the class of defect the parity run exists to catch.
 */
import type { Frame } from '../application/ports.js';

/** Injectable so a test drives a four-hour recording in milliseconds. */
export interface Sleeper {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemSleeper: Sleeper = {
  async sleep(ms, signal) {
    if (ms <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  },
};

export interface PacerDeps {
  /**
   * Footage seconds per wall-clock second, or `null` for as fast as the runtime allows.
   *
   * ⚠️ `null` is not "speed 0" and not "speed ∞" — it is *unpaced*, meaning this class does nothing
   * at all. Encoding it as a number would put a fabricated figure in the session record.
   */
  speed: number | null;
  /** Wall clock. ⚠️ Injected — a pacer that read `Date.now()` could not be tested deterministically. */
  now(): number;
  sleeper: Sleeper;
}

/**
 * Paces frame delivery to a multiple of real time.
 *
 * ⭐ **It paces against the footage clock, not against a fixed per-frame budget**, and the difference
 * matters at exactly the moment it is hardest to notice. A fixed budget of `1 / (rate × speed)` per
 * frame accumulates the runtime's own latency: if inference takes 300 ms and the budget is 500 ms,
 * every frame slips 300 ms and a 20-minute demonstration finishes 12 minutes late while claiming 1×.
 * Measuring each frame's target against the footage offset of the **first** frame makes the error
 * self-correcting — a slow frame is followed by a shorter wait, not by a permanent lag.
 */
export class Pacer {
  readonly #deps: PacerDeps;
  #startedAtMs: number | undefined;
  #startOffsetSeconds: number | undefined;
  /** ⚠️ Measured, so a session can report that it could not keep up rather than implying it did. */
  #behindMs = 0;
  #frames = 0;

  constructor(deps: PacerDeps) {
    this.#deps = deps;
  }

  /** Wait until this frame's footage position is due. Returns immediately when unpaced. */
  async wait(frame: Frame, signal: AbortSignal): Promise<void> {
    const speed = this.#deps.speed;
    if (speed === null) return;

    const offset = frame.provenance?.mediaOffsetSeconds;
    /*
     * ⚠️ A frame with no provenance cannot be paced, and is passed through rather than guessed at.
     * The live path produces such frames by design and never reaches here; if one ever did, delaying
     * it by an invented amount would be worse than not pacing it.
     */
    if (offset === undefined) return;

    const nowMs = this.#deps.now();
    if (this.#startedAtMs === undefined || this.#startOffsetSeconds === undefined) {
      this.#startedAtMs = nowMs;
      this.#startOffsetSeconds = offset;
      this.#frames = 1;
      return;
    }

    this.#frames += 1;
    const footageElapsed = offset - this.#startOffsetSeconds;
    const dueAtMs = this.#startedAtMs + (footageElapsed / speed) * 1000;
    const waitMs = dueAtMs - nowMs;
    if (waitMs <= 0) {
      /* ⭐ Behind, not ahead. Recorded rather than silently absorbed — see `report()`. */
      this.#behindMs = Math.max(this.#behindMs, -waitMs);
      return;
    }
    await this.#deps.sleeper.sleep(waitMs, signal);
  }

  /**
   * What the pacing actually achieved.
   *
   * ⚠️ **`behindMs` is the honest half of this feature.** A demonstration asked to run at 1× on a
   * host that cannot manage it will run slower and there is nothing to be done about that — but the
   * session must be able to say so, rather than presenting a rate it did not achieve. It changes no
   * analytical result: the frames were all delivered, in order, with their footage timestamps intact.
   */
  report(): { requestedSpeed: number | null; framesPaced: number; behindMs: number } {
    return {
      requestedSpeed: this.#deps.speed,
      framesPaced: this.#frames,
      behindMs: Math.round(this.#behindMs),
    };
  }
}

/**
 * How far behind a paced session may fall before it is worth telling the operator.
 *
 * ⚠️ Two seconds, not two hundred milliseconds. A GC pause, a slow first inference or a container
 * scheduling blip will each cost a few hundred milliseconds on any real host, and a finding raised
 * for those would appear on every run and teach an operator to ignore findings.
 */
export const PACING_BEHIND_TOLERANCE_MS = 2000;
