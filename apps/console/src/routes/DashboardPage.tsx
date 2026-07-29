import { Bell, Camera, ShieldAlert } from 'lucide-react';
import { MetricCard, PageHeader } from '@/ui';
import { useIncidents } from '@/features/incidents/useIncidents';
import { useCameras } from '@/features/cameras/useCameras';
import { useNotifications } from '@/features/alerts/useNotifications';
import { ActiveIncidentsPanel } from '@/features/dashboard/ActiveIncidentsPanel';
import { CameraHealthPanel } from '@/features/dashboard/CameraHealthPanel';

const POLL = { refetchInterval: 15_000 };
const ACTIVE = new Set(['raised', 'acknowledged']);

/**
 * Operations overview. Aggregates existing read APIs (incidents/cameras/notifications) into KPIs +
 * panels, polling every 15s (→ SSE via the G-5 enabler later). Queries share TanStack Query keys
 * with the panels below, so each resource is fetched once.
 */
export function DashboardPage() {
  const incidents = useIncidents({ limit: 50 }, POLL);
  const cameras = useCameras(POLL);
  const notifications = useNotifications({ limit: 50 }, POLL);

  const activeIncidents = (incidents.data?.items ?? []).filter((i) => ACTIVE.has(i.status)).length;
  const cameraList = cameras.data ?? [];
  const onlineCameras = cameraList.filter((c) => c.health.status === 'online').length;
  const alerts = notifications.data?.items.length ?? 0;

  const metric = (loading: boolean, value: string | number) => (loading ? '…' : value);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader
        title="Operations Overview"
        description="Live across your tenant · refreshes every 15s"
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard
          label="Active incidents"
          value={metric(incidents.isLoading, activeIncidents)}
          tone={activeIncidents > 0 ? 'critical' : 'default'}
          icon={<ShieldAlert className="size-4" />}
        />
        <MetricCard
          label="Cameras online"
          value={metric(cameras.isLoading, `${onlineCameras}/${cameraList.length}`)}
          tone={cameraList.length > 0 && onlineCameras < cameraList.length ? 'warning' : 'default'}
          icon={<Camera className="size-4" />}
        />
        <MetricCard
          label="Alerts (recent)"
          value={metric(notifications.isLoading, alerts)}
          icon={<Bell className="size-4" />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <ActiveIncidentsPanel />
        <CameraHealthPanel />
      </div>
    </div>
  );
}
