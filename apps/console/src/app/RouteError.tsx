/**
 * The page an operator sees when a route crashes (P-5.7).
 *
 * ### ⚠️ React Router's default boundary is a developer artifact
 *
 * Without an `errorElement`, a render error inside a route is caught by React Router's built-in
 * fallback — which, in a production build, renders essentially nothing. Measured: seeding one
 * incident whose shape a page did not expect turned the entire operator queue into a **blank white
 * area** with no message, no way back, and nothing to report to support beyond "it stopped working".
 *
 * A crash is not preventable in general. Being uninformative about it is.
 *
 * ⚠️ This is deliberately **not** a retry-only screen. The two things an operator actually needs are
 * a way out (back to a page that works) and something quotable for a support ticket — the message
 * and the route. Both are shown.
 */
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';
import { Button } from '@/ui';

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : 'This page stopped working';
  const detail = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
      ? error.message
      : String(error ?? 'no further detail was reported');

  return (
    <div
      role="alert"
      data-testid="route-error"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <AlertTriangle className="size-8 text-critical" aria-hidden />
      <h1 className="text-lg font-semibold text-text">{title}</h1>
      <p className="max-w-md text-sm leading-relaxed text-text-muted">
        Something on this page failed to render. Other parts of the console are unaffected — you can
        go back and continue working.
      </p>
      {/*
        ⚠️ The message is shown verbatim. An operator who can quote it gets the problem fixed; an
        operator who can only say "it went blank" cannot.
      */}
      <p className="max-w-xl break-words rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-text-subtle">
        {String(detail)}
      </p>
      <p className="font-mono text-[11px] text-text-subtle">{window.location.pathname}</p>
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-1 size-3" aria-hidden />
          Go back
        </Button>
        <Button type="button" size="sm" onClick={() => window.location.reload()}>
          <RotateCcw className="mr-1 size-3" aria-hidden />
          Reload this page
        </Button>
      </div>
    </div>
  );
}
