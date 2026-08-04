import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react';
import { can } from '@vip/permissions';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { toggleSidebar } from '@/store/uiSlice';
import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui';
import { NAV_GROUPS, type NavItem } from './navModel';
import { branding } from '@/app/branding';

function NavRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.to}
      end={item.end ?? false}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
          'focus-ring',
          collapsed && 'justify-center',
          isActive
            ? 'bg-surface-2 text-foreground'
            : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
        )
      }
    >
      <item.icon className="size-4 shrink-0" aria-hidden />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <span className="truncate">{item.label}</span>
      )}
    </NavLink>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** Collapsible primary navigation rail — permission-gated, grouped by workflow. */
export function Sidebar() {
  const brand = branding();
  const dispatch = useAppDispatch();
  const collapsed = useAppSelector((s) => s.ui.sidebarCollapsed);
  const permissions = useAppSelector((s) => s.session.permissions);

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || can(permissions, item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface-1 transition-[width] duration-150',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div
        className={cn(
          'flex h-14 items-center gap-2 border-b border-border px-3',
          collapsed && 'justify-center',
        )}
      >
        {/* ⚠️ Customer logo when supplied, the built-in mark otherwise — see `app/branding.ts`. */}
        {brand.logoUrl !== '' ? (
          <img
            src={brand.logoUrl}
            alt={brand.productName}
            className="size-8 shrink-0 rounded-md object-contain"
          />
        ) : (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand-muted text-brand">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
        )}
        {!collapsed ? (
          <span className="truncate text-sm font-semibold text-foreground">
            {brand.productName}
          </span>
        ) : null}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto p-2">
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            {!collapsed ? (
              <p className="px-2.5 pb-1 text-2xs font-medium uppercase tracking-wide text-text-subtle">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => (
              <NavRow key={item.to} item={item} collapsed={collapsed} />
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => dispatch(toggleSidebar())}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors',
            'hover:bg-surface-2 hover:text-foreground focus-ring',
            collapsed && 'justify-center',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" aria-hidden />
          ) : (
            <PanelLeftClose className="size-4" aria-hidden />
          )}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </aside>
  );
}
