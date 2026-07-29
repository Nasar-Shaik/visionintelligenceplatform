import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** Shape-matched loading placeholder. Shimmer respects prefers-reduced-motion (base layer). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-md bg-surface-2', className)}
      aria-hidden
      {...props}
    >
      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-surface-3 to-transparent animate-[vip-shimmer_1.5s_infinite]" />
    </div>
  );
}
