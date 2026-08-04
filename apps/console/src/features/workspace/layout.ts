/**
 * The layout engine: turns the **frozen registry** into what this operator actually sees.
 *
 * `INVESTIGATION_WORKSPACE_LAYOUT` is a contract in `@vip/contracts`, asserted by a test there. This
 * module never re-states it — it filters and orders it. Three inputs decide the result:
 *
 *   1. **Permissions.** A panel whose permission the principal lacks is **omitted, not disabled**.
 *      A greyed-out "AI Recommendations" tells a viewer exactly which capabilities exist and who
 *      holds them; an absent panel tells them nothing.
 *   2. **Persisted state.** Sizes, collapse and hidden flags, clamped back into the registry's own
 *      bounds — a stored size from an older build must never escape the current `minSizePx`.
 *   3. **Viewport.** Panels drop in **descending `priority`**, and a non-hideable panel never drops.
 *
 * ⚠️ Nothing here hardcodes a panel. Adding one to the registry adds it to the workspace, which is
 * what "the layout must be configurable without changing business logic" has to mean in practice.
 */
import {
  INVESTIGATION_WORKSPACE_LAYOUT,
  regionAxis,
  type WorkspacePanel,
  type WorkspacePanelId,
  type WorkspacePanelState,
  type WorkspaceRegion,
} from '@vip/contracts';

/** A panel resolved for rendering: the registry entry plus this operator's applied state. */
export interface ResolvedPanel {
  panel: WorkspacePanel;
  collapsed: boolean;
  /** Size along the region's axis, already clamped to the registry's bounds. */
  sizePx: number | undefined;
  /** ⚠️ Set when the panel cannot answer — rendered as the fourth state, never as Empty. */
  unavailableReason: string | undefined;
}

export interface ResolvedLayout {
  regions: Record<WorkspaceRegion, ResolvedPanel[]>;
  /** Panels dropped for viewport width, so the UI can offer them in an overflow menu. */
  dropped: WorkspacePanelId[];
}

/**
 * Viewport tiers, matching DESIGN_SYSTEM v2 §20. Below `md` the workspace is read-only and the
 * dock grid is not used at all, so it is not a tier here.
 */
export type ViewportTier = 'wide' | 'desktop' | 'laptop' | 'compact';

export function viewportTier(width: number): ViewportTier {
  if (width >= 1920) return 'wide';
  if (width >= 1280) return 'desktop';
  if (width >= 1024) return 'laptop';
  return 'compact';
}

/**
 * How many panels a tier can carry before priority starts dropping them. Deliberately generous —
 * dropping a panel is a last resort, after collapsing and tabbing.
 */
const CAPACITY: Record<ViewportTier, number> = {
  wide: 99,
  desktop: 12,
  /*
   * ⚠️ 10, not 8. Measured in P-5.9 on a 1024×768 tablet — the standard control-room iPad: the
   * eight rendered panels occupied 430 px of the 712 px available below the top bar, leaving ~280 px
   * of empty space while the footer reported **nine panels hidden**. Panels carry declared heights,
   * so the space does not get absorbed; it just sits there. Two more panels fit in the room that
   * was already visibly free.
   *
   * Still a cap, not a removal: dropping remains a last resort after collapsing and tabbing, and
   * the footer keeps saying exactly how many were dropped. Tuned against a measurement rather than
   * raised until it looked full.
   */
  laptop: 10,
  compact: 5,
};

function clamp(value: number, panel: WorkspacePanel): number {
  const min = panel.minSizePx ?? 0;
  const max = panel.maxSizePx ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(value, min), max);
}

export interface ResolveLayoutInput {
  /** Concrete permissions the principal holds, already expanded from their roles. */
  can: (permission: string) => boolean;
  /** Persisted per-panel presentation, if any. */
  panelState?: readonly WorkspacePanelState[] | undefined;
  tier: ViewportTier;
}

/**
 * Resolve the layout for one operator on one viewport.
 *
 * ⚠️ Pure. The workspace's arrangement is a *derivation* from the registry, not stored alongside it
 * — the same discipline as every other derived view on this platform (CONSTRAINTS §46). Two
 * components asking for the layout can never disagree, because there is nothing to disagree about.
 */
export function resolveLayout(input: ResolveLayoutInput): ResolvedLayout {
  const stateById = new Map(input.panelState?.map((state) => [state.panelId, state]) ?? []);

  const visible = INVESTIGATION_WORKSPACE_LAYOUT.panels
    .filter((panel) => input.can(panel.permission))
    .filter((panel) => {
      const state = stateById.get(panel.id);
      /* A hidden flag on a non-hideable panel is stale state, not an instruction. */
      return !(state?.hidden === true && panel.hideable);
    });

  /*
   * Drop by priority when the viewport cannot carry them all. Non-hideable panels are never
   * candidates — which the contract already guarantees by capping their priority at 20.
   */
  const capacity = CAPACITY[input.tier];
  const dropped: WorkspacePanelId[] = [];
  const kept: WorkspacePanel[] = [];
  const byPriority = [...visible].sort((a, b) => a.priority - b.priority);
  for (const panel of byPriority) {
    if (kept.length < capacity || !panel.hideable) kept.push(panel);
    else dropped.push(panel.id);
  }

  const regions: Record<WorkspaceRegion, ResolvedPanel[]> = {
    left: [],
    center: [],
    right: [],
    bottom: [],
  };

  for (const panel of kept.sort((a, b) => a.order - b.order)) {
    const state = stateById.get(panel.id);
    const region = state?.region ?? panel.region;
    const stored = state?.sizePx ?? panel.defaultSizePx;
    regions[region].push({
      panel,
      collapsed: (state?.collapsed ?? false) && panel.collapsible,
      /* ⚠️ Clamped: a size stored by an older build must not escape the current bounds. */
      sizePx: stored === undefined ? undefined : clamp(stored, panel),
      unavailableReason: panel.availability === 'available' ? undefined : panel.unavailableReason,
    });
  }

  return { regions, dropped };
}

/**
 * The CSS dimension a region's size applies to. Derived, never stored beside the region.
 *
 * ⚠️ Always paired with a `max` bound, because a panel size is a **preference, not a promise**.
 * `sizePx` comes from the panel registry (or an operator's resize) and knows nothing about the
 * viewport it will be rendered into. Applied unbounded on a 1024×768 tablet — the standard
 * control-room iPad — a panel wider than its 256 px region overflowed it and the incident queue
 * rendered titles as "Suspected concealment — Elec": hard-clipped mid-word, with no ellipsis,
 * because the text never reached a box small enough to trigger one.
 *
 * Clamping here rather than at every call site means a stored size can never exceed the space that
 * actually exists, on any viewport, for any panel.
 */
export function sizeStyle(region: WorkspaceRegion, sizePx: number | undefined) {
  if (sizePx === undefined) return undefined;
  return regionAxis(region) === 'vertical'
    ? { height: sizePx, maxHeight: '100%' }
    : { width: sizePx, maxWidth: '100%' };
}
