/**
 * Timeline scale arithmetic (P-5.5) — kept out of the component file so React Fast Refresh keeps
 * working, and so the bound below is testable without rendering anything.
 */

/**
 * Tick spacings, in seconds, from a second to a day.
 *
 * ⚠️ The renderer picks the **coarsest step that still yields fewer than `MAX_TICKS` labels**, so
 * the axis never degenerates into a grey smear and never costs an unbounded number of DOM nodes.
 * That is what keeps a day of footage as cheap to draw as a minute of it.
 */
export const TICK_STEPS = [
  1, 5, 15, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400,
] as const;

/**
 * ⚠️ **Ten, not twenty-four — measured, not guessed.**
 *
 * The first draft allowed 24 labels. Rendered at a realistic panel width (~700 px) a ten-minute
 * range picked a 30-second step, put twenty `08:02 PM` labels across the axis at ~35 px each, and
 * they overlapped into an unreadable grey smear. A time label needs roughly 70 px of clear space,
 * so the bound is the one that keeps them legible at the narrowest panel the workspace allows.
 */
export const MAX_TICKS = 10;

/** The widest spacing available — a day. Named so the fallback below needs no index assertion. */
const COARSEST_STEP = 86_400;

/** Seconds between labels at this zoom, bounded so the axis stays legible and cheap. */
export function tickStep(visibleSeconds: number): number {
  for (const step of TICK_STEPS) {
    if (visibleSeconds / step <= MAX_TICKS) return step;
  }
  /* Beyond ten days there is nothing coarser to offer; the axis thins out instead. */
  return COARSEST_STEP;
}
