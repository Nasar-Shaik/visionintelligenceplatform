/**
 * Workspace state persistence — **a reference may be persisted; a record may not** (CONSTRAINTS
 * §66).
 *
 * Everything written here is a scalar, an enum, a number or an id. There is deliberately nowhere to
 * put a record: a cached incident title in a browser has no invalidation, no tenant check and no
 * permission check, and it renders a stale status confidently *after* the operator's access has
 * been revoked.
 *
 * ### ⚠️ Two properties that are not conveniences
 *
 * **The scope is in the key, not in a field.** `vip.workspace.state.<tenant>.<principal>` — a
 * shared control-room browser must not restore the previous shift's open incidents, and an id must
 * never cross a tenant boundary. A reader that has to remember to compare `state.tenantId` will one
 * day not; getting a key wrong returns nothing, while forgetting a field check returns someone
 * else's workspace. The field is still written, and a mismatch discards the state loudly.
 *
 * **Restore is a re-fetch.** This module returns *ids*. Resolving them is the panels' job, under
 * the current principal's permissions, and anything that fails to resolve is reported through
 * `dropped` rather than silently disappearing — an operator whose workspace quietly loses a tab
 * assumes they closed it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  WORKSPACE_STATE_SCHEMA_VERSION,
  WorkspaceUiState,
  workspaceStateKey,
  INVESTIGATION_WORKSPACE_LAYOUT,
  type WorkspacePanelId,
  type WorkspacePanelState,
  type WorkspaceStateDrop,
} from '@vip/contracts';

export interface WorkspaceStateHandle {
  state: WorkspaceUiState;
  /** ⚠️ Everything that did not survive the restore, and why. Empty means it was complete. */
  dropped: WorkspaceStateDrop[];
  setPanelState: (panelId: WorkspacePanelId, patch: Partial<WorkspacePanelState>) => void;
  setView: (patch: Partial<WorkspaceUiState['view']>) => void;
  openTab: (incidentId: string) => void;
  closeTab: (incidentId: string) => void;
  /** Report a reference the panels could not resolve, so the operator is told rather than guessing. */
  reportDropped: (drop: WorkspaceStateDrop) => void;
}

function emptyState(tenantId: string, principalId: string): WorkspaceUiState {
  return WorkspaceUiState.parse({
    schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
    tenantId,
    principalId,
    layoutVersion: INVESTIGATION_WORKSPACE_LAYOUT.version,
    updatedAt: new Date().toISOString(),
  });
}

interface Loaded {
  state: WorkspaceUiState;
  dropped: WorkspaceStateDrop[];
}

/**
 * Read and validate persisted state.
 *
 * ⚠️ Three ways it is discarded, each reported rather than silent: an incompatible schema version,
 * a tenant or principal that does not match the key we read it under, and a body that no longer
 * parses. "Coerce it into something that works" is the option that silently changes what the
 * operator is looking at.
 */
function load(tenantId: string, principalId: string): Loaded {
  const fallback = {
    state: emptyState(tenantId, principalId),
    dropped: [] as WorkspaceStateDrop[],
  };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(workspaceStateKey(tenantId, principalId));
  } catch {
    /* Private browsing, or storage disabled. An unavailable store is not an error worth surfacing. */
    return fallback;
  }
  if (raw === null) return fallback;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return {
      state: fallback.state,
      dropped: [{ path: '.', reason: 'invalid', detail: 'saved workspace state was unreadable' }],
    };
  }

  const parsed = WorkspaceUiState.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      state: fallback.state,
      dropped: [
        {
          path: '.',
          reason: 'stale-schema',
          detail: 'saved workspace state was written by an incompatible version',
        },
      ],
    };
  }
  if (parsed.data.schemaVersion !== WORKSPACE_STATE_SCHEMA_VERSION) {
    return {
      state: fallback.state,
      dropped: [
        {
          path: 'schemaVersion',
          reason: 'stale-schema',
          detail: `saved state is version ${parsed.data.schemaVersion}; this build reads ${WORKSPACE_STATE_SCHEMA_VERSION}`,
        },
      ],
    };
  }
  /*
   * ⚠️ Belt to the key's braces. The key already scopes this, so a mismatch means the stored body
   * disagrees with where it was stored — which is exactly the case where trusting either would be
   * guessing.
   */
  if (parsed.data.tenantId !== tenantId || parsed.data.principalId !== principalId) {
    return {
      state: fallback.state,
      dropped: [
        {
          path: 'tenantId',
          reason: 'wrong-tenant',
          detail: 'saved workspace state belonged to a different tenant or principal',
        },
      ],
    };
  }

  /*
   * A panel added since this was saved is simply absent from `panels` and picks up its registry
   * default — which is why the layout version is recorded but never used to discard state.
   */
  return { state: parsed.data, dropped: [] };
}

export function useWorkspaceState(tenantId: string, principalId: string): WorkspaceStateHandle {
  const initial = useMemo(() => load(tenantId, principalId), [tenantId, principalId]);
  const [state, setState] = useState<WorkspaceUiState>(initial.state);
  const [dropped, setDropped] = useState<WorkspaceStateDrop[]>(initial.dropped);

  useEffect(() => {
    setState(initial.state);
    setDropped(initial.dropped);
  }, [initial]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        workspaceStateKey(state.tenantId, state.principalId),
        JSON.stringify(state),
      );
    } catch {
      /* Storage full or unavailable — the workspace still works, it just will not be remembered. */
    }
  }, [state]);

  const setPanelState = useCallback(
    (panelId: WorkspacePanelId, patch: Partial<WorkspacePanelState>) => {
      setState((current) => {
        const panels = current.panels.filter((entry) => entry.panelId !== panelId);
        const existing = current.panels.find((entry) => entry.panelId === panelId);
        panels.push({ ...(existing ?? { panelId }), ...patch, panelId });
        return { ...current, panels, updatedAt: new Date().toISOString() };
      });
    },
    [],
  );

  const setView = useCallback((patch: Partial<WorkspaceUiState['view']>) => {
    setState((current) => ({
      ...current,
      view: { ...current.view, ...patch },
      updatedAt: new Date().toISOString(),
    }));
  }, []);

  const openTab = useCallback((incidentId: string) => {
    setState((current) => {
      if (current.tabs.some((tab) => tab.incidentId === incidentId)) {
        return { ...current, view: { ...current.view, currentIncidentId: incidentId } };
      }
      /* Bounded at the contract's 20 — an unbounded tab strip is a memory leak with a UI. */
      const tabs = [...current.tabs, { incidentId, openedAt: new Date().toISOString() }].slice(-20);
      return {
        ...current,
        tabs,
        view: { ...current.view, currentIncidentId: incidentId },
        updatedAt: new Date().toISOString(),
      };
    });
  }, []);

  const closeTab = useCallback((incidentId: string) => {
    setState((current) => {
      const tabs = current.tabs.filter((tab) => tab.incidentId !== incidentId);
      const view = { ...current.view };
      if (view.currentIncidentId === incidentId) {
        const next = tabs.at(-1)?.incidentId;
        if (next === undefined) delete view.currentIncidentId;
        else view.currentIncidentId = next;
      }
      return { ...current, tabs, view, updatedAt: new Date().toISOString() };
    });
  }, []);

  const reportDropped = useCallback((drop: WorkspaceStateDrop) => {
    setDropped((current) =>
      current.some((entry) => entry.path === drop.path) ? current : [...current, drop],
    );
  }, []);

  return { state, dropped, setPanelState, setView, openTab, closeTab, reportDropped };
}
