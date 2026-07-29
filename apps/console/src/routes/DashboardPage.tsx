import { Bell, Camera, ShieldAlert, Video } from 'lucide-react';
import { useSession } from '@/features/auth/useAuth';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, MetricCard, PageHeader } from '@/ui';

/**
 * Operations overview. P2-1.3 ships the shell layout with honest placeholders (no fabricated
 * data); P2-1.4 wires the live metrics, active-incident panel, camera/runtime health, and
 * recent detections to the gateway.
 */
export function DashboardPage() {
  const { user } = useSession();
  const greetingName = user?.email?.split('@')[0] ?? 'operator';

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader
        title="Operations Overview"
        description={`Signed in as ${greetingName}. Live metrics arrive in P2-1.4.`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active incidents"
          value="—"
          tone="critical"
          icon={<ShieldAlert className="size-4" />}
        />
        <MetricCard label="Cameras online" value="—" icon={<Camera className="size-4" />} />
        <MetricCard label="Live streams" value="—" icon={<Video className="size-4" />} />
        <MetricCard label="Alerts (24h)" value="—" icon={<Bell className="size-4" />} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Active incidents</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={ShieldAlert}
              title="No incident feed yet"
              description="Incident data is wired in P2-1.4 (dashboard) / P2-1.10 (incidents)."
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Camera & runtime health</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={Camera}
              title="No health feed yet"
              description="Camera and inference-runtime health arrive in P2-1.4."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
