/**
 * The Investigation Workspace — the platform's flagship screen.
 *
 * ⚠️ **Nothing here hardcodes a layout.** The regions, the panels, their order, their permissions,
 * their size bounds and their availability all come from `INVESTIGATION_WORKSPACE_LAYOUT`; the
 * keyboard and the palette come from `WORKSPACE_COMMANDS`. Adding a panel is a contract edit, which
 * is what "configurable without changing business logic" has to mean if it is to stay true.
 *
 * ⚠️ **Below `md` the workspace is read-only** (DESIGN_SYSTEM v2 §20). Triaging an incident on a
 * phone at 3am is a real scenario; drawing an annotation on one is not, and offering controls that
 * cannot work is worse than not offering them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { WorkspaceRegion } from '@vip/contracts';
import { useAppSelector, useCan } from '@/app/hooks';
import { Alert, PageHeader } from '@/ui';
import { cn } from '@/lib/cn';
import { PanelFrame } from './PanelFrame';
import { EvidenceSelectionProvider } from '@/features/playback/selection';
import { CommandPalette } from './CommandPalette';
import { PANEL_BODIES, type PanelContext } from './panels';
import { PanelBoundary } from './PanelBoundary';
import { resolveLayout, viewportTier, type ViewportTier } from './layout';
import { useWorkspaceState } from './useWorkspaceState';
import { useCommands, type CommandHandlers } from './useCommands';

function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() =>
    viewportTier(typeof window === 'undefined' ? 1920 : window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setTier(viewportTier(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return tier;
}

/*
 * ⚠️ The side columns are fixed **only above `2xl`**, and the centre has no minimum below it.
 *
 * Measured on a 1024×768 tablet: `w-80` (320 px) + `min-w-[480px]` + the 240 px shell sidebar is
 * 1040 px of hard minimum inside 1024 px of viewport, so the workspace overflowed horizontally and
 * the evidence and playback panels ran off the right edge — on the form factor an operator is most
 * likely to carry. A minimum width is a promise the layout cannot always keep; below the breakpoint
 * the columns shrink instead.
 *
 * ⚠️ **That promise was moved once and it is worth saying why.** The step was on `xl` (1280 px),
 * where it enlarges *both* columns and imposes the centre minimum at the same instant:
 * 240 shell + 320 left + 480 centre + 384 right + gaps = **1448 px of hard minimum inside 1280 px**.
 * Measured at 1280 and 1440, the right column painted 24 px past its parent and 25–44 elements were
 * cut off.
 *
 * ⚠️ It survived a milestone that checked for horizontal overflow, because the check compared
 * `document.scrollWidth` with `clientWidth` — and an ancestor here is `overflow-hidden`. **A
 * container that clips its children reports no page overflow while cutting content off.** Overflow
 * must be measured on painted boxes (`getBoundingClientRect().right > clientWidth`), not on whether
 * the document scrolls.
 *
 * `2xl` (1536 px) is where the full layout actually fits: 240 + 320 + 480 + 384 + 24 = 1448.
 */
const REGION_CLASS: Record<WorkspaceRegion, string> = {
  left: 'flex w-64 flex-none flex-col gap-2 overflow-auto 2xl:w-80',
  center: 'flex min-w-0 flex-1 flex-col gap-2 overflow-hidden 2xl:min-w-[480px]',
  right: 'flex w-80 flex-none flex-col gap-2 overflow-auto 2xl:w-96',
  bottom: 'flex flex-none gap-2 overflow-auto',
};

