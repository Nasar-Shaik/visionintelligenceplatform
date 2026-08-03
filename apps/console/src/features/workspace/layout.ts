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
  laptop: 8,
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

/** The CSS dimension a region's size applies to. Derived, never stored beside the region. */
export function sizeStyle(region: WorkspaceRegion, sizePx: number | undefined) {
  if (sizePx === undefined) return undefined;
  return regionAxis(region) === 'vertical' ? { height: sizePx } : { width: sizePx };
}
