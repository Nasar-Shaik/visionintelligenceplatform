import { useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import type { Incident } from '@vip/contracts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  IncidentCard,
  QueryBoundary,
  TableSkeleton,
} from '@/ui';
import { useIncidents } from '@/features/incidents/useIncidents';
import { useCameraName } from '@/features/cameras/useCameras';

const ACTIVE = new Set(['raised', 'acknowledged']);

/** Newest active (raised/acknowledged) incidents. Polls every 15s (→ SSE with G-5). */
export function ActiveIncidentsPanel() {
  const cameraName = useCameraName();
  const navigate = useNavigate();
  const query = useIncidents({ limit: 50 }, { refetchInterval: 15_000 });
  const active: Incident[] = (query.data?.items ?? [])
    .filter((i) => ACTIVE.has(i.status))
    .slice(0, 6);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Active incidents</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          isLoading={query.isLoading}
          isError={query.isError}
          error={query.error}
          isEmpty={active.length === 0}
          skeleton={<TableSkeleton rows={4} cols={3} />}
          emptyState={
            <EmptyState
              icon={ShieldAlert}
              title="No active incidents"
              description="All clear across all cameras."
            />
          }
        >
          <div className="space-y-2">
            {/* ⚠️ `cameraName` used to be handed a camera *id*. See `useCameraName`. */}
            {active.map((incident) => (
              <IncidentCard
                key={incident.id}
                title={incident.title}
                severity={incident.severity}
                status={incident.status}
                {...(incident.triggeredBy.cameraId
                  ? {
                      cameraName:
                        cameraName(incident.triggeredBy.cameraId) ?? incident.triggeredBy.cameraId,
                    }
                  : {})}
                at={incident.raisedAt}
                onClick={() => navigate(`/incidents/${incident.id}`)}
              />
            ))}
          </div>
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
