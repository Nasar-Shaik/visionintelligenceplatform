import { useDispatch, useSelector, useStore } from 'react-redux';
import { can } from '@vip/permissions';
import type { AppDispatch, AppStore, RootState } from './store';

/** Pre-typed Redux hooks — use these instead of the plain react-redux ones. */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const useAppStore = useStore.withTypes<AppStore>();

/**
 * Deny-by-default permission gate for the UI, using the same PDP (`can`, wildcard-aware) the
 * services use — so `operator` (`*:read`) sees read surfaces, `admin` (`incident:*`) sees
 * incident actions, etc. The gateway remains the real authorization boundary.
 */
export function usePermission(permission: string): boolean {
  return useAppSelector((state) => can(state.session.permissions, permission));
}
