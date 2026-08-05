import { Camera } from 'lucide-react';
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
import { healthPresentation } from '@/features/cameras/cameraPresentation';
import { useCameras } from '@/features/cameras/useCameras';

/** Per-camera operational health. Polls every 15s. */
export function CameraHealthPanel() {
  /* ⚠️ Eight rows is what this panel shows, so eight is what it asks the server for. */
  const query = useCameras({ limit: 8 }, { refetchInterval: 15_000 });
  const cameras = query.data?.cameras ?? [];

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
                {/* Shared with the Cameras page: one map, and one place an unmapped value is
                    handled. This panel carried its own copy of it until the roadmap review. */}
                <StatusIndicator {...healthPresentation(camera.health.status)} emphasis />
              </li>
            ))}
          </ul>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
