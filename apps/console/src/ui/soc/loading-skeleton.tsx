import { Skeleton } from '@/ui/skeleton';
import { cn } from '@/lib/cn';

/** Shape-matched skeletons per view — table rows, KPI cards, camera tiles. */

export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2" aria-busy>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={cn('h-4', c === 0 ? 'w-1/4' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('space-y-3 rounded-lg border border-border bg-surface-1 p-4', className)}
      aria-busy
    >
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-2 w-full" />
    </div>
  );
}

export function TileSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn('aspect-video w-full rounded-lg', className)} />;
}
