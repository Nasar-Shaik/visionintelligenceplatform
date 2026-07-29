import { createBrowserRouter } from 'react-router-dom';
import { FoundationReady } from '@/routes/FoundationReady';
import { DesignSystem } from '@/routes/DesignSystem';
import { NotFound } from '@/routes/NotFound';

/**
 * Route tree (data router). P2-1.0 ships the foundation splash only; feature slices
 * add their routes here (auth guard + AppShell layout route in P2-1.2/P2-1.3, then
 * dashboard/cameras/live/analyze/events/rules/incidents/alerts/evidence/health/settings).
 * See OPERATIONS_CONSOLE.md §2 for the target tree.
 */
export const router = createBrowserRouter([
  { path: '/', element: <FoundationReady /> },
  // Living design-system gallery (dev reference; every primitive + variant + state).
  { path: '/design', element: <DesignSystem /> },
  { path: '*', element: <NotFound /> },
]);
