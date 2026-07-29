import { Bell, CheckCheck, Globe, RotateCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import { StatusIndicator } from './status-indicator';
import { toStatusKind } from '@/lib/status';

export type NotificationChannelKind = 'in-app' | 'webhook';
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'acked';

const CHANNEL_ICON = {
  'in-app': Bell,
  webhook: Globe,
} as const;

export interface NotificationCardProps {
  channel: NotificationChannelKind;
  status: DeliveryStatus;
  target: string;
  at: string | number | Date;
  attempts?: number;
  className?: string;
}

/** Alert delivery row — channel icon, delivery status, target, ack/retry state. */
export function NotificationCard({
  channel,
  status,
  target,
  at,
  attempts,
  className,
}: NotificationCardProps) {
  const Icon = CHANNEL_ICON[channel];
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border bg-surface-1 p-3',
        className,
      )}
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{target}</p>
        <p className="text-xs text-text-subtle">
          {channel} · {timeAgo(at)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status === 'acked' ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCheck className="size-3.5" aria-hidden />
            Acked
          </span>
        ) : (
          <StatusIndicator status={toStatusKind(status)} label={status} emphasis />
        )}
        {attempts && attempts > 1 ? (
          <span className="inline-flex items-center gap-0.5 text-2xs text-text-subtle tabular">
            <RotateCw className="size-3" aria-hidden />
            {attempts}
          </span>
        ) : null}
      </div>
    </div>
  );
}
