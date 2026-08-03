import { lazy, Suspense, type ReactElement } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { LoginPage } from '@/features/auth/LoginPage';
import { RouteError } from './RouteError';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { AppShell } from '@/features/shell/AppShell';
import { PageSkeleton } from '@/ui';
import { NotFound } from '@/routes/NotFound';

/**
 * Route tree (data router). Public `/login`; everything else is behind RequireAuth and the
 * AppShell layout.
 *
 * ### ⚠️ Every route below the shell is lazily loaded, and that was a measured fix
 *
 * P-5.3 measured the production build before touching it: **one chunk, 1.41 MB (403 kB gzip)**.
 * Every page — the rule editor, Recharts, the whole workspace — was downloaded before an operator
 * could see the login form. Nothing was wrong with the code; nothing had ever been measured.
 *
 * The shell, the login page and the auth guard stay eager: they are on the path to *every* first
 * paint, so splitting them would add a round trip to the one screen that must be instant.
 * Everything else is a `lazy()` boundary with a shape-matched skeleton — the same fallback discipline
 * the panels use (DESIGN_SYSTEM v2 §11), never a spinner over a blank page.
 */
const DashboardPage = lazy(() =>
  import('@/routes/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
const EventsPage = lazy(() =>
  import('@/features/events/EventsPage').then((m) => ({ default: m.EventsPage })),
);
const RulesListPage = lazy(() =>
  import('@/features/rules/RulesListPage').then((m) => ({ default: m.RulesListPage })),
);
const RuleEditorPage = lazy(() =>
  import('@/features/rules/RuleEditorPage').then((m) => ({ default: m.RuleEditorPage })),
);
const IncidentsPage = lazy(() =>
  import('@/features/incidents/IncidentsPage').then((m) => ({ default: m.IncidentsPage })),
);
const InvestigationWorkspace = lazy(() =>
  import('@/features/workspace/InvestigationWorkspace').then((m) => ({
    default: m.InvestigationWorkspace,
  })),
);
const AlertsPage = lazy(() =>
  import('@/features/alerts/AlertsPage').then((m) => ({ default: m.AlertsPage })),
);
const CamerasPage = lazy(() =>
  import('@/features/cameras/CamerasPage').then((m) => ({ default: m.CamerasPage })),
);
const LocationsPage = lazy(() =>
  import('@/features/organization/LocationsPage').then((m) => ({ default: m.LocationsPage })),
);
const PlaceholderPage = lazy(() =>
  import('@/routes/PlaceholderPage').then((m) => ({ default: m.PlaceholderPage })),
);
const DesignSystem = lazy(() =>
  import('@/routes/DesignSystem').then((m) => ({ default: m.DesignSystem })),
);

/** Wrap a lazy route in the shared fallback, so no route invents its own loading treatment. */
function route(element: ReactElement): ReactElement {
  return <Suspense fallback={<PageSkeleton />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    /*
     * ⚠️ Without this, React Router's built-in fallback catches a route crash and renders a blank
     * page — measured: one unexpected row shape turned the whole operator queue white, with no
     * message and no way back. See `RouteError`. It sits inside the shell so a crashed page keeps
     * its navigation.
     */
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: route(<DashboardPage />) },
          {
            path: 'live',
            element: route(<PlaceholderPage title="Live Monitoring" slice="P2-1.6" />),
          },
          { path: 'cameras', element: route(<CamerasPage />) },
          { path: 'locations', element: route(<LocationsPage />) },
          { path: 'events', element: route(<EventsPage />) },
          { path: 'incidents', element: route(<IncidentsPage />) },
          // P-5.2 — the Investigation Workspace. `/workspace/:incidentId` is the deep link an
          // alert, a report or a colleague's message points at.
          { path: 'workspace', element: route(<InvestigationWorkspace />) },
          { path: 'workspace/:incidentId', element: route(<InvestigationWorkspace />) },
          { path: 'alerts', element: route(<AlertsPage />) },
          { path: 'rules', element: route(<RulesListPage />) },
          { path: 'rules/new', element: route(<RuleEditorPage />) },
          { path: 'rules/:id', element: route(<RuleEditorPage />) },
          {
            path: 'health',
            element: route(<PlaceholderPage title="System Health" slice="P2-1.13" />),
          },
          {
            path: 'settings',
            element: route(<PlaceholderPage title="Settings" slice="P2-1.13" />),
          },
        ],
      },
    ],
  },
  // Living design-system gallery (dev reference; every primitive + variant + state).
  { path: '/design', element: route(<DesignSystem />) },
  { path: '*', element: <NotFound /> },
]);
