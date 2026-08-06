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
const CameraDetailPage = lazy(() =>
  import('@/features/cameras/CameraDetailPage').then((m) => ({ default: m.CameraDetailPage })),
);
const LocationsPage = lazy(() =>
  import('@/features/organization/LocationsPage').then((m) => ({ default: m.LocationsPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/organization/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const UsersPage = lazy(() =>
  import('@/features/users/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const SystemHealthPage = lazy(() =>
  import('@/features/system/SystemHealthPage').then((m) => ({ default: m.SystemHealthPage })),
);
const AiRuntimePage = lazy(() =>
  import('@/features/system/AiRuntimePage').then((m) => ({ default: m.AiRuntimePage })),
);
const EventBridgePage = lazy(() =>
  import('@/features/system/EventBridgePage').then((m) => ({ default: m.EventBridgePage })),
);
/*
 * P-8 Phase 6 — Camera Processing Assignment. Six pages, lazily loaded like every other feature:
 * an operator who never assigns AI never downloads the control plane's UI.
 */
const CameraAssignmentPage = lazy(() =>
  import('@/features/assignment/CameraAssignmentPage').then((m) => ({
    default: m.CameraAssignmentPage,
  })),
);
const RuntimeAssignmentPage = lazy(() =>
  import('@/features/assignment/RuntimeAssignmentPage').then((m) => ({
    default: m.RuntimeAssignmentPage,
  })),
);
const ProcessingProfilesPage = lazy(() =>
  import('@/features/assignment/ProcessingProfilesPage').then((m) => ({
    default: m.ProcessingProfilesPage,
  })),
);
const RuntimeCapacityPage = lazy(() =>
  import('@/features/assignment/RuntimeCapacityPage').then((m) => ({
    default: m.RuntimeCapacityPage,
  })),
);
const RuntimeHealthPage = lazy(() =>
  import('@/features/assignment/RuntimeHealthPage').then((m) => ({ default: m.RuntimeHealthPage })),
);
const AssignmentHistoryPage = lazy(() =>
  import('@/features/assignment/AssignmentHistoryPage').then((m) => ({
    default: m.AssignmentHistoryPage,
  })),
);
const LiveTracksPage = lazy(() =>
  import('@/features/tracking/LiveTracksPage').then((m) => ({ default: m.LiveTracksPage })),
);
const TrackDetailPage = lazy(() =>
  import('@/features/tracking/TrackDetailPage').then((m) => ({ default: m.TrackDetailPage })),
);
const TrackTimelinePage = lazy(() =>
  import('@/features/tracking/TrackTimelinePage').then((m) => ({ default: m.TrackTimelinePage })),
);
const TrackStatisticsPage = lazy(() =>
  import('@/features/tracking/TrackStatisticsPage').then((m) => ({
    default: m.TrackStatisticsPage,
  })),
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
          /* P-6.6 — a camera has an address, so it can be linked to, refreshed and gone back from. */
          { path: 'cameras/:id', element: route(<CameraDetailPage />) },
          { path: 'locations', element: route(<LocationsPage />) },
          { path: 'events', element: route(<EventsPage />) },
          /*
           * P-8 Phase 4 — object tracking, read-only.
           *
           * ⚠️ `/tracking/statistics` is declared BEFORE `/tracking/:trackId`. React Router matches
           * static segments ahead of dynamic ones so the order is not load-bearing here — but the
           * ordering is kept explicit because the failure it prevents is silent: a statistics page
           * that renders "no such track" and nothing else.
           */
          { path: 'tracking', element: route(<LiveTracksPage />) },
          { path: 'tracking/statistics', element: route(<TrackStatisticsPage />) },
          { path: 'tracking/:trackId', element: route(<TrackDetailPage />) },
          { path: 'tracking/:trackId/timeline', element: route(<TrackTimelinePage />) },
          { path: 'incidents', element: route(<IncidentsPage />) },
          // P-5.2 — the Investigation Workspace. `/workspace/:incidentId` is the deep link an
          // alert, a report or a colleague's message points at.
          { path: 'workspace', element: route(<InvestigationWorkspace />) },
          { path: 'workspace/:incidentId', element: route(<InvestigationWorkspace />) },
          { path: 'alerts', element: route(<AlertsPage />) },
          { path: 'rules', element: route(<RulesListPage />) },
          { path: 'rules/new', element: route(<RuleEditorPage />) },
          { path: 'rules/:id', element: route(<RuleEditorPage />) },
          // P-6.2 — user administration. The route is open to anyone the API would serve
          // (`user:read`); the actions inside it are gated on `user:update` individually.
          { path: 'users', element: route(<UsersPage />) },
          /*
           * P-6.4 — system health, at `/system` and ⚠️ **not** at `/health`.
           *
           * The edge routes `/health` to the gateway's **liveness probe**, deliberately and with a
           * comment explaining why (an uptime monitor pointed at the obvious URL must not get the
           * SPA fallback and a cheerful 200). So a console route at `/health` is unreachable in any
           * real deployment: the browser is handed `{"status":"ok"}` and never reaches the bundle.
           *
           * The probe keeps the path. Renaming something a customer's alerting already points at,
           * to make room for a page, is the wrong way round — and ⚠️ **no redirect is possible**,
           * because the request never arrives at the SPA to be redirected.
           *
           * Found by deploying. The placeholder that lived here was equally unreachable, and
           * `verify.mjs` reported the route as rendering for two milestones because JSON logs no
           * errors and shows no crash boundary.
           */
          { path: 'system', element: route(<SystemHealthPage />) },
          // P-8 Phase 3 — engineering + deployment visibility for the inference runtime. Same
          // permission as System Health (`system:inspect`); the runtime itself stays off the
          // gateway, so this page is served through media.
          { path: 'system/ai-runtime', element: route(<AiRuntimePage />) },
          { path: 'system/event-bridge', element: route(<EventBridgePage />) },
          /*
           * P-8 Phase 6 — Camera Processing Assignment.
           *
           * ⚠️ Its own top-level `/assignment` tree rather than a branch of `/system`. System pages
           * are engineering views gated on `system:inspect`; these are an operator's controls over
           * what the deployment analyses, gated on `assignment:read`/`write`. Filing them under
           * System would have hidden a tenant-facing feature behind an infrastructure permission.
           */
          { path: 'assignment', element: route(<CameraAssignmentPage />) },
          { path: 'assignment/runtimes', element: route(<RuntimeAssignmentPage />) },
          { path: 'assignment/profiles', element: route(<ProcessingProfilesPage />) },
          { path: 'assignment/capacity', element: route(<RuntimeCapacityPage />) },
          { path: 'assignment/health', element: route(<RuntimeHealthPage />) },
          { path: 'assignment/history', element: route(<AssignmentHistoryPage />) },
          // P-6.3 — tenant settings. Was a placeholder; the route is unchanged so every existing
          // link, bookmark and runbook reference still lands somewhere real.
          { path: 'settings', element: route(<SettingsPage />) },
        ],
      },
    ],
  },
  // Living design-system gallery (dev reference; every primitive + variant + state).
  { path: '/design', element: route(<DesignSystem />) },
  { path: '*', element: <NotFound /> },
]);
