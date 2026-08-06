import { Gauge, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import {
  Alert,
  Card,
  TableSkeleton,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  MetricCard,
  PageHeader,
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui';
import { useAssignmentCapacity } from './useAssignment';
import { RuntimeHealthBadge, figure, utilisation } from './presentation';

/**
 * **Runtime Capacity** — how much AI the deployment can still take (P-8 Phase 6 §6, rec 6).
 *
 * ### ⚠️ The page consumes the capacity endpoint; it computes nothing
 *
 * Every number here — including *Suggested placement* — comes from `GET /assignments/capacity`,
 * which runs the same placement strategy that performs real placement. A console that summed the
 * rows itself would be a second implementation of the decision, and the two would diverge the first
 * time either changed while both kept returning something plausible.
 *
 * ### ⚠️ "No capacity declared" is not "full"
 *
 * A runtime with `maxCameras: 0` has an *undefined* utilisation, not 0% and not 100%. Dividing anyway
 * is how a dashboard ends up showing `Infinity%`, and the honest string is what an operator needs to
 * see in order to go and declare a capacity.
 */
export function RuntimeCapacityPage() {
  const canRead = usePermission('assignment:read');
  const capacity = useAssignmentCapacity();
  const forbidden = capacity.error instanceof ApiRequestError && capacity.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader title="Runtime capacity" description="How much AI this deployment can take." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Runtime capacity is available to roles holding assignment:read."
        />
      </div>
    );
  }

  const report = capacity.data;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Runtime capacity"
        description="Occupancy, headroom and where an unplaced camera would go."
      />
      <QueryBoundary
        isLoading={capacity.isLoading}
        isError={capacity.isError}
        error={capacity.error}
        skeleton={<TableSkeleton rows={4} />}
      >
        {report === undefined ? null : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <MetricCard label="Total cameras" value={String(report.totalCameras)} />
              <MetricCard label="AI enabled" value={String(report.assignedCameras)} />
              <MetricCard label="Recording only" value={String(report.idleCameras)} />
              <MetricCard
                label="Available capacity"
                /* ⚠️ `null` ⇒ nobody declared one. Not zero, which would read as "full". */
                value={
                  report.availableCapacity === null
                    ? 'Not declared'
                    : String(report.availableCapacity)
                }
              />
            </div>

            {report.limits &&
            report.limits.maxAiCameras === null &&
            report.limits.maxActiveRuntimes === null ? (
              /* ⚠️ Stated plainly. A licensing section that rendered blank would read as a limit of
                 zero to anybody who did not already know licensing is unimplemented. */
              <Alert>No licensed limits are configured on this deployment.</Alert>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Runtimes</CardTitle>
                <CardDescription>
                  Occupancy counts every tenant on a shared runtime; the state columns are yours.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {report.runtimes.length === 0 ? (
                  <EmptyState
                    icon={Gauge}
                    title="No runtimes registered"
                    description="Capacity is undefined until a runtime exists."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Runtime</TableHead>
                        <TableHead>Health</TableHead>
                        <TableHead>Assigned</TableHead>
                        <TableHead>Running</TableHead>
                        <TableHead>Paused</TableHead>
                        <TableHead>Failed</TableHead>
                        <TableHead>Utilisation</TableHead>
                        <TableHead>Remaining</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.runtimes.map((runtime) => (
                        <TableRow key={runtime.runtimeId}>
                          <TableCell>
                            <div className="font-medium">{runtime.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {runtime.runtimeId}
                            </div>
                          </TableCell>
                          <TableCell>
                            <RuntimeHealthBadge health={runtime.health} />
                          </TableCell>
                          <TableCell>
                            {runtime.assignedCameras} / {runtime.maxCameras}
                          </TableCell>
                          <TableCell>{runtime.activeCameras}</TableCell>
                          <TableCell>{runtime.pausedCameras}</TableCell>
                          <TableCell>{runtime.failedCameras}</TableCell>
                          <TableCell>{utilisation(runtime.utilization)}</TableCell>
                          <TableCell>
                            {runtime.remaining === null
                              ? 'Not declared'
                              : figure(runtime.remaining)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Suggested placement</CardTitle>
                <CardDescription>
                  Where each unplaced camera would go, computed by the same code that places them.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {report.suggestions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Every AI-enabled camera is placed on a runtime.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Camera</TableHead>
                        <TableHead>Would be placed on</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.suggestions.map((suggestion) => (
                        <TableRow key={suggestion.cameraId}>
                          <TableCell className="font-mono text-xs">{suggestion.cameraId}</TableCell>
                          <TableCell className="text-sm">
                            {suggestion.runtimeId ?? `Nowhere — ${suggestion.failure ?? 'unknown'}`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}
