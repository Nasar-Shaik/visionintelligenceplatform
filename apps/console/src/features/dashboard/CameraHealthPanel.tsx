import { Camera } from 'lucide-react';
import type { CameraHealthStatus } from '@vip/contracts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  QueryBoundary,
  StatusIndicator,
  TableSkeleton,
} from '@/ui';
import type { StatusKind } from '@/lib/status';
import { useCameras } from '@/features/cameras/useCameras';

const HEALTH_KIND: Record<CameraHealthStatus, StatusKind> = {
  online: 'ok',
  unhealthy: 'warn',
  offline: 'error',
  unknown: 'idle',
};

/** Per-camera operational health. Polls every 15s. */
export function CameraHealthPanel() {
  const query = useCameras({ refetchInterval: 15_000 });
  const cameras = (query.data ?? []).slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Camera health</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={cameras.length === 0}
          skeleton={<TableSkeleton rows={5} cols={2} />}
          emptyState={
            <EmptyState
              icon={Camera}
              title="No cameras registered"
              description="Register a camera to begin monitoring."
            />
          }
        >
          <ul className="divide-y divide-border">
            {cameras.map((camera) => (
              <li key={camera.id} className="flex items-center justify-between gap-2 py-2">
                <span className="truncate text-sm text-foreground">{camera.name}</span>
                <StatusIndicator
                  status={HEALTH_KIND[camera.health.status]}
                  label={camera.health.status}
                  emphasis
                />
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
