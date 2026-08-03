/**
 * Panel chrome — the dock behaviour the frozen registry describes, rendered.
 *
 * ⚠️ **Collapse leaves the header visible.** A collapsed panel that vanishes is a panel the operator
 * cannot get back without already knowing it existed.
 *
 * ⚠️ **Header actions are revealed on hover but always reachable by keyboard.** Hover-only controls
 * are invisible to a keyboard user and to anyone on a touch device, which is the accessibility
 * failure that reads as "the feature is missing".
 */
import { useId, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { WorkspacePanel, WorkspaceRegion } from '@vip/contracts';
import { cn } from '@/lib/cn';
import { sizeStyle } from './layout';

export interface PanelFrameProps {
  panel: WorkspacePanel;
  region: WorkspaceRegion;
  collapsed: boolean;
  sizePx: number | undefined;
  onToggleCollapse: () => void;
  /** Rendered in the header, before the collapse control. */
  actions?: ReactNode;
  children: ReactNode;
}

export function PanelFrame({
  panel,
  region,
  collapsed,
  sizePx,
  onToggleCollapse,
  actions,
  children,
}: PanelFrameProps) {
  const bodyId = useId();
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section
      data-panel={panel.id}
      style={collapsed ? undefined : sizeStyle(region, sizePx)}
      className={cn(
        'group flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface-1',
        collapsed && 'flex-none',
        !collapsed && 'flex-1',
      )}
    >
      <header className="flex h-8 flex-none items-center gap-2 border-b border-border px-2">
        {panel.collapsible ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            className="focus-ring -ml-1 rounded p-0.5 text-text-subtle hover:text-text"
          >
            <Chevron className="size-3.5" aria-hidden />
            <span className="sr-only">
              {collapsed ? 'Expand' : 'Collapse'} {panel.title}
            </span>
          </button>
        ) : null}
        <h2 className="text-2xs font-medium uppercase tracking-wide text-text-muted">
          {panel.title}
        </h2>
        {panel.detachable ? (
          <span
            title="Can be opened on a second monitor in a later release"
            className="text-text-subtle opacity-0 transition-opacity group-hover:opacity-60 group-focus-within:opacity-60"
          >
            <ExternalLink className="size-3" aria-hidden />
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {actions}
        </div>
      </header>
      {collapsed ? null : (
        <div id={bodyId} className="min-h-0 flex-1 overflow-auto p-2">
          {children}
        </div>
      )}
    </section>
  );
}
