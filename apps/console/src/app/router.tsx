import { createBrowserRouter } from 'react-router-dom';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { AppShell } from '@/features/shell/AppShell';
import { DashboardPage } from '@/routes/DashboardPage';
import { EventsPage } from '@/features/events/EventsPage';
import { RulesListPage } from '@/features/rules/RulesListPage';
import { RuleEditorPage } from '@/features/rules/RuleEditorPage';
import { PlaceholderPage } from '@/routes/PlaceholderPage';
import { DesignSystem } from '@/routes/DesignSystem';
import { NotFound } from '@/routes/NotFound';

/**
 * Route tree (data router). Public `/login`; everything else is behind RequireAuth and the
 * AppShell layout. Feature slices (P2-1.4+) replace each PlaceholderPage with the real page
 * (see OPERATIONS_CONSOLE.md §2 for the target tree).
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'live', element: <PlaceholderPage title="Live Monitoring" slice="P2-1.6" /> },
          { path: 'cameras', element: <PlaceholderPage title="Cameras" slice="P2-1.5" /> },
          { path: 'events', element: <EventsPage /> },
          { path: 'incidents', element: <PlaceholderPage title="Incidents" slice="P2-1.10" /> },
          { path: 'alerts', element: <PlaceholderPage title="Alerts" slice="P2-1.11" /> },
          { path: 'rules', element: <RulesListPage /> },
          { path: 'rules/new', element: <RuleEditorPage /> },
          { path: 'rules/:id', element: <RuleEditorPage /> },
          { path: 'health', element: <PlaceholderPage title="System Health" slice="P2-1.13" /> },
          { path: 'settings', element: <PlaceholderPage title="Settings" slice="P2-1.13" /> },
        ],
      },
    ],
  },
  // Living design-system gallery (dev reference; every primitive + variant + state).
  { path: '/design', element: <DesignSystem /> },
  { path: '*', element: <NotFound /> },
]);
