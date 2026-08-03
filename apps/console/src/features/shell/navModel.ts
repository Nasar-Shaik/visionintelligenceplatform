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
      { to: '/alerts', label: 'Alerts', icon: Bell, permission: 'notification:read' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/rules', label: 'Rules', icon: SlidersHorizontal, permission: 'rule:read' },
      { to: '/settings', label: 'Settings', icon: Settings, permission: 'user:create' },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/health', label: 'System Health', icon: HeartPulse }],
  },
];
