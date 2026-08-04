import {
  Activity,
  Bell,
  Camera,
  Building2,
  HeartPulse,
  LayoutDashboard,
  MonitorPlay,
  Settings,
  ShieldAlert,
  Telescope,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Required permission (deny-by-default). Omit = visible to any authenticated user. */
  permission?: string;
  /** Exact-match active state (for the index route). */
  end?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Primary navigation, grouped by operator workflow (OPERATIONS_CONSOLE §5). Items are
 * permission-gated with the wildcard PDP: `*:read` (viewer/operator/admin) reveals the read
 * surfaces; Settings requires an admin-only grant. The gateway remains the real boundary.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Monitor',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/live', label: 'Live Monitoring', icon: MonitorPlay, permission: 'camera:read' },
      { to: '/cameras', label: 'Cameras', icon: Camera, permission: 'camera:read' },
      { to: '/locations', label: 'Locations', icon: Building2, permission: 'camera:read' },
    ],
  },
  {
    label: 'Investigate',
    items: [
      { to: '/events', label: 'Events', icon: Activity, permission: 'event:read' },
      { to: '/incidents', label: 'Incidents', icon: ShieldAlert, permission: 'incident:read' },
      /*
       * ⚠️ The workspace had a route and no way in. It sat unreachable from P-5.2 to P-5.7 —
       * discoverable only by typing a URL, which for a customer means it was not there at all.
       * The per-incident deep link on the detail sheet is the meaningful entry; this entry makes
       * the section discoverable, and the workspace's own empty states explain that an incident
       * must be chosen.
       */
      { to: '/workspace', label: 'Investigations', icon: Telescope, permission: 'incident:read' },
      /*
       * P-6.5 — **Inbox**, not "Alerts". The screen stopped being a log of what the platform sent
       * and became a queue of what somebody has to deal with, and the word in the sidebar is the
       * first thing that tells an operator which of the two it is. The route is unchanged, so every
       * existing link and runbook reference still lands.
       */
      { to: '/alerts', label: 'Inbox', icon: Bell, permission: 'notification:read' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/rules', label: 'Rules', icon: SlidersHorizontal, permission: 'rule:read' },
      /*
       * ⚠️ Gated on `user:update`, not `user:read`. Every role holds `*:read`, so `user:read` would
       * put an administration screen in a viewer's sidebar — the TD-26 wildcard hazard again. The
       * route itself stays reachable for anyone the API would answer; it is the *entry* that is
       * addressed to the people who can act.
       */
      { to: '/users', label: 'Users', icon: Users, permission: 'user:update' },
      // P-6.3 — `tenant:update`, the permission the page's one editable field actually requires.
      // It was `user:create`, which was a stand-in from when the page was a placeholder.
      { to: '/settings', label: 'Settings', icon: Settings, permission: 'tenant:update' },
    ],
  },
  {
    label: 'System',
    /*
     * P-6.4 — gated, where it previously was not. The entry was ungated while the page was a
     * placeholder; now that it reports the deployment's components and dependencies it follows the
     * route, which requires `system:inspect`. ⚠️ Leaving it open would put a link to a page that
     * always says "Not authorized" in a viewer's sidebar — the worst of both, since it advertises
     * the surface and refuses it.
     */
    /*
     * ⚠️ `/system`, not `/health`: the edge owns `/health` for the gateway's liveness probe, so a
     * console route there is unreachable in a deployment. This link pointed at it for two
     * milestones and led to `{"status":"ok"}`.
     */
    items: [
      { to: '/system', label: 'System Health', icon: HeartPulse, permission: 'system:inspect' },
    ],
  },
];
