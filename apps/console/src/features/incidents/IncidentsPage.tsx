import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { IncidentStatus as IncidentStatusEnum } from '@vip/contracts';
import type { IncidentStatus } from '@vip/contracts';
import { formatTimestamp, timeAgo } from '@/lib/format';
import { SEVERITY_ORDER, severityTokens } from '@/lib/severity';
import {
  Badge,
  Button,
  EmptyState,
  FilterBar,
  PageHeader,
  QueryBoundary,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SeverityBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeleton,
} from '@/ui';
import { INCIDENT_STATUS } from './status';
import { IncidentDetailSheet } from './IncidentDetailSheet';
import { useIncidentsInfinite } from './useIncidents';
import { useCameraName } from '@/features/cameras/useCameras';

/** Derived from the contract, so a lifecycle state can never exist without a filter for it (G-1). */
const STATUSES: IncidentStatus[] = IncidentStatusEnum.options;
const POLL = { refetchInterval: 20_000 };

/** Incident queue — filterable, cursor-paginated, with a lifecycle detail drawer (ack/resolve/close). */
export function IncidentsPage() {
  const cameraName = useCameraName();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const severity = params.get('severity') ?? 'all';
  const selected = params.get('selected');

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  // Server-side filters where the query supports them (status, severity).
  const query = useIncidentsInfinite(
    {
      limit: 50,
      ...(status !== 'all' ? { status: status as IncidentStatus } : {}),
      ...(severity !== 'all' ? { severity: severity as (typeof SEVERITY_ORDER)[number] } : {}),
    },
    POLL,
  );
  const incidents = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
      <PageHeader
        title="Incidents"
        description="The operator queue — acknowledge, resolve, and close raised incidents."
      />

      <FilterBar>
        <Select value={status} onValueChange={(v) => setParam('status', v)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {INCIDENT_STATUS[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(v) => setParam('severity', v)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITY_ORDER.map((s) => (
              <SelectItem key={s} value={s}>
                {severityTokens(s).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      <QueryBoundary
        isLoading={query.isPending}
        isError={query.isError}
        error={query.error}
        isEmpty={incidents.length === 0}
        skeleton={<TableSkeleton rows={8} cols={5} />}
        emptyState={
          <EmptyState
            icon={ShieldAlert}
            title="No incidents"
            description={
              status !== 'all' || severity !== 'all'
                ? 'No incidents match these filters.'
                : 'Nothing raised yet. Incidents appear here when a rule fires.'
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Camera</TableHead>
              <TableHead>Raised</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.map((incident) => (
              <TableRow
                key={incident.id}
                className="cursor-pointer"
                onClick={() => setParam('selected', incident.id)}
              >
                <TableCell>
                  <SeverityBadge severity={incident.severity} dot />
                </TableCell>
                <TableCell className="font-medium text-foreground">{incident.title}</TableCell>
                <TableCell>
                  <Badge variant={INCIDENT_STATUS[incident.status].variant}>
                    {INCIDENT_STATUS[incident.status].label}
                  </Badge>
                </TableCell>
                {/* The camera an operator recognises, not the row id. See `useCameraName`. */}
                <TableCell className="text-muted-foreground">
                  {cameraName(incident.triggeredBy.cameraId) ?? '—'}
                </TableCell>
                <TableCell
                  className="whitespace-nowrap text-muted-foreground"
                  title={formatTimestamp(incident.raisedAt)}
                >
                  {timeAgo(incident.raisedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {query.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </QueryBoundary>

      <IncidentDetailSheet incidentId={selected} onClose={() => setParam('selected', null)} />
    </div>
  );
}
