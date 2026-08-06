import { Server, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { timeAgo } from '@/lib/format';
import {
  Card,
  CardSkeleton,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
  QueryBoundary,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui';
import { useAssignments, useProcessingRuntimes } from './useAssignment';
import { AssignmentStateBadge, RuntimeHealthBadge, figure } from './presentation';

/**
 * **Runtime Assignment** — which cameras sit on which AI runtime (P-8 Phase 6 §6).
 *
 * ### ⚠️ Registration is declared; health is measured, and the page says which is which
 *
 * The URL, name and capacity of a runtime are what an operator typed. Its health, latency and
 * advertised capabilities are what `services/media` measured by talking to it. A runtime nobody has
 * observed reads **Not observed** — never "Healthy", which would be a claim made on the authority of
 * somebody having typed a URL.
 *
 * ### ⚠️ Cameras are grouped per runtime, tenant-scoped
 *
 * The rows under each runtime are the caller's own cameras. The runtime's *occupancy* number comes
 * from the control plane and counts every tenant, because a shared runtime's capacity is a shared
 * fact — an operator who cannot see why placement was refused cannot fix it. Counts only: no other
 * tenant's camera is ever named.
 */
export function RuntimeAssignmentPage() {
  const canRead = usePermission('assignment:read');
  const runtimes = useProcessingRuntimes();
  const assignments = useAssignments();
  const forbidden = runtimes.error instanceof ApiRequestError && runtimes.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <PageHeader title="Runtime assignment" description="Which cameras sit on which runtime." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Runtime assignment is available to roles holding assignment:read."
        />
      </div>
    );
  }

  const rows = assignments.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <PageHeader
        title="Runtime assignment"
        description="Registration is declared. Health and capabilities are measured by the enforcement point."
      />
      <QueryBoundary
        isLoading={runtimes.isLoading}
        isError={runtimes.isError}
        error={runtimes.error}
        skeleton={<CardSkeleton />}
      >
        {(runtimes.data ?? []).length === 0 ? (
          <EmptyState
            icon={Server}
            title="No runtimes registered"
            description="Register an AI runtime before assigning cameras to it."
          />
        ) : (
          <div className="space-y-4">
            {(runtimes.data ?? []).map((runtime) => {
              const mine = rows.filter((r) => r.runtimeId === runtime.id);
              return (
                <Card key={runtime.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          {runtime.name}
                          <RuntimeHealthBadge health={runtime.health} />
                        </CardTitle>
                        <CardDescription className="font-mono text-xs">
                          {runtime.url}
                        </CardDescription>
                      </div>
                      <div className="text-right text-sm">
                        <div>
                          {mine.length} of my cameras · capacity {runtime.maxCameras}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          latency {figure(runtime.latencyMs, ' ms')} ·{' '}
                          {runtime.observedAt
                            ? `observed ${timeAgo(runtime.observedAt)}`
                            : /* ⚠️ Never observed is not "observed a long time ago". */
                              'never observed'}
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                      Advertised capabilities:{' '}
                      {runtime.capabilities === null
                        ? /* ⚠️ `null` is "not read", not "none". Rendering it as an empty list would
                             tell an operator the runtime can run nothing. */
                          'not read yet'
                        : runtime.capabilities.length === 0
                          ? 'none offered'
                          : runtime.capabilities.join(', ')}
                      {runtime.detail ? ` · ${runtime.detail}` : ''}
                    </div>
                    {mine.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        None of your cameras are placed on this runtime.
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Camera</TableHead>
                            <TableHead>State</TableHead>
                            <TableHead>Profile</TableHead>
                            <TableHead>Session</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {mine.map((row) => (
                            <TableRow key={row.cameraId}>
                              <TableCell className="font-mono text-xs">{row.cameraId}</TableCell>
                              <TableCell>
                                <AssignmentStateBadge state={row.state} />
                              </TableCell>
                              <TableCell className="text-sm">{row.profileId ?? '—'}</TableCell>
                              <TableCell className="text-sm">{row.sessionEpoch}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