export function InvestigationWorkspace() {
  const params = useParams<{ incidentId?: string }>();
  const can = useCan();
  const tier = useViewportTier();
  const session = useAppSelector((state) => state.session);
  const tenantId = session.tenantId ?? 'unknown';
  const principalId = session.user?.id ?? 'unknown';

  const workspace = useWorkspaceState(tenantId, principalId);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, unknown>>({});

  const incidentId = params.incidentId ?? workspace.state.view.currentIncidentId;

  /* A deep link is an intent to open a tab — the same act as clicking the queue. */
  useEffect(() => {
    if (params.incidentId !== undefined) workspace.openTab(params.incidentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.incidentId]);

  const layout = useMemo(
    () => resolveLayout({ can, panelState: workspace.state.panels, tier }),
    [can, workspace.state.panels, tier],
  );

  const onSelectIncident = useCallback((id: string) => workspace.openTab(id), [workspace]);

  /*
   * ⚠️ Handlers are registered only for commands this build implements. `useCommands` filters the
   * palette to commands that have one, so an entry can never open nothing.
   */
  const handlers: CommandHandlers = useMemo(
    () => ({
      'command-palette.open': () => setPaletteOpen(true),
      'workspace.open-incident-queue': () => focusPanel('incident-queue'),
      'workspace.open-evidence': () => focusPanel('evidence-viewer'),
      'workspace.open-playback': () => focusPanel('video-playback'),
      'workspace.open-timeline': () => focusPanel('timeline'),
    }),
    [],
  );

  const commands = useCommands({ can, activeScopes: ['workspace'], handlers });

  const context: PanelContext = {
    incidentId,
    unavailableReason: undefined,
    onSelectIncident,
    filters,
    setFilters,
  };

  if (tier === 'compact') {
    return (
      <div className="flex flex-col gap-3 p-4">
        <PageHeader title="Investigation" />
        <Alert variant="info" title="Read-only on a small screen">
          The workspace needs a wider display for docking, resizing and annotation. Triage and
          review are available; investigation tools are not.
        </Alert>
      </div>
    );
  }

  return (
    /*
     * ⚠️ Session-scoped, not persisted. Which evidence item is open is not a preference worth
     * restoring: the incident may be closed, the item purged under retention, or access withdrawn —
     * and a restored id fails a fetch for reasons the operator cannot see. See `selection.tsx`.
     */
    <EvidenceSelectionProvider>
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        {/*
        ⚠️ Restoration failures are surfaced, not swallowed. An operator whose workspace quietly
        loses a tab assumes they closed it.
      */}
        {workspace.dropped.length > 0 ? (
          <Alert variant="warning" title="Some saved workspace state could not be restored">
            <ul className="list-disc pl-4">
              {workspace.dropped.map((drop) => (
                <li key={drop.path}>{drop.detail}</li>
              ))}
            </ul>
          </Alert>
        ) : null}

        <div className="flex min-h-0 flex-1 gap-2">
          {(['left', 'center', 'right'] as const).map((region) => (
            <div key={region} className={cn(REGION_CLASS[region])}>
              {layout.regions[region].map((resolved) => {
                const Body = PANEL_BODIES[resolved.panel.id];
                return (
                  <PanelFrame
                    key={resolved.panel.id}
                    panel={resolved.panel}
                    region={region}
                    collapsed={resolved.collapsed}
                    sizePx={resolved.sizePx}
                    onToggleCollapse={() =>
                      workspace.setPanelState(resolved.panel.id, {
                        collapsed: !resolved.collapsed,
                      })
                    }
                  >
                    {/*
                      ⚠️ Each panel is contained. Without this, one panel's render error unmounts
                      the whole route and the investigator gets a blank page — see `PanelBoundary`.
                    */}
                    <PanelBoundary title={resolved.panel.title}>
                      <Body {...context} unavailableReason={resolved.unavailableReason} />
                    </PanelBoundary>
                  </PanelFrame>
                );
              })}
            </div>
          ))}
        </div>

        <div className={cn(REGION_CLASS.bottom, 'h-56')}>
          {layout.regions.bottom.map((resolved) => {
            const Body = PANEL_BODIES[resolved.panel.id];
            return (
              <div key={resolved.panel.id} className="min-w-0 flex-1">
                <PanelFrame
                  panel={resolved.panel}
                  region="bottom"
                  collapsed={resolved.collapsed}
                  sizePx={resolved.sizePx}
                  onToggleCollapse={() =>
                    workspace.setPanelState(resolved.panel.id, { collapsed: !resolved.collapsed })
                  }
                >
                  <PanelBoundary title={resolved.panel.title}>
                    <Body {...context} unavailableReason={resolved.unavailableReason} />
                  </PanelBoundary>
                </PanelFrame>
              </div>
            );
          })}
        </div>

        {layout.dropped.length > 0 ? (
          <p className="text-2xs text-text-subtle">
            {layout.dropped.length} panel{layout.dropped.length === 1 ? '' : 's'} hidden for this
            window size.
          </p>
        ) : null}

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          commands={commands.available}
          onRun={commands.run}
        />
      </div>
    </EvidenceSelectionProvider>
  );
}

/** Move focus to a panel. Scrolling alone would move the eye and leave the keyboard behind. */
function focusPanel(panelId: string): void {
  const element = document.querySelector<HTMLElement>(`[data-panel="${panelId}"]`);
  element?.scrollIntoView({ block: 'nearest' });
  element?.querySelector<HTMLElement>('button, [href], input')?.focus();
}
