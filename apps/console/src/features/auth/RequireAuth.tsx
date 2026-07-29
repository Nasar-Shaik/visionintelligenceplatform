import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from './useAuth';

/**
 * Route guard for the authenticated area. Redirects unauthenticated users to /login,
 * preserving the attempted location so login can return them there.
 */
export function RequireAuth() {
  const { isAuthenticated } = useSession();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
