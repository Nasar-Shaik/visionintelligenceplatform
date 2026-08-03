import { Skeleton } from '@/ui/skeleton';

/**
 * The single fallback every lazily-loaded route shows while its chunk downloads.
 *
 * ⚠️ **Shape-matched, not a spinner** (DESIGN_SYSTEM v2 §11). A spinner over a blank page discards
 * the layout and makes the page jump when the chunk lands; a skeleton that matches the page chrome
 * means the only thing that changes is the content.
 */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-6" role="status" aria-label="Loading page">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96" />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
