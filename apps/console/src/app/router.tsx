import { createBrowserRouter } from 'react-router-dom';
import { LoginPage } from '@/features/auth/LoginPage';
import { RequireAuth } from '@/features/auth/RequireAuth';
import { AuthedHome } from '@/routes/AuthedHome';
import { DesignSystem } from '@/routes/DesignSystem';
import { NotFound } from '@/routes/NotFound';

/**
 * Route tree (data router). Public `/login`; everything else is behind the RequireAuth guard.
 * P2-1.3 introduces the AppShell as the guarded layout route and adds the feature pages
 * (dashboard/cameras/live/analyze/events/rules/incidents/alerts/evidence/health/settings);
 * see OPERATIONS_CONSOLE.md §2.
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [{ path: '/', element: <AuthedHome /> }],
  },
  // Living design-system gallery (dev reference; every primitive + variant + state).
  { path: '/design', element: <DesignSystem /> },
  { path: '*', element: <NotFound /> },
]);
