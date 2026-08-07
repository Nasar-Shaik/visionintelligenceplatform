import { cn } from '@/lib/cn';

export interface ProgressProps {
  /**
   * Completion in `[0, 1]`.
   *
   * ⛔ **`null` means "running, and how far is not known"** — rendered as an indeterminate sweep, not
   * as 0 % (ADR-0039). A bar sitting at zero tells an operator the work has stalled; a moving bar
   * with no number tells them it is alive and unmeasured, which is the truth.
   */
  value: number | null;
  label?: string;
  className?: string;
}

/**
 * A determinate or indeterminate progress bar.
 *
 * ⚠️ **Accessible by default.** Long uploads and long analyses are exactly the moments a screen
 * reader user is left guessing, so the role and its bounds are always present; the indeterminate
 * case omits `aria-valuenow`, which is what tells assistive tech "in progress, value unknown".
 */
export function Progress({ value, label, className }: ProgressProps) {
  const determinate = value !== null && Number.isFinite(value);
  const pct = determinate ? Math.min(100, Math.max(0, value * 100)) : 0;

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(determinate ? { 'aria-valuenow': Math.round(pct) } : {})}
      {...(label === undefined ? {} : { 'aria-label': label })}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div
        className={cn(
          'h-full rounded-full bg-brand transition-[width] duration-200',
          determinate ? '' : 'w-1/3 animate-indeterminate',
        )}
        {...(determinate ? { style: { width: `${String(pct)}%` } } : {})}
      />
    </div>
  );
}
