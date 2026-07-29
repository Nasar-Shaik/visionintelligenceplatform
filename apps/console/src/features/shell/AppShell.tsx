import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';

/**
 * Authenticated app layout: a fixed Topbar, a collapsible Sidebar rail, and a fluid,
 * scrollable content region (the routed page via <Outlet/>). Desktop/widescreen-first;
 * content width is unbounded on large monitors (use the wall).
 */
export function AppShell() {
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
