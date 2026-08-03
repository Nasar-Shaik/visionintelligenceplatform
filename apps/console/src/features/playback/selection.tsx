/**
 * Which evidence item the workspace is showing (P-5.5).
 *
 * ⚠️ **Deliberately not persisted, and deliberately not in `WorkspaceViewState`.** The frozen state
 * contract carries zoom, playback rate and the selected camera because those are preferences that
 * survive a reload usefully. A selected *evidence id* is not: the incident may be closed, the item
 * may be purged under retention, or the operator's access may have been withdrawn — and restoring
 * it would put an id into a fetch that then 404s or 403s on load, for reasons the operator cannot
 * see. The selection is session-scoped React state, and the panel re-defaults to the first playable
 * item each time the workspace opens.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface EvidenceSelection {
  selectedEvidenceId: string | undefined;
  select: (id: string | undefined) => void;
  /** A moment the player asked to jump to, in seconds from the session start. */
  seekTo: number | undefined;
  requestSeek: (offsetSeconds: number) => void;
}

const Context = createContext<EvidenceSelection>({
  selectedEvidenceId: undefined,
  select: () => undefined,
  seekTo: undefined,
  requestSeek: () => undefined,
});

export function EvidenceSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedEvidenceId, setSelected] = useState<string | undefined>(undefined);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);

  const value = useMemo<EvidenceSelection>(
    () => ({
      selectedEvidenceId,
      select: (id) => {
        setSelected(id);
        /* ⚠️ Clear the pending seek: a jump requested against one item must not land on another. */
        setSeekTo(undefined);
      },
      seekTo,
      /*
       * A new object identity each request, so seeking twice to the same offset still fires. A bare
       * number would be de-duplicated by React and the second jump would silently do nothing.
       */
      requestSeek: (offsetSeconds) => setSeekTo(offsetSeconds),
    }),
    [selectedEvidenceId, seekTo],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook belongs with its provider
export function useEvidenceSelection(): EvidenceSelection {
  return useContext(Context);
}
