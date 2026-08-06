import { History, ShieldAlert } from 'lucide-react';
import type { AssignmentSnapshot } from '@vip/contracts';
import { ApiRequestError } from '@/lib/api/http';
import { usePermission } from '@/app/hooks';
import { formatTimestamp } from '@/lib/format';
import {
  Badge,
  Card,
  TableSkeleton,
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
import { useAssignmentHistory } from './useAssignment';

/**
 * **Assignment History** — the immutable audit trail (P-8 Phase 6 §6, rec 4).
 *
 * ### ⚠️ Whole snapshots, not a diff
 *
 * Each row shows what the assignment was and what it became. A diff is only interpretable against the
 * document it was taken from, and by the time an auditor reads this the document has moved on —
 * the same reasoning that made the camera probe archive immutable.
 *
 * ### ⚠️ `system` is a real actor and is labelled as one
 *
 * Failover and observation entries are written by the platform, not by a person. Rendering them as a
 * blank actor would make "who disabled this camera" unanswerable exactly when the answer is
 * "nobody — its runtime died at 03:14".
 */
export function AssignmentHistoryPage() {
  const canRead = usePermission('assignment:read');
  const history = useAssignmentHistory({ limit: 100 });
  const forbidden = history.error instanceof ApiRequestError && history.error.status === 403;

  if (!canRead || forbidden) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-6">
        <PageHeader title="Assignment history" description="Every change, who made it and why." />
        <EmptyState
          icon={ShieldAlert}
          title="Not authorized"
          description="Assignment history is available to roles holding assignment:read."
        />
      </div>
    );
  }

  const rows = history.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
      <PageHeader
        title="Assignment history"
        description="Append-only. Nothing in the platform updates or deletes an entry."
      />
      <Card>
        <CardHeader>
          <CardTitle>Changes</CardTitle>
          <CardDescription>
            Newest first, with the whole assignment before and after.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            isLoading={history.isLoading}
            isError={history.isError}
            error={history.error}
            skeleton={<TableSkeleton rows={4} />}
          >
            {rows.length === 0 ? (
              <EmptyState
                icon={History}
                title="Nothing recorded yet"
                description="Assignment changes appear here as soon as one is made."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Camera</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Why</TableHead>
                    <TableHead>Before</TableHead>
                    <TableHead>After</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatTimestamp(entry.at)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{entry.cameraId}</TableCell>
                      <TableCell>
                        <Badge variant="neutral">{entry.action}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {entry.actor === 'system' ? (
                          <Badge variant="outline">platform</Badge>
                        ) : (
                          entry.actor
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.reason}
                        {entry.note ? ` · ${entry.note}` : ''}
                      </TableCell>
                      <TableCell className="text-xs">{describe(entry.before)}</TableCell>
                      <TableCell className="text-xs">{describe(entry.after)}</TableCell>
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

/** ⚠️ `null` before means "there was nothing before", which is a different fact from an empty one. */
function describe(snapshot: AssignmentSnapshot | null): string {
  if (snapshot === null) return 'first record';
  const parts: string[] = [snapshot.state];
  if (snapshot.profileId !== null) parts.push(snapshot.profileId);
  if (snapshot.runtimeId !== null) parts.push(`on ${snapshot.runtimeId}`);
  return parts.join(' · ');
}
