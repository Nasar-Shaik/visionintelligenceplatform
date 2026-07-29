import { useDispatch, useSelector, useStore } from 'react-redux';
import type { AppDispatch, AppStore, RootState } from './store';

/** Pre-typed Redux hooks — use these instead of the plain react-redux ones. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const useAppStore = useStore.withTypes<AppStore>();

/** Convenience selector for deny-by-default permission gating. */
export function usePermission(permission: string): boolean {
  return useAppSelector((state) => {
    const perms = state.session.permissions;
    if (perms.includes(permission)) return true;
    // Wildcard support: `notification:*` grants `notification:ack`.
    const [domain] = permission.split(':');
    return perms.includes('*') || perms.includes(`${domain}:*`);
  });
}
