import type { ReactNode } from 'react';
import { Alert } from '@/ui/alert';
import { ApiRequestError } from '@/lib/api/http';

export interface QueryBoundaryProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  isEmpty?: boolean;
  /** Shape-matched skeleton shown while loading. */
  skeleton: ReactNode;
  /** Empty state shown when the query succeeded but returned nothing. */
  emptyState?: ReactNode;
  children: ReactNode;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.status === 403
      ? 'You don’t have permission to view this.'
      : error.message || 'Request failed.';
  }
  return 'Something went wrong loading this data.';
}

/**
 * Standard loading → error → empty → content flow for a TanStack Query result. Every data
 * surface uses this so those states look consistent (quality gate: loading/error/empty).
 */
export function QueryBoundary({
  isLoading,
  isError,
  error,
  isEmpty = false,
  skeleton,
  emptyState = null,
  children,
}: QueryBoundaryProps) {
  if (isLoading) return <>{skeleton}</>;
  if (isError)
    return (
      <Alert variant="critical" title="Couldn’t load">
        {errorMessage(error)}
      </Alert>
    );
  if (isEmpty) return <>{emptyState}</>;
  return <>{children}</>;
}
