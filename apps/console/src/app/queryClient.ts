import { QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '@/lib/api/http';

/**
 * TanStack Query owns all server state. Defaults tuned for an operations console:
 * short stale time (data moves), no refetch storm on window focus, and no retry on
 * 4xx (auth/permission/validation failures are not transient).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
