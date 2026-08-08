/**
 * **Did the host stay awake for the run?**
 *
 * ⛔ Every long measurement in this repository divides work by wall-clock time — frames per second,
 * memory drift per hour, latency in the first tenth versus the last. All of it assumes the process
 * was *running* for the whole span. A laptop that sleeps, a container that is paused, a `SIGSTOP`,
 * an aggressive App Nap: each freezes the process while `Date.now()` keeps advancing, and every
 * derived rate silently becomes a fraction of the truth.
 *
 * This was not hypothetical. The P-9 30-minute soak (2026-08-08) sent 7181 frames at a true and
 * exact 4.000 fps, then the host suspended for **966 seconds** and the run ended on wake. Its own
 * output recorded `seconds: 2761.2` and `achievedFps: 2.6` — a 35 % shortfall against target that
 * never happened. Both existing guards passed: nothing was rejected, and the platform's accepted
 * count agreed with the sender's exactly. ⭐ **A run can be invalidated by the machine underneath
 * it, with the sender and the platform both behaving perfectly.**
 *
 * The detector is the sampler's own timestamps. A sampler on a fixed interval writes a heartbeat;
 * a gap several times that interval means nobody was running, because a busy event loop delays a
 * timer by milliseconds and a suspended process delays it by minutes.
 *
 * ⚠️ This measures the *host*, not the product. A gap here never means the deployment stalled — a
 * frozen process cannot observe a stalled platform. It means the numbers describe a span that
 * cannot be trusted, and the honest response is to report the uninterrupted part or re-run.
 */

/**
 * A backwards step is a continuity break too. NTP correcting a drifted clock mid-run moves
 * `Date.now()` *backwards*, which makes elapsed time shrink and every rate computed from it rise.
 * That reads as good news, which is why it is worth naming separately rather than folding into the
 * gap list.
 */
const parse = (sample) => {
  const t = Date.parse(String(sample?.at ?? ''));
  return Number.isFinite(t) ? t : null;
};

/**
 * @param {{ samples: readonly unknown[], intervalMs: number, factor?: number }} input
 */
export function analyseContinuity({ samples, intervalMs, factor = 3 }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`analyseContinuity: intervalMs must be a positive number, got ${String(intervalMs)}`);
  }
  const thresholdMs = intervalMs * factor;
  const points = [];
  let undated = 0;
  for (const s of samples ?? []) {
    const t = parse(s);
    if (t === null) undated += 1;
    else points.push(t);
  }

  const base = {
    intervalMs,
    factor,
    thresholdSeconds: Number((thresholdMs / 1_000).toFixed(1)),
    undatedSamples: undated,
    sampleCount: points.length,
  };

  /*
   * ⚠️ Fewer than two heartbeats is not evidence of continuity — it is the absence of evidence.
   * Reporting `intact: true` here would let a run that produced one sample claim it was never
   * suspended, so the caller is told the check could not be performed instead.
   */
  if (points.length < 2) {
    return {
      ...base,
      inconclusive: true,
      intact: false,
      totalSeconds: 0,
      suspendedSeconds: 0,
      suspensions: [],
      backwardsSteps: [],
      uninterrupted: { fromIndex: 0, toIndex: Math.max(0, points.length - 1), count: points.length, seconds: 0 },
    };
  }

  const suspensions = [];
  const backwardsSteps = [];
  /* Boundaries of contiguous runs, as [start, end] index pairs into `points`. */
  let runStart = 0;
  let best = { fromIndex: 0, toIndex: 0 };
  const closeRun = (endIndex) => {
    const seconds = (points[endIndex] - points[runStart]) / 1_000;
    const bestSeconds = (points[best.toIndex] - points[best.fromIndex]) / 1_000;
    if (seconds > bestSeconds) best = { fromIndex: runStart, toIndex: endIndex };
  };

  for (let i = 1; i < points.length; i += 1) {
    const deltaMs = points[i] - points[i - 1];
    if (deltaMs < 0) {
      backwardsSteps.push({
        afterAt: new Date(points[i - 1]).toISOString(),
        untilAt: new Date(points[i]).toISOString(),
        seconds: Number((deltaMs / 1_000).toFixed(1)),
      });
      closeRun(i - 1);
      runStart = i;
    } else if (deltaMs > thresholdMs) {
      suspensions.push({
        afterAt: new Date(points[i - 1]).toISOString(),
        untilAt: new Date(points[i]).toISOString(),
        seconds: Number((deltaMs / 1_000).toFixed(1)),
      });
      closeRun(i - 1);
      runStart = i;
    }
  }
  closeRun(points.length - 1);

  const suspendedSeconds = suspensions.reduce((acc, s) => acc + s.seconds, 0);
  return {
    ...base,
    inconclusive: false,
    intact: suspensions.length === 0 && backwardsSteps.length === 0,
    totalSeconds: Number(((points[points.length - 1] - points[0]) / 1_000).toFixed(1)),
    suspendedSeconds: Number(suspendedSeconds.toFixed(1)),
    suspensions,
    backwardsSteps,
    uninterrupted: {
      fromIndex: best.fromIndex,
      toIndex: best.toIndex,
      count: best.toIndex - best.fromIndex + 1,
      fromAt: new Date(points[best.fromIndex]).toISOString(),
      toAt: new Date(points[best.toIndex]).toISOString(),
      seconds: Number(((points[best.toIndex] - points[best.fromIndex]) / 1_000).toFixed(1)),
    },
  };
}

/**
 * The longest stretch the process was demonstrably awake for.
 *
 * ⭐ Analyse **this**, not the whole array. Deriving drift across a suspension compares the minutes
 * before a freeze with the minutes after a thaw and calls the difference a trend.
 *
 * @param {{ samples: readonly unknown[], intervalMs: number, factor?: number }} input
 */
export function sliceUninterrupted({ samples, intervalMs, factor = 3 }) {
  const all = [...(samples ?? [])];
  const dated = all.filter((s) => parse(s) !== null);
  const c = analyseContinuity({ samples: dated, intervalMs, factor });
  if (c.inconclusive) return dated;
  return dated.slice(c.uninterrupted.fromIndex, c.uninterrupted.toIndex + 1);
}

/**
 * One line for a console, and the sentence a report should print instead of a rate.
 *
 * @param {ReturnType<typeof analyseContinuity>} c
 */
export function describeContinuity(c) {
  if (c.inconclusive) {
    return `⚠️ CONTINUITY UNKNOWN — ${String(c.sampleCount)} sample(s) is too few to tell whether the host stayed awake.`;
  }
  if (c.intact) {
    return `✅ continuous — ${String(c.sampleCount)} samples over ${String(c.totalSeconds)} s, no gap beyond ${String(c.thresholdSeconds)} s.`;
  }
  const parts = c.suspensions.map((s) => `${String(s.seconds)} s after ${s.afterAt}`);
  const back = c.backwardsSteps.map((s) => `clock stepped back ${String(Math.abs(s.seconds))} s at ${s.afterAt}`);
  return (
    `⛔ HOST SUSPENDED — ${String(c.suspensions.length)} gap(s) totalling ${String(c.suspendedSeconds)} s ` +
    `(${[...parts, ...back].join('; ')}). Wall-clock elapsed is ${String(c.totalSeconds)} s but the process ` +
    `only ran for ${String(c.uninterrupted.seconds)} s of it. Every rate, drift and per-hour figure derived ` +
    `from the full span is wrong; use the uninterrupted window or re-run on a host that will not sleep.`
  );
}
