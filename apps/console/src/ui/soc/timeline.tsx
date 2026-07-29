import type { ReactNode } from 'react';
import type { EventPriority } from '@vip/contracts';
import { cn } from '@/lib/cn';
import { formatTimestamp, timeAgo } from '@/lib/format';

const DOT: Record<EventPriority | 'neutral', string> = {
  critical: 'bg-sev-critical',
  high: 'bg-sev-high',
  medium: 'bg-sev-medium',
  low: 'bg-sev-low',
  info: 'bg-sev-info',
  neutral: 'bg-border-strong',
};

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  at: string | number | Date;
  severity?: EventPriority;
}

export interface TimelineProps {
  items: TimelineItem[];
  className?: string;
}

/** Vertical event/lifecycle timeline (events, incident transitions, deliveries). */
export function Timeline({ items, className }: TimelineProps) {
  return (
    <ol className={cn('relative space-y-4 pl-5', className)}>
      <span className="absolute inset-y-1 left-2 w-px bg-border" aria-hidden />
      {items.map((item) => (
        <li key={item.id} className="relative">
          <span
            className={cn(
              'absolute left-2 top-1 size-2 -translate-x-1/2 rounded-full ring-2 ring-bg',
              DOT[item.severity ?? 'neutral'],
            )}
            aria-hidden
          />
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm text-foreground">{item.title}</p>
            <time
              className="tabular shrink-0 text-2xs text-text-subtle"
              dateTime={new Date(item.at).toISOString()}
              title={formatTimestamp(item.at)}
            >
              {timeAgo(item.at)}
            </time>
          </div>
          {item.description ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{item.description}</div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
