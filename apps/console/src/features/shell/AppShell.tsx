import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useLiveStream } from '@/features/live/useLiveStream';

/**
 * Authenticated app layout: a fixed Topbar, a collapsible Sidebar rail, and a fluid,
 * scrollable content region (the routed page via <Outlet/>). Desktop/widescreen-first;
 * content width is unbounded on large monitors (use the wall).
 *
 * Mounts the real-time SSE feed (G-5) once for the authenticated session: it drives the
 * Topbar connection indicator and invalidates server-state caches on live pushes.
 */
export function AppShell() {
  useLiveStream();
  return (
    <div className="flex h-screen overflow-hidden bg-bg text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
