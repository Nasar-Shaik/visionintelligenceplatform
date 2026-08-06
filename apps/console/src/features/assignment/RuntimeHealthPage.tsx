import { Activity, ShieldAlert } from 'lucide-react';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { formatTimestamp, timeAgo } from '@/lib/format';
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
import { useAssignmentGate, useProcessingRuntimes } from './useAssignment';
import { RuntimeHealthBadge, figure } from './presentation';

/**
 * **Runtime Health** — whether the AI runtimes are working, and whether the plan reached them
 * (P-8 Phase 6 §6).
 *
 * ### ⚠️ Two things fail independently and the page shows both
 *
 * A runtime can be perfectly healthy while the enforcement point has not picked up the plan, and the
 * enforcement point can be cycling happily against a runtime that is refusing frames. One combined
 * "AI is up" light would hide whichever of the two is wrong.
 *
 * ### ⚠️ Plan version is the number that answers "did my change land"
 *
 * The control plane's version and the version media reports having applied are shown as one figure
 * with its own label, because a gap between them is the only visible symptom of a control plane
 * whose decisions are not reaching the data plane.
 *
 * ⚠️ Before the first poll it is **Not measured**, never 0 — plan version 0 is a real version
 * (a deployment where nothing has ever been assigned), so a zero here would be indistinguishable
 * from the truth.
 */
export function RuntimeHealthPage() {
  const canRead = usePermission('assignment:read');
  const canInspect = usePermission('system:inspect');
  const runtimes = useProcessingRuntimes();
  const gate = useAssignmentGate();
  const forbidden = runtimes.error instanceof ApiRequestError && runtimes.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-6">
        <PageHeader title="Runtime health" description="Whether the AI runtimes are working." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Runtime health is available to roles holding assignment:read."
        />
      </div>
    );
  }

  const stats = gate.data;
  const gateOff = stats !== undefined && stats.enabled === false;

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
      <PageHeader
        title="Runtime health"
        description="Measured by the enforcement point — the process that actually sends frames."
      />

      {gateOff ? (
        /*
         * ⚠️ A first-class answer. A deployment with the gate off analyses every camera, which is
         * valid — and rendering zeroes for it would look identical to "the control plane is
         * unreachable and nothing is assigned".
         */
        <Alert>
          {stats?.detail ?? 'Camera processing assignment is not enabled in this deployment.'} Every
          camera is analysed.
        </Alert>
      ) : null}

      {canInspect && !gateOff ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Plan version applied"
            value={
              stats?.planVersion === null || stats?.planVersion === undefined
                ? 'Not measured'
                : String(stats.planVersion)
            }
          />
          <MetricCard label="Planned cameras" value={figure(stats?.plannedCameras ?? null)} />
          <MetricCard label="Cycles" value={figure(stats?.cycles ?? null)} />
          <MetricCard label="Cycle failures" value={figure(stats?.failures ?? null)} />
        </div>
      ) : null}

      {stats?.lastError ? (
        <Alert>
          Last control-plane error: {stats.lastError}
          {stats.lastPlanAt ? ` · last plan ${timeAgo(stats.lastPlanAt)}` : ''}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Runtimes</CardTitle>
          <CardDescription>
            A runtime nobody has observed reads &quot;Not observed&quot; — never healthy.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={runtimes.isLoading}
            isError={runtimes.isError}
            error={runtimes.error}
            skeleton={<TableSkeleton rows={4} />}
          >
            {(runtimes.data ?? []).length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No runtimes registered"
                description="Nothing to measure until a runtime exists."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>Latency</TableHead>
                    <TableHead>Observed</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(runtimes.data ?? []).map((runtime) => (
                    <TableRow key={runtime.id}>
                      <TableCell>
                        <div className="font-medium">{runtime.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{runtime.url}</div>
                      </TableCell>
                      <TableCell>
                        <RuntimeHealthBadge health={runtime.health} />
                      </TableCell>
                      <TableCell className="text-sm">
                        {/* ⚠️ Unreachable ⇒ no latency. A timeout is not a slow round trip. */}
                        {figure(runtime.latencyMs, ' ms')}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {runtime.observedAt
                          ? formatTimestamp(runtime.observedAt)
                          : 'Never observed'}
                      </TableCell>
                      <TableCell className="text-xs">{runtime.observedBy ?? '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {runtime.detail ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>
    </div>
  );
}
