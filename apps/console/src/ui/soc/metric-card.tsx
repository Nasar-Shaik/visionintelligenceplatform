import type { ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  /** Signed percentage or count delta; sign drives colour + arrow. */
  delta?: number;
  deltaSuffix?: string;
  /** Sparkline series (optional). */
  data?: number[];
  icon?: ReactNode;
  /** Semantic accent for the value (e.g. critical KPI). */
  tone?: 'default' | 'critical' | 'warning' | 'success';
  className?: string;
}

const TONE: Record<NonNullable<MetricCardProps['tone']>, string> = {
  default: 'text-foreground',
  critical: 'text-critical',
  warning: 'text-warning',
  success: 'text-success',
};

export function MetricCard({
  label,
  value,
  delta,
  deltaSuffix = '%',
  data,
  icon,
  tone = 'default',
  className,
}: MetricCardProps) {
  const up = (delta ?? 0) >= 0;
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-surface-1 p-4',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</p>
        {icon ? <span className="text-text-subtle">{icon}</span> : null}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <span className={cn('tabular text-3xl font-semibold leading-none', TONE[tone])}>
          {value}
        </span>
        {delta !== undefined ? (
          <span
            className={cn(
              'mb-0.5 inline-flex items-center gap-0.5 text-xs',
              up ? 'text-success' : 'text-critical',
            )}
          >
            {up ? (
              <ArrowUpRight className="size-3" aria-hidden />
            ) : (
              <ArrowDownRight className="size-3" aria-hidden />
            )}
            <span className="tabular">
              {Math.abs(delta)}
              {deltaSuffix}
            </span>
          </span>
        ) : null}
      </div>
      {data && data.length > 1 ? (
        <div className="mt-3 h-8">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data.map((v, i) => ({ i, v }))}
              margin={{ top: 2, bottom: 2, left: 0, right: 0 }}
            >
              <defs>
                <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke="var(--color-brand)"
                strokeWidth={1.5}
                fill={`url(#spark-${label})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}
    </div>
  );
}
