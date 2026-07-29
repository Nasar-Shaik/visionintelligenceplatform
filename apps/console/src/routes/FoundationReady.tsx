import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldCheck } from 'lucide-react';
import { useAppSelector } from '@/app/hooks';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/cn';

/**
 * P2-1.0 foundation splash. Confirms the app shell is wired end-to-end — Redux store,
 * TanStack Query, Router, and the design-system tokens — before feature slices land.
 * Replaced by the real AppShell + Dashboard in P2-1.3/P2-1.4.
 */
export function FoundationReady() {
  const theme = useAppSelector((state) => state.ui.theme);

  // Proves the Query provider is mounted (no network — resolves locally).
  const { data: ready } = useQuery({
    queryKey: queryKeys.health.all(),
    queryFn: async () => 'ok' as const,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-lg bg-brand-muted text-brand">
        <ShieldCheck className="size-7" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-foreground">VIP Operations Console</h1>
        <p className="text-sm text-muted-foreground">
          Foundation ready — design system, store, query client, and router are wired.
        </p>
      </div>
      <div
        className={cn(
          'inline-flex items-center gap-2 rounded-md border px-3 py-1.5',
          'bg-surface-1 text-status-ok',
        )}
      >
        <Activity className="size-4" aria-hidden />
        <span className="tabular text-xs">
          providers online · theme:{theme} · query:{ready ?? '…'}
        </span>
      </div>
    </main>
  );
}
