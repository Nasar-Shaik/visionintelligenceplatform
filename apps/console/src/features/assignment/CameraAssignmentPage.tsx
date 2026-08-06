import { useState } from 'react';
import { Cpu, ShieldAlert } from 'lucide-react';
import type { CameraAssignment } from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { timeAgo } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from '@/ui';
import {
  useAssignmentAction,
  useAssignments,
  useEnableAssignment,
  useProcessingMetrics,
  useProcessingProfiles,
} from './useAssignment';
import { AssignmentStateBadge, figure } from './presentation';
import type { CameraProcessingRow } from '@/lib/api/assignment';

/**
 * **Camera Assignment** — which cameras consume AI, and which only record (P-8 Phase 6 §6).
 *
 * ### ⚠️ Two columns from two services, and the page never conflates them
 *
 * *State* comes from the control plane: what an operator authorised. *Delivered / FPS* come from the
 * enforcement point: what media is actually doing. A camera that reads `Running` with `Not measured`
 * beside it is not a rendering bug — it is a plan media has not picked up yet, and it is the single
 * most useful thing this page can show. Showing one number derived from the other would hide it.
 *
 * ### ⚠️ Recording is never on this page, and that is the design
 *
 * There is no recording column and no recording control here, because disabling AI has nothing to do
 * with recording and a page that showed both invites the belief that it does. Stream state lives on
 * the camera pages, where it always has.
 *
 * ### ⚠️ Controls follow the permissions exactly
 *
 * Pause and resume need `assignment:control` (shift work); enable, disable and restart need
 * `assignment:write` (a compute decision). The buttons are gated the same way the routes are, so an
 * operator is never shown a control that will come back 403.
 */
export function CameraAssignmentPage() {
  const canRead = usePermission('assignment:read');
  const canWrite = usePermission('assignment:write');
  const canControl = usePermission('assignment:control');
  const [stateFilter, setStateFilter] = useState<string>('all');

  const assignments = useAssignments(stateFilter === 'all' ? {} : { state: stateFilter });
  const profiles = useProcessingProfiles();
  const metrics = useProcessingMetrics();
  const enable = useEnableAssignment();
  const act = useAssignmentAction();

  const forbidden =
    assignments.error instanceof ApiRequestError && assignments.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <PageHeader title="Camera assignment" description="Which cameras consume AI processing." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Camera assignment is available to roles holding assignment:read."
        />
      </div>
    );
  }

  /*
   * ⚠️ Measurements are indexed, never joined into the decision rows. A camera missing from this map
   * shows "Not measured" rather than vanishing from the table — the control plane knows about every
   * camera and the enforcement point only about the ones it holds.
   */
  const measured = new Map<string, CameraProcessingRow>();
  if (Array.isArray(metrics.data)) {
    for (const row of metrics.data) measured.set(row.cameraId, row);
  }

  const rows = assignments.data ?? [];
  const counts = {
    total: rows.length,
    enabled: rows.filter((r) => r.aiEnabled).length,
    running: rows.filter((r) => r.state === 'running').length,
    error: rows.filter((r) => r.state === 'error').length,
  };

  const supportedProfiles = (profiles.data ?? []).filter((p) => p.supported !== false);
  const defaultProfile = supportedProfiles[0]?.id ?? 'person-tracking';

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      toast.success(label);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : label + ' failed');
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <PageHeader
        title="Camera assignment"
        description="Every camera records. These are the ones that also consume AI."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Cameras" value={String(counts.total)} />
        <MetricCard label="AI enabled" value={String(counts.enabled)} />
        <MetricCard label="Confirmed running" value={String(counts.running)} />
        <MetricCard label="In error" value={String(counts.error)} />
      </div>

      {metrics.isError ? (
        /*
         * ⚠️ A degraded banner, not an error page. The decisions below are still correct and still
         * changeable; only the measurement is missing, and an operator during a media outage needs
         * the controls more than usual rather than less.
         */
        <Alert>
          Live processing measurements are unavailable — the enforcement point could not be reached.
          Assignments below are the control plane&apos;s record and remain accurate.
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-4">
          <div>
            <CardTitle>Assignments</CardTitle>
            <CardDescription>
              State is what was authorised. Delivered and FPS are what the enforcement point
              measured.
            </CardDescription>
          </div>
          <Select value={stateFilter} onValueChange={setStateFilter}>
            <SelectTrigger className="w-44" aria-label="Filter by state">
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="unassigned">Not assigned</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={assignments.isLoading}
            isError={assignments.isError}
            error={assignments.error}
            skeleton={<TableSkeleton rows={4} />}
          >
            {rows.length === 0 ? (
              <EmptyState
                icon={Cpu}
                title="No cameras"
                description="Onboard a camera before assigning AI processing to it."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Camera</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Runtime</TableHead>
                    <TableHead>Delivered</TableHead>
                    <TableHead>FPS</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <AssignmentRow
                      key={row.cameraId}
                      row={row}
                      measured={measured.get(row.cameraId)}
                      canWrite={canWrite}
                      canControl={canControl}
                      onEnable={() =>
                        void run('AI enabled', () =>
                          enable.mutateAsync({ cameraId: row.cameraId, profileId: defaultProfile }),
                        )
                      }
                      onAct={(action) =>
                        void run(`Camera ${action}d`, () =>
                          act.mutateAsync({ cameraId: row.cameraId, action }),
                        )
                      }
                    />
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

function AssignmentRow({
  row,
  measured,
  canWrite,
  canControl,
  onEnable,
  onAct,
}: {
  row: CameraAssignment;
  measured: CameraProcessingRow | undefined;
  canWrite: boolean;
  canControl: boolean;
  onEnable: () => void;
  onAct: (action: 'disable' | 'pause' | 'resume' | 'restart') => void;
}) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.cameraId}</TableCell>
      <TableCell>
        <div className="flex flex-col gap-1">
          <AssignmentStateBadge state={row.state} />
          {row.lastError ? <span className="text-xs text-destructive">{row.lastError}</span> : null}
          {row.observed.stale ? (
            /* ⚠️ The measurement expired. The decision is still shown; its confirmation is not. */
            <span className="text-xs text-muted-foreground">measurement expired</span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-sm">{row.profileId ?? '—'}</TableCell>
      <TableCell className="text-sm">{row.runtimeId ?? '—'}</TableCell>
      <TableCell className="text-sm">{figure(measured?.framesDelivered ?? null)}</TableCell>
      <TableCell className="text-sm">{figure(measured?.processingFps ?? null, '', 1)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{timeAgo(row.updatedAt)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          {!row.aiEnabled && canWrite ? (
            <Button size="sm" variant="outline" onClick={onEnable}>
              Enable AI
            </Button>
          ) : null}
          {row.state === 'running' && canControl ? (
            <Button size="sm" variant="outline" onClick={() => onAct('pause')}>
              Pause
            </Button>
          ) : null}
          {row.state === 'paused' && canControl ? (
            <Button size="sm" variant="outline" onClick={() => onAct('resume')}>
              Resume
            </Button>
          ) : null}
          {row.aiEnabled && canWrite ? (
            <Button size="sm" variant="outline" onClick={() => onAct('disable')}>
              Disable AI
            </Button>
          ) : null}
          {row.state === 'error' && canWrite ? (
            <Button size="sm" variant="outline" onClick={() => onAct('restart')}>
              Restart
            </Button>
          ) : null}
          {!canWrite && !canControl ? <Badge variant="outline">Read only</Badge> : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
