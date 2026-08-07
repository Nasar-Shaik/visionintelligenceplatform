/**
 * Formatting shared across the investigation surface (P-8.6).
 *
 * ⚠️ Extracted from `InvestigationDetailPage` when the page grew a player, four timeline lanes and a
 * details panel — three of which need the same `mm:ss`. Two implementations of one offset is how a
 * timeline row and the video it seeks to end up disagreeing by a second.
 */

/** `mm:ss` from the start of the recording — the number a scrubber and an evidence clip both use. */
export function formatOffset(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const whole = Math.floor(safe);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Bytes as a human size.
 *
 * ⚠️ Binary units, matching `ANALYSIS_LIMITS.maxBytes` (2 GiB) — a customer told "up to 2 GB" who
 * then sees their 2.1 GB file refused deserves the two numbers to be on the same scale.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]!}`;
}

/** `33.28` → `33.3 s`; `3661` → `1 h 01 m 01 s`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)} h ${mm} m ${ss} s` : `${mm} m ${ss} s`;
}

/**
 * ⛔ **`null` renders as an em dash and never as `0`** (ADR-0039).
 *
 * A run that has not been measured has not been measured; "0×" and "0 fps" on screen read as
 * "stalled", which is a different and much more alarming claim than "not yet known".
 */
export function orDash(value: number | null | undefined, suffix = '', digits = 1): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(digits)}${suffix}`;
}

/**
 * A frame rate a human can read.
 *
 * ⛔ **`27.00052530204868` is a real value from a real phone**, and printing it verbatim made a
 * working analysis look broken. ffprobe reports the exact rational the container declares; almost no
 * recording device produces an integer. Two decimals are kept so a genuine **29.97** stays
 * distinguishable from **30**, which is a difference that matters when reconciling footage time.
 */
export function formatRate(fps: number): string {
  if (!Number.isFinite(fps)) return '—';
  return Number.isInteger(fps) ? String(fps) : String(Number(fps.toFixed(2)));
}
