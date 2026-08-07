import {
  FileVideo,
  MapPin,
  Activity,
  Bell,
  Camera,
  Building2,
  Cpu,
  Gauge,
  HeartPulse,
  History,
  Layers,
  Server,
  LayoutDashboard,
  MonitorPlay,
  Radar,
  Radio,
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
      /*
       * ⚠️ `stream:read`, not `event:read`. The investigation surface is served by the media
       * service and gated on the stream permissions, so navigating a user here who cannot open it
       * would show them a link straight to a 403.
       */
      { to: '/investigations', label: 'Investigations', icon: FileVideo, permission: 'stream:read' },
      /*
       * P-8 Phase 4 — object tracking. Gated on `track:read`, the permission the route requires.
       *
       * ⚠️ Filed under Investigate rather than System. The AI Runtime page next door is engineering
       * visibility into a process; this is a record of people moving through a customer's premises,
       * which is investigative work and belongs where an operator already looks for it.
       *
       * ⚠️ "Live Tracks", not "Tracking" or "Analytics". The page shows what is being followed right
       * now and configures nothing — a menu entry that sounds like a feature is a promise the
       * product has not made yet.
       */
      { to: '/tracking', label: 'Live Tracks', icon: Radar, permission: 'track:read' },
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
       * P-8 Phase 7 — Retail Loitering.
       *
       * ⚠️ "Detection Zones", not "Zones". The Location Hierarchy also has a level called a zone, and
       * a sidebar with two entries called "Zones" is the same ambiguity that made "Cameras" appear
       * twice in P-8 Phase 6 and be caught by a browser check rather than by review.
       */
      { to: '/zones', label: 'Detection Zones', icon: MapPin, permission: 'camera:read' },
      { to: '/rules/live', label: 'Rule Status', icon: Activity, permission: 'rule:read' },
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
    /*
     * P-8 Phase 6 — Camera Processing Assignment. Its own section, above System, because these are
     * an operator's controls over what the deployment analyses rather than an engineering view of
     * it. Every entry is gated on `assignment:read`, which operators and viewers hold via `*:read`
     * and `admin` holds explicitly (TD-26 — `admin` holds no `*:read`, and a resource that reaches
     * it only through the wildcard leaves the tenant's own administrator refused a page their staff
     * can see; this file has now recorded that failure three times).
     */
    label: 'AI Assignment',
    items: [
      /*
       * ⚠️ "Camera Assignment", not "Cameras". A second sidebar entry called "Cameras" is ambiguous
       * for an operator and was ambiguous for the shell test, which found two links by that name —
       * the label collision was a real navigation defect, caught by an accessibility query.
       */
      { to: '/assignment', label: 'Camera Assignment', icon: Cpu, permission: 'assignment:read' },
      {
        to: '/assignment/runtimes',
        label: 'Runtimes',
        icon: Server,
        permission: 'assignment:read',
      },
      {
        to: '/assignment/profiles',
        label: 'Profiles',
        icon: Layers,
        permission: 'assignment:read',
      },
      { to: '/assignment/capacity', label: 'Capacity', icon: Gauge, permission: 'assignment:read' },
      {
        to: '/assignment/health',
        label: 'Runtime Health',
        icon: Activity,
        permission: 'assignment:read',
      },
      { to: '/assignment/history', label: 'History', icon: History, permission: 'assignment:read' },
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
      /*
       * P-8 Phase 3 — the inference runtime's engineering view. Same gate as System Health, for the
       * same reason: deployment state, no tenant data, and `admin` holds no `*:read` (TD-26).
       *
       * ⚠️ Named "AI Runtime", not "AI" or "Analytics". The page reports what the runtime is doing;
       * it does not configure per-camera AI, which is designed and not built. A menu entry that
       * sounds like a feature is a promise the product has not made.
       */
      { to: '/system/ai-runtime', label: 'AI Runtime', icon: Cpu, permission: 'system:inspect' },
      /*
       * P-8 Phase 5 — the bridge from perception to the event platform.
       *
       * ⚠️ Its own entry rather than a section of AI Runtime, because the two fail independently:
       * the runtime can be healthy while the broker is unreachable, and an operator needs to see
       * which of the two is wrong without one page's failure hiding the other.
       */
      {
        to: '/system/event-bridge',
        label: 'Event Bridge',
        icon: Radio,
        permission: 'system:inspect',
      },
    ],
  },
];
