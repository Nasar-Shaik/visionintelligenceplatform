import type { HTMLAttributes } from 'react';
import type { EventPriority } from '@vip/contracts';
import { cn } from '@/lib/cn';
import { severityTokens } from '@/lib/severity';

/**
 * Severity chip driven by the contract `EventPriority`. Static class maps per severity
 * (dot + text + chip bg/border) so Tailwind emits them. Colour + label together (a11y).
 */
const CHIP: Record<EventPriority, string> = {
  critical: 'border-sev-critical/40 bg-sev-critical/15 text-sev-critical',
  high: 'border-sev-high/40 bg-sev-high/15 text-sev-high',
  medium: 'border-sev-medium/40 bg-sev-medium/15 text-sev-medium',
  low: 'border-sev-low/40 bg-sev-low/15 text-sev-low',
  info: 'border-sev-info/40 bg-sev-info/15 text-sev-info',
};
const DOT: Record<EventPriority, string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  info: 'bg-sev-info',
};

export interface SeverityBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  severity: EventPriority;
  /** Render a leading dot instead of the filled chip (for dense tables). */
  dot?: boolean;
}

export function SeverityBadge({ severity, dot = false, className, ...props }: SeverityBadgeProps) {
  const { label } = severityTokens(severity);
  if (dot) {
    return (
      <span
        className={cn('inline-flex items-center gap-1.5 text-xs text-foreground', className)}
        {...props}
      >
        <span className={cn('size-2 rounded-full', DOT[severity])} />
        {label}
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
        CHIP[severity],
        className,
      )}
      {...props}
    >
      <span className={cn('size-1.5 rounded-full', DOT[severity])} />
      {label}
    </span>
  );
}

/** Left-border severity accent for cards/rows (returns the border class). */
export const SEVERITY_BORDER: Record<EventPriority, string> = {
  critical: 'border-l-sev-critical',
  high: 'border-l-sev-high',
  medium: 'border-l-sev-medium',
  low: 'border-l-sev-low',
  info: 'border-l-sev-info',
};
