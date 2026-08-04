import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { statusTokens, type StatusKind } from '@/lib/status';

/**
 * Dot + label status. Never colour-only (label always present); `pulse` marks a live
 * source. Full static class names per status so Tailwind emits them (no dynamic strings).
 */
const DOT: Record<StatusKind, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  error: 'bg-status-error',
  idle: 'bg-status-idle',
};
const TEXT: Record<StatusKind, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  error: 'text-status-error',
  idle: 'text-status-idle',
};

export interface StatusIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * ⚠️ Accepts `undefined` deliberately. Callers resolve this through a `Record<DomainState, …>`
   * lookup, and a record that has fallen behind its enum — or a stored value that never belonged to
   * one — hands this component `undefined` at runtime while type-checking cleanly at the call site.
   * That happened, and it white-screened `/cameras`. See `statusTokens`.
   */
  status: StatusKind | undefined;
  label?: string;
  pulse?: boolean;
  /** Colour the label too (default: muted text, coloured dot only). */
  emphasis?: boolean;
}

export function StatusIndicator({
  status: kind,
  label,
  pulse = false,
  emphasis = false,
  className,
  ...props
}: StatusIndicatorProps) {
  /* Normalise once: an unknown kind renders as `idle` rather than throwing. */
  const status: StatusKind = kind !== undefined && kind in DOT ? kind : 'idle';
  const resolved = label ?? statusTokens(status).label;
  // Empty label => dot-only, but keep an accessible name (never colour-only, a11y §8).
  const hidden = resolved === '';
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      {...(hidden ? { role: 'img', 'aria-label': statusTokens(status).label } : {})}
      {...props}
    >
      <span className="relative flex size-2">
        {pulse ? (
          <span
            className={cn(
              'absolute inline-flex size-full rounded-full opacity-60 animate-[vip-pulse-dot_1.4s_infinite]',
              DOT[status],
            )}
          />
        ) : null}
        <span className={cn('relative inline-flex size-2 rounded-full', DOT[status])} />
      </span>
      {hidden ? null : (
        <span className={cn('text-xs', emphasis ? TEXT[status] : 'text-muted-foreground')}>
          {resolved}
        </span>
      )}
    </span>
  );
}
