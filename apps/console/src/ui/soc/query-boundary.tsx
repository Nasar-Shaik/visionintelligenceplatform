import type { ReactNode } from 'react';
import { CircleSlash } from 'lucide-react';
import { Alert } from '@/ui/alert';
import { ApiRequestError } from '@/lib/api/http';

export interface QueryBoundaryProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  isEmpty?: boolean;
  /**
   * ⚠️ **The fourth state** (P-5.2, DESIGN_SYSTEM v2 §11). Set when *nobody could look*: no
   * producer exists, the deployment has not configured it, the upstream timed out, or the principal
   * lacks the permission.
   *
   * It takes priority over every other state, including loading — an unavailable surface is not
   * fetched at all. Rendering it as Empty would assert "there is nothing here", which is a different
   * and false claim from "nothing has produced this", and it is the claim that puts "no AI
   * recommendations" on an incident no model has ever looked at.
   */
  unavailableReason?: string | undefined;
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
 * The state a surface renders when it could not be consulted.
 *
 * Visually distinct from `EmptyState` on purpose: muted, bordered and dashed, so an operator can
 * tell at a glance that the absence is the platform's, not the data's.
 */
export function UnavailableState({ reason }: { reason: string }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-4 py-8 text-center"
    >
      <CircleSlash className="size-5 text-text-subtle" aria-hidden />
      <p className="text-xs font-medium text-text-muted">Not available</p>
      <p className="max-w-prose text-xs text-text-subtle">{reason}</p>
    </div>
  );
}

/**
 * Standard **unavailable → loading → error → empty → content** flow for a TanStack Query result.
 * Every data surface uses this so the states look consistent, and — since P-5.2 — so that "we could
 * not look" is never rendered as "there is nothing".
 */
export function QueryBoundary({
  isLoading,
  isError,
  error,
  isEmpty = false,
  unavailableReason,
  skeleton,
  emptyState = null,
  children,
}: QueryBoundaryProps) {
  if (unavailableReason !== undefined) return <UnavailableState reason={unavailableReason} />;
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
