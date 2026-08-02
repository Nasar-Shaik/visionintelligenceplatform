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
